import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { withVault, type AuditEventRow, type Sql, type TransactionSql } from "@ai-assistant/db";
import type { VaultEvent, VaultLogin } from "@ai-assistant/api-client";
import { parseTotpKey, totp, type TotpKey } from "./totp.js";

/**
 * The vault service: the only code that can open saved logins. The rest of the app, and so the
 * assistant, only ever learns that a login exists (site and account) and whether it worked. The
 * one way a password leaves here is `loginForRun`, whose caller hands it straight to Browser Use
 * for a single run, locked to the login's own site.
 *
 * Envelope encryption: each login is sealed with its own random key, and that key is sealed with
 * the master key. The master key comes from VAULT_MASTER_KEY (later: a key management service),
 * never from the database, so a copy of the database alone opens nothing.
 */

export interface VaultKey {
  id: string;
  key: Buffer;
}

/** The master key: VAULT_MASTER_KEY (32 bytes, base64), else derived from the session secret. */
export function vaultKeyFrom(masterKey: string, sessionSecret: string): VaultKey {
  let key: Buffer;
  if (masterKey) {
    key = Buffer.from(masterKey, "base64");
    if (key.length !== 32) throw new Error("VAULT_MASTER_KEY must be 32 bytes, base64-encoded");
  } else {
    key = Buffer.from(hkdfSync("sha256", sessionSecret, "ai-assistant", "vault master key v1", 32));
  }
  // The id tells which master key sealed a login, without revealing it.
  return { id: `k1-${createHash("sha256").update(key).digest("hex").slice(0, 12)}`, key };
}

/** A saved login as everyone outside the vault sees it: no username or password. */
export type SavedLogin = Pick<
  VaultLogin,
  "id" | "site" | "account" | "askBeforeUse" | "lastResult" | "hasCodeKey"
>;

interface CredentialRow {
  id: string;
  site: string;
  account: string;
  sealed: Buffer;
  wrapped_key: Buffer;
  key_id: string;
  ask_before_use: boolean;
  last_result: "worked" | "rejected" | null;
  sealed_otp: Buffer | null;
}

const summary = (r: CredentialRow): SavedLogin => ({
  id: r.id,
  site: r.site,
  account: r.account,
  askBeforeUse: r.ask_before_use,
  lastResult: r.last_result,
  hasCodeKey: !!r.sealed_otp,
});

// The sealed data is tied to its owner, row and site, so it can't be moved to another row or site.
const context = (userId: string, id: string, site: string) => `vault:v1:${userId}:${id}:${site}`;

function encrypt(key: Buffer, aad: string, plain: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]);
}

function decrypt(key: Buffer, aad: string, sealed: Buffer): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, 12));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(sealed.subarray(12, 28));
  return Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]);
}

function seal(
  vk: VaultKey,
  aad: string,
  login: { username: string; password: string },
  codeKey: TotpKey | null = null,
) {
  const dataKey = randomBytes(32);
  try {
    return {
      sealed: encrypt(dataKey, aad, Buffer.from(JSON.stringify(login))),
      sealed_otp: codeKey
        ? encrypt(dataKey, `${aad}:otp`, Buffer.from(JSON.stringify(codeKey)))
        : null,
      wrapped_key: encrypt(vk.key, `wrap:${aad}`, dataKey),
      key_id: vk.id,
    };
  } finally {
    dataKey.fill(0);
  }
}

/** Opens the login's own key for `use`, then forgets it. Null if it can't be opened. */
function withDataKey<T>(vk: VaultKey, aad: string, row: CredentialRow, use: (key: Buffer) => T) {
  if (row.key_id !== vk.id) return null;
  try {
    const dataKey = decrypt(vk.key, `wrap:${aad}`, row.wrapped_key);
    try {
      return use(dataKey);
    } finally {
      dataKey.fill(0);
    }
  } catch {
    return null;
  }
}

