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
  "id" | "site" | "account" | "askBeforeUse" | "lastResult"
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
}

const summary = (r: CredentialRow): SavedLogin => ({
  id: r.id,
  site: r.site,
  account: r.account,
  askBeforeUse: r.ask_before_use,
  lastResult: r.last_result,
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

function seal(vk: VaultKey, aad: string, login: { username: string; password: string }) {
  const dataKey = randomBytes(32);
  try {
    return {
      sealed: encrypt(dataKey, aad, Buffer.from(JSON.stringify(login))),
      wrapped_key: encrypt(vk.key, `wrap:${aad}`, dataKey),
      key_id: vk.id,
    };
  } finally {
    dataKey.fill(0);
  }
}

function unseal(vk: VaultKey, aad: string, row: CredentialRow) {
  if (row.key_id !== vk.id) return null;
  try {
    const dataKey = decrypt(vk.key, `wrap:${aad}`, row.wrapped_key);
    try {
      return JSON.parse(decrypt(dataKey, aad, row.sealed).toString("utf8")) as {
        username: string;
        password: string;
      };
    } finally {
      dataKey.fill(0);
    }
  } catch {
    return null;
  }
}

async function audit(
  tx: TransactionSql,
  userId: string,
  action: AuditEventRow["action"],
  site: string,
  account: string,
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
    const sealed = seal(vk, context(userId, id, input.site), input);
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