function unseal(vk: VaultKey, aad: string, row: CredentialRow) {
  return withDataKey(vk, aad, row, (key) => {
    const login = JSON.parse(decrypt(key, aad, row.sealed).toString("utf8")) as {
      username: string;
      password: string;
    };
    return login;
  });
}

async function audit(
  tx: TransactionSql,
  userId: string,
  action: AuditEventRow["action"],
  site: string | null,
  account: string | null,
  browserSessionId: string | null,
  detail: string | null = null,
) {
  await tx`INSERT INTO audit_events (user_id, action, site, account, detail, browser_session_id)
           VALUES (${userId}, ${action}, ${site}, ${account}, ${detail}, ${browserSessionId})`;
}

/** The login to use for a site: one that worked or hasn't been tried, newest use first. */
export async function findLogin(
  sql: Sql,
  userId: string,
  site: string,
): Promise<SavedLogin | null> {
  const [row] = await withVault(
    sql,
    userId,
    (tx) => tx<CredentialRow[]>`
      SELECT * FROM vault.credentials WHERE site = ${site}
      ORDER BY (last_result IS DISTINCT FROM 'rejected') DESC,
               greatest(last_used_at, updated_at) DESC
      LIMIT 1`,
  );
  return row ? summary(row) : null;
}

/**
 * Saves a login typed in the sign-in box. `replaceId` is the saved login the site just turned
 * down: the new one takes its place. Otherwise a login for the same site and account is updated.
 */
export async function saveLogin(
  sql: Sql,
  vk: VaultKey,
  userId: string,
  input: {
    site: string;
    username: string;
    password: string;
    loginPath: string | null;
    replaceId: string | null;
    browserSessionId: string | null;
  },
): Promise<string> {
  const account = input.username;
  return withVault(sql, userId, async (tx) => {
    const [replacing] = input.replaceId
      ? await tx<CredentialRow[]>`
          SELECT * FROM vault.credentials WHERE id = ${input.replaceId} AND site = ${input.site}`
      : await tx<CredentialRow[]>`
          SELECT * FROM vault.credentials WHERE site = ${input.site} AND account = ${account}`;
    const id = replacing?.id ?? randomUUID();
    const sealed = seal(vk, context(userId, id, input.site), {
      username: input.username,
      password: input.password,
    });
    if (replacing) {
      // Taking the place of the turned-down login can clash with another login for that account.
      if (replacing.account !== account) {
        await tx`DELETE FROM vault.credentials
                 WHERE site = ${input.site} AND account = ${account} AND id <> ${id}`;
      }
      await tx`
        UPDATE vault.credentials SET account = ${account}, login_path = ${input.loginPath},
          sealed = ${sealed.sealed}, wrapped_key = ${sealed.wrapped_key}, key_id = ${sealed.key_id},
          source = 'typed', import_batch_id = NULL, last_result = NULL, last_result_at = NULL,
          updated_at = now()
        WHERE id = ${id}`;
    } else {
      await tx`
        INSERT INTO vault.credentials (id, user_id, site, account, login_path, sealed, wrapped_key,
                                       key_id, source)
        VALUES (${id}, ${userId}, ${input.site}, ${account}, ${input.loginPath}, ${sealed.sealed},
                ${sealed.wrapped_key}, ${sealed.key_id}, 'typed')`;
    }
    await audit(
      tx,
      userId,
      replacing ? "replaced" : "saved",
      input.site,
      account,
      input.browserSessionId,
    );
    return id;
  });
}

/**
 * Opens a saved login for one browser run. Only for its own site; null if it isn't there or
 * can't be opened (for example, the master key changed). The caller passes it straight to
 * Browser Use and drops it.
 */
export async function loginForRun(
  sql: Sql,
  vk: VaultKey,
  userId: string,
  id: string,
  site: string,
  browserSessionId: string,
): Promise<{ username: string; password: string; account: string } | null> {
  return withVault(sql, userId, async (tx) => {
    const [row] = await tx<CredentialRow[]>`
      SELECT * FROM vault.credentials WHERE id = ${id} AND site = ${site}`;
    if (!row) return null;
    const login = unseal(vk, context(userId, row.id, row.site), row);
    if (!login) return null;
    await tx`UPDATE vault.credentials SET last_used_at = now() WHERE id = ${id}`;
    await audit(tx, userId, "used", row.site, row.account, browserSessionId);
    return { ...login, account: row.account };
  });
}

/** Whether the site took the login, logged without it. Called once per sign-in. */
export async function recordResult(
  sql: Sql,
  userId: string,
  id: string,
  result: "worked" | "rejected",
  browserSessionId: string,
): Promise<void> {
  await withVault(sql, userId, async (tx) => {
    const [row] = await tx<CredentialRow[]>`
      UPDATE vault.credentials SET last_result = ${result}, last_result_at = now(), last_used_at = now()
      WHERE id = ${id}
      RETURNING *`;
    if (row) await audit(tx, userId, result, row.site, row.account, browserSessionId);
  });
}

/**
 * A safety net for answers: any saved password that shows up in `texts` (for example a demo
 * password the model read off a page and also saved) is blanked out. The passwords stay in here.
 */
export async function redactSavedPasswords(
  sql: Sql,
  vk: VaultKey,
  userId: string,
  texts: string[],
): Promise<string[]> {
  if (!texts.some(Boolean)) return texts;
  const passwords = await withVault(sql, userId, async (tx) => {
    const rows = await tx<CredentialRow[]>`SELECT * FROM vault.credentials`;
    return rows
      .map((row) => unseal(vk, context(userId, row.id, row.site), row)?.password ?? "")
      .filter((p) => p.length >= 4);
  });
  // Longest first, so a password that contains another is blanked whole.
  passwords.sort((a, b) => b.length - a.length);
  return texts.map((t) => passwords.reduce((out, p) => out.split(p).join("••••••••"), t));
}

// The Vault page (Settings). Only the person, signed in, reaches these; the assistant has no
// tool that can change or delete a saved login.

export async function listLogins(sql: Sql, userId: string): Promise<VaultLogin[]> {
  const rows = await withVault(
    sql,
    userId,
    (tx) => tx<
      (CredentialRow & {
        created_at: Date;
        source: "typed" | "imported";
        manager: string | null;
        last_used_at: Date | null;
        last_result_at: Date | null;
      })[]
    >`
      SELECT c.*, b.manager FROM vault.credentials c
      LEFT JOIN vault.import_batches b ON b.id = c.import_batch_id
      ORDER BY c.site, c.account`,
  );
  return rows.map((r) => ({
    ...summary(r),
    source: r.source,
    importedFrom: r.manager,
    savedAt: r.created_at.toISOString(),
    lastUsedAt: r.last_used_at?.toISOString() ?? null,
    lastResultAt: r.last_result_at?.toISOString() ?? null,
  }));
}

/** The login itself, for its owner on the Vault page. Logged, never cached. */
export async function revealLogin(
  sql: Sql,
  vk: VaultKey,
  userId: string,
  id: string,
): Promise<{ username: string; password: string } | null> {
  return withVault(sql, userId, async (tx) => {
    const [row] = await tx<CredentialRow[]>`SELECT * FROM vault.credentials WHERE id = ${id}`;
    if (!row) return null;
    const login = unseal(vk, context(userId, row.id, row.site), row);
    if (!login) throw new Error("This saved login can't be opened. Delete it and save it again.");
    await audit(tx, userId, "viewed", row.site, row.account, null);
    return { username: login.username, password: login.password };
  });
}

/**
 * Changes a saved login's username or password from the Vault page. Its authenticator key, if
 * any, is kept. "taken" when another saved login for that site already has the new username.
 */
export async function editLogin(
  sql: Sql,
  vk: VaultKey,
  userId: string,
  id: string,
  login: { username: string; password: string },
): Promise<"ok" | "missing" | "taken"> {
  return withVault(sql, userId, async (tx) => {
    const [row] = await tx<CredentialRow[]>`
      SELECT * FROM vault.credentials WHERE id = ${id} FOR UPDATE`;
    if (!row) return "missing";
    const [other] = await tx`
      SELECT 1 FROM vault.credentials
      WHERE site = ${row.site} AND account = ${login.username} AND id <> ${id}`;
    if (other) return "taken";
    const aad = context(userId, row.id, row.site);
    const codeKey = row.sealed_otp
      ? withDataKey(
          vk,
          aad,
          row,
          (key) =>
            JSON.parse(decrypt(key, `${aad}:otp`, row.sealed_otp!).toString("utf8")) as TotpKey,
        )
      : null;
    if (row.sealed_otp && !codeKey) {
      throw new Error("This saved login can't be opened. Delete it and save it again.");
    }
    const sealed = seal(vk, aad, login, codeKey);
    await tx`
      UPDATE vault.credentials SET account = ${login.username}, sealed = ${sealed.sealed},
        sealed_otp = ${sealed.sealed_otp}, wrapped_key = ${sealed.wrapped_key},
        key_id = ${sealed.key_id}, last_result = NULL, last_result_at = NULL, updated_at = now()
      WHERE id = ${id}`;
    await audit(tx, userId, "edited", row.site, login.username, null);
    return "ok";
  });
}

export async function setAskBeforeUse(
  sql: Sql,
  userId: string,
  id: string,
  ask: boolean,
): Promise<boolean> {
  return withVault(sql, userId, async (tx) => {
    const [row] = await tx<CredentialRow[]>`
      UPDATE vault.credentials SET ask_before_use = ${ask}, updated_at = now()
      WHERE id = ${id} RETURNING *`;
    if (!row) return false;
    await audit(tx, userId, ask ? "ask_on" : "ask_off", row.site, row.account, null);
    return true;
  });
}

export async function deleteLogin(sql: Sql, userId: string, id: string): Promise<boolean> {
  return withVault(sql, userId, async (tx) => {
    const [row] = await tx<CredentialRow[]>`
      DELETE FROM vault.credentials WHERE id = ${id} RETURNING *`;
    if (!row) return false;
    await audit(tx, userId, "deleted", row.site, row.account, null);
    return true;
  });
}

export async function vaultActivity(sql: Sql, userId: string, limit = 50): Promise<VaultEvent[]> {
  const rows = await withVault(
    sql,
    userId,
    (tx) => tx<AuditEventRow[]>`
      SELECT * FROM audit_events ORDER BY created_at DESC, id LIMIT ${limit}`,
  );
  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    site: r.site,
    account: r.account,
    detail: r.detail,
    at: r.created_at.toISOString(),
  }));
}

/**
 * Saves logins from a password manager's export file. `logins` are the rows the person ticked;
 * a login already saved for the same site and account is replaced only if it was ticked too.
 */
export async function importLogins(
  sql: Sql,
  vk: VaultKey,
  userId: string,
  manager: string,
  logins: {
    site: string;
    username: string;
    password: string;
    loginPath: string | null;
    otp: string | null;
  }[],
): Promise<{ imported: number; replaced: number }> {
  return withVault(sql, userId, async (tx) => {
    const [batch] = await tx<{ id: string }[]>`
      INSERT INTO vault.import_batches (user_id, manager) VALUES (${userId}, ${manager})
      RETURNING id`;
    let imported = 0;
    let replaced = 0;
    for (const l of logins) {
      const [existing] = await tx<{ id: string }[]>`
        SELECT id FROM vault.credentials WHERE site = ${l.site} AND account = ${l.username}`;
      const id = existing?.id ?? randomUUID();
      const sealed = seal(
        vk,
        context(userId, id, l.site),
        { username: l.username, password: l.password },
        l.otp ? parseTotpKey(l.otp) : null,
      );
      if (existing) {
        await tx`
          UPDATE vault.credentials SET login_path = ${l.loginPath}, sealed = ${sealed.sealed},
            sealed_otp = ${sealed.sealed_otp},
            wrapped_key = ${sealed.wrapped_key}, key_id = ${sealed.key_id}, source = 'imported',
            import_batch_id = ${batch!.id}, last_result = NULL, last_result_at = NULL,
            updated_at = now()
          WHERE id = ${id}`;
        replaced++;
      } else {
        await tx`
          INSERT INTO vault.credentials (id, user_id, site, account, login_path, sealed, sealed_otp,
                                         wrapped_key, key_id, source, import_batch_id)
          VALUES (${id}, ${userId}, ${l.site}, ${l.username}, ${l.loginPath}, ${sealed.sealed},
                  ${sealed.sealed_otp}, ${sealed.wrapped_key}, ${sealed.key_id}, 'imported',
                  ${batch!.id})`;
        imported++;
      }
    }
    await tx`UPDATE vault.import_batches SET imported = ${imported + replaced},
               skipped = 0 WHERE id = ${batch!.id}`;
    const n = imported + replaced;
    await audit(
      tx,
      userId,
      "imported",
      null,
      null,
      null,
      `Imported ${n} login${n === 1 ? "" : "s"} from ${manager}`,
    );
    return { imported, replaced };
  });
}

/** Which of these site and account pairs already have a saved login. */
export async function existingLogins(sql: Sql, userId: string): Promise<Set<string>> {
  const rows = await withVault(
    sql,
    userId,
    (tx) => tx<{ site: string; account: string }[]>`SELECT site, account FROM vault.credentials`,
  );
  return new Set(rows.map((r) => `${r.site}\n${r.account}`));
}

// 2-step codes (V4). The authenticator key is sealed with the login's own key and never leaves
// the vault; only a code made from it does, for one run on the login's own site.

/** The saved login a sign-in used, as outsiders see it. */
export async function loginSummary(
  sql: Sql,
  userId: string,
  id: string,
): Promise<SavedLogin | null> {
  const [row] = await withVault(
    sql,
    userId,
    (tx) => tx<CredentialRow[]>`SELECT * FROM vault.credentials WHERE id = ${id}`,
  );
  return row ? summary(row) : null;
}

/**
 * Saves (or, with null, removes) a login's authenticator key. Returns false when the login isn't
 * there; throws when the text isn't an authenticator key.
 */
export async function setCodeKey(
  sql: Sql,
  vk: VaultKey,
  userId: string,
  id: string,
  raw: string | null,
): Promise<boolean> {
  const codeKey = raw === null ? null : parseTotpKey(raw);
  if (raw !== null && !codeKey) {
    throw new Error("That isn't an authenticator key. Paste the setup key or the otpauth:// link.");
  }
  return withVault(sql, userId, async (tx) => {
    const [row] = await tx<CredentialRow[]>`
      SELECT * FROM vault.credentials WHERE id = ${id} FOR UPDATE`;
    if (!row) return false;
    const aad = context(userId, row.id, row.site);
    const sealedOtp = codeKey
      ? withDataKey(vk, aad, row, (key) =>
          encrypt(key, `${aad}:otp`, Buffer.from(JSON.stringify(codeKey))),
        )
      : null;
    if (codeKey && !sealedOtp) throw new Error("This saved login can't be opened. Save it again.");
    await tx`UPDATE vault.credentials SET sealed_otp = ${sealedOtp}, updated_at = now()
             WHERE id = ${id}`;
    await audit(tx, userId, codeKey ? "code_saved" : "code_removed", row.site, row.account, null);
    return true;
  });
}

/** How far ahead the code is made: a run takes a while to start typing it. */
const CODE_LEAD_MS = 25 * 1000;

/** A 2-step code from the login's saved key, for one run on its own site. */
export async function codeForRun(
  sql: Sql,
  vk: VaultKey,
  userId: string,
  id: string,
  site: string,
  browserSessionId: string,
  now = new Date(),
): Promise<string | null> {
  return withVault(sql, userId, async (tx) => {
    const [row] = await tx<CredentialRow[]>`
      SELECT * FROM vault.credentials WHERE id = ${id} AND site = ${site}`;
    if (!row?.sealed_otp) return null;
    const aad = context(userId, row.id, row.site);
    const code = withDataKey(vk, aad, row, (key) => {
      const codeKey = JSON.parse(
        decrypt(key, `${aad}:otp`, row.sealed_otp!).toString("utf8"),
      ) as TotpKey;
      return totp(codeKey, new Date(now.getTime() + CODE_LEAD_MS));
    });
    if (!code) return null;
    await audit(tx, userId, "code_used", row.site, row.account, browserSessionId);
    return code;
  });
}

// Connected accounts ----------------------------------------------------------------------------
// Sign-in tokens for accounts the person connected (Gmail today). Sealed the same way as saved
// logins. Only the connector code that reads the account (gmail.ts) asks for the token, and it
// never reaches the assistant.

interface ConnectedRow {
  id: string;
  sealed: Buffer;
  wrapped_key: Buffer;
  key_id: string;
}

const accountContext = (userId: string, id: string, provider: string) =>
  `vault:v1:connected:${userId}:${id}:${provider}`;

/** Saves (or replaces) the refresh token for a connected account. */
export async function saveAccountToken(
  sql: Sql,
  vk: VaultKey,
  userId: string,
  provider: "gmail",
  token: string,
): Promise<void> {
  await withVault(sql, userId, async (tx) => {
    const [existing] = await tx<{ id: string }[]>`
      SELECT id FROM vault.connected_accounts WHERE provider = ${provider}`;
    const id = existing?.id ?? randomUUID();
    const dataKey = randomBytes(32);
    const aad = accountContext(userId, id, provider);
    try {
      const sealed = encrypt(dataKey, aad, Buffer.from(token, "utf8"));
      const wrapped = encrypt(vk.key, `wrap:${aad}`, dataKey);
      await tx`
        INSERT INTO vault.connected_accounts (id, user_id, provider, sealed, wrapped_key, key_id)
        VALUES (${id}, ${userId}, ${provider}, ${sealed}, ${wrapped}, ${vk.id})
        ON CONFLICT (user_id, provider) DO UPDATE
          SET sealed = EXCLUDED.sealed, wrapped_key = EXCLUDED.wrapped_key,
              key_id = EXCLUDED.key_id, updated_at = now()`;
    } finally {
      dataKey.fill(0);
    }
  });
}

/** The refresh token for a connected account, or null when there is none or it can't be opened. */
export async function accountToken(
  sql: Sql,
  vk: VaultKey,
  userId: string,
  provider: "gmail",
): Promise<string | null> {
  const [row] = await withVault(
    sql,
    userId,
    (tx) => tx<ConnectedRow[]>`
      SELECT id, sealed, wrapped_key, key_id FROM vault.connected_accounts
      WHERE provider = ${provider}`,
  );
  if (!row || row.key_id !== vk.id) return null;
  const aad = accountContext(userId, row.id, provider);
  try {
    const dataKey = decrypt(vk.key, `wrap:${aad}`, row.wrapped_key);
    try {
      return decrypt(dataKey, aad, row.sealed).toString("utf8");
    } finally {
      dataKey.fill(0);
    }
  } catch {
    return null;
  }
}

export async function deleteAccountToken(
  sql: Sql,
  userId: string,
  provider: "gmail",
): Promise<void> {
  await withVault(
    sql,
    userId,
    (tx) => tx`DELETE FROM vault.connected_accounts WHERE provider = ${provider}`,
  );
}
