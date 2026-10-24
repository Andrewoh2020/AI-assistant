import { BROWSER_INSTRUCTIONS } from "@ai-assistant/agent";
import {
  withUser,
  type BrowserSessionRow,
  type BrowserTab,
  type FileRow,
  type Sql,
} from "@ai-assistant/db";
import type { BrowserView } from "@ai-assistant/api-client";
import { openSecret, sealSecret } from "./auth.js";
import { isTerminal, type BrowserUse, type BuEvent, type SecretBinding } from "./browseruse.js";
import { MAX_FILE_BYTES, mimeFor, readFile, saveFile } from "./files.js";
import { BadRequest, Conflict, NotFound } from "./errors.js";
import { detectInjection, fence } from "./untrusted.js";
import {
  codeForRun,
  findLogin,
  loginForRun,
  loginSummary,
  recordResult,
  saveLogin,
  vaultKeyFrom,
  type VaultKey,
} from "./vault.js";

/**
 * The browse tool. One tool call is one browser session: a Browser Use run in the person's own
 * profile and workspace. It takes minutes, so it is never awaited in one request: the first poll
 * starts it, and each later poll checks on it (at most every 2 seconds) until it finishes.
 *
 * Take-over: the person can take control of the live browser at any time. The agent's run is
 * cancelled (that is the pause), the browser stays open, and when they hand it back a follow-up
 * run in the same Browser Use session continues from the page they left it on. The agent can also
 * ask for this itself ("NEEDS_USER: ..."), for example to sign in.
 */

export interface BrowserDeps {
  sql: Sql;
  browser: BrowserUse;
  /** Seals the live view link before it is stored; it works like a password for the browser. */
  secret: string;
  now?: () => Date;
  /** Minimum gap between checks on Browser Use (tests use 0). */
  checkGapMs?: number;
  /** The vault's master key; derived from `secret` when not given. */
  vaultKey?: VaultKey;
  /**
   * Hidden values a flight's browser session needs on every run (passport and similar, typed
   * only into the airline's or government's site). Chat browse calls have none.
   */
  extraSecrets?: (userId: string, s: BrowserSessionRow) => Promise<SecretBinding[]>;
}

export const vaultKey = (deps: Pick<BrowserDeps, "vaultKey" | "secret">) =>
  deps.vaultKey ?? vaultKeyFrom("", deps.secret);

export interface BrowseContext {
  userId: string;
  /** The reply behind a chat browse call; null for a flight's check-in or arrival card. */
  runId: string | null;
}

/** The hidden values a follow-up run in this session gets on top of its own. */
async function moreSecrets(deps: BrowserDeps, userId: string, s: BrowserSessionRow) {
  if (s.purpose === "chat" || !deps.extraSecrets) return [];
  return deps.extraSecrets(userId, s);
}

/** Spending cap for one browse run (Browser Use stops the run when it is reached). */
const MAX_COST_USD = 0.5;
/** Seconds the browser stays open after a run, for take-over. Free plans always get 120. */
const KEEP_ALIVE_S = 900;
const CHECK_GAP_MS = 2000;
/** A check that never gave its lease back (the server stopped mid-check) is retried after this. */
const CHECK_LEASE_MS = 60 * 1000;
const START_TIMEOUT_MS = 90 * 1000;
const WAIT_FOR_USER_MS = 15 * 60 * 1000;
const MAX_OUTPUT_FILES = 10;
const REPORT_CHAR_LIMIT = 8000;
/** How often the card's picture of the page is refreshed while the browser works. */
const PICTURE_GAP_MS = 12 * 1000;

const ACTIVE = ["starting", "running", "needs_user", "user_control"] as const;

export function isActive(s: BrowserSessionRow) {
  return (ACTIVE as readonly string[]).includes(s.status);
}

export async function findBrowserSession(
  sql: Sql,
  ctx: BrowseContext,
  travilaToolCallId: string,
): Promise<BrowserSessionRow | null> {
  const [row] = await withUser(
    sql,
    ctx.userId,
    (tx) => tx<BrowserSessionRow[]>`
      SELECT b.* FROM browser_sessions b JOIN tool_calls t ON t.id = b.tool_call_id
      WHERE t.run_id = ${ctx.runId} AND t.travila_tool_call_id = ${travilaToolCallId}`,
  );
  return row ?? null;
}

/** The person's own Browser Use profile and workspace, made on first use. */
async function identity(deps: BrowserDeps, userId: string) {
  return withUser(deps.sql, userId, async (tx) => {
    // Held while creating, so two browse calls at once don't make two profiles.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${"bu:" + userId}))`;
    const [row] = await tx<{ bu_profile_id: string | null; bu_workspace_id: string | null }[]>`
      SELECT bu_profile_id, bu_workspace_id FROM user_settings WHERE user_id = ${userId}`;
    let profileId = row?.bu_profile_id ?? null;
    let workspaceId = row?.bu_workspace_id ?? null;
    if (!profileId) profileId = await deps.browser.createProfile("AI assistant user", userId);
    if (!workspaceId)
      workspaceId = await deps.browser.createWorkspace(`AI assistant ${userId.slice(0, 8)}`);
    await tx`UPDATE user_settings SET bu_profile_id = ${profileId}, bu_workspace_id = ${workspaceId}
             WHERE user_id = ${userId}`;
    return { profileId, workspaceId };
  });
}

async function update(
  deps: BrowserDeps,
  ctx: BrowseContext,
  id: string,
  fields: Record<string, unknown>,
  onlyIf?: BrowserSessionRow["status"][],
): Promise<BrowserSessionRow | null> {
  return withUser(deps.sql, ctx.userId, async (tx) => {
    const [row] = await tx<BrowserSessionRow[]>`
      UPDATE browser_sessions SET ${tx(fields)}
      WHERE id = ${id} ${onlyIf ? tx`AND status = ANY(${onlyIf})` : tx``}
      RETURNING *`;
    return row ?? null;
  });
}

/** Starts the browser for a browse call. Safe to call twice for the same call. */
export async function startBrowse(
  deps: BrowserDeps,
  ctx: BrowseContext,
  toolCallId: string,
  args: Record<string, unknown>,
): Promise<void> {
  const task = String(args.task).trim();
  const url = typeof args.url === "string" && args.url ? args.url : null;
  const fileIds = Array.isArray(args.file_ids) ? (args.file_ids as string[]) : [];
  const title = jobTitle(args.title, task);
  const [session] = await withUser(
    deps.sql,
    ctx.userId,
    (tx) => tx<BrowserSessionRow[]>`
      INSERT INTO browser_sessions (user_id, run_id, tool_call_id, status, task, step, title)
      VALUES (${ctx.userId}, ${ctx.runId}, ${toolCallId}, 'starting',
              ${url ? `${task}\n\nStart at: ${url}` : task}, 'Opening the browser', ${title})
      ON CONFLICT (tool_call_id) DO NOTHING RETURNING *`,
  );
  if (!session) return;
  try {
    const { profileId, workspaceId } = await identity(deps, ctx.userId);
    const files = fileIds.length
      ? await withUser(
          deps.sql,
          ctx.userId,
          (tx) => tx<FileRow[]>`SELECT * FROM files WHERE id = ANY(${fileIds})`,
        )
      : [];
    const given: string[] = [];
    for (const f of files) {
      let path = f.bu_path;
      if (!path) {
        const stored = await readFile(deps.sql, ctx.userId, f.id);
        if (!stored) continue;
        path = await deps.browser.upload(workspaceId, {
          name: f.name ?? "file",
          contentType: f.mime ?? "application/octet-stream",
          data: stored.data,
        });
        await withUser(
          deps.sql,
          ctx.userId,
          (tx) => tx`UPDATE files SET bu_path = ${path} WHERE id = ${f.id}`,
        );
      }
      given.push(`- ${path} (the person's file "${f.name}")`);
    }
    const before = Object.fromEntries(
      (await deps.browser.listFiles(workspaceId, "outputs/", false)).map((f) => [
        f.path,
        f.lastModified,
      ]),
    );
    const lines = [BROWSER_INSTRUCTIONS, "", "Task", task];
    if (url) lines.push("", `Start at: ${url}`);
    if (given.length) lines.push("", "Files you were given", ...given);
    if (fileIds.length > given.length) {
      lines.push(
        "",
        "(Some files the assistant mentioned could not be found; say so in your report.)",
      );
    }
    const run = await deps.browser.createRun({
      task: lines.join("\n"),
      workspaceId,
      profileId,
      maxCostUsd: MAX_COST_USD,
      keepAlive: KEEP_ALIVE_S,
    });
    await update(
      deps,
      ctx,
      session.id,
      {
        status: "running",
        bu_run_id: run.id,
        bu_session_id: run.sessionId,
        bu_profile_id: profileId,
        bu_workspace_id: workspaceId,
        // As a JSON object (a JSON string here would be stored as one string, not an object).
        outputs_before: deps.sql.json(before),
        events_after: 0,
      },
      ["starting"],
    );
  } catch (err) {
    console.error(`browse ${session.id}: start failed`, err);
    await update(deps, ctx, session.id, {
      status: "failed",
      error:
        `The browser couldn't start. ${err instanceof Error ? err.message.slice(0, 200) : ""}`.trim(),
      finished_at: new Date(),
    });
  }
}

/**
 * Starts a browser session for a flight (a check-in or an arrival card): no chat reply is behind
 * it, so it belongs to the flight and its files go to `chatId`. Returns the new session's id.
 */
export async function startFlightBrowse(
  deps: BrowserDeps,
  userId: string,
  input: {
    purpose: "checkin" | "arrival_card";
    tripItemId: string;
    chatId: string | null;
    title: string;
    /** The whole task, rules included (BROWSER_INSTRUCTIONS is not added). */
    task: string;
    startUrl: string | null;
    secrets: SecretBinding[];
    maxCostUsd: number;
  },
): Promise<BrowserSessionRow> {
  const ctx = { userId, runId: null };
  const [session] = await withUser(
    deps.sql,
    userId,
    (tx) => tx<BrowserSessionRow[]>`
      INSERT INTO browser_sessions (user_id, status, task, step, title, purpose, chat_id,
                                    trip_item_id)
      VALUES (${userId}, 'starting',
              ${input.startUrl ? `${input.task}\n\nStart at: ${input.startUrl}` : input.task},
              'Opening the browser', ${input.title}, ${input.purpose}, ${input.chatId},
              ${input.tripItemId})
      RETURNING *`,
  );
  try {
    const { profileId, workspaceId } = await identity(deps, userId);
    const before = Object.fromEntries(
      (await deps.browser.listFiles(workspaceId, "outputs/", false)).map((f) => [
        f.path,
        f.lastModified,
      ]),
    );
    const run = await deps.browser.createRun({
      task: input.startUrl ? `${input.task}\n\nStart at: ${input.startUrl}` : input.task,
      secrets: input.secrets,
      workspaceId,
      profileId,
      maxCostUsd: input.maxCostUsd,
      keepAlive: KEEP_ALIVE_S,
    });
    return (
      (await update(
        deps,
        ctx,
        session!.id,
        {
          status: "running",
          bu_run_id: run.id,
          bu_session_id: run.sessionId,
          bu_profile_id: profileId,
          bu_workspace_id: workspaceId,
          outputs_before: deps.sql.json(before),
          events_after: 0,
        },
        ["starting"],
      )) ?? session!
    );
  } catch (err) {
    console.error(`flight browse ${session!.id}: start failed (${(err as Error).name})`);
    return (
      (await update(deps, ctx, session!.id, {
        status: "failed",
        error: "The browser couldn't start.",
        finished_at: new Date(),
      })) ?? session!
    );
  }
}

/** Moves a flight's browser session on; returns the finished session's report, or null. */
export async function advanceFlightBrowse(
  deps: BrowserDeps,
  userId: string,
  session: BrowserSessionRow,
): Promise<Record<string, unknown> | null> {
  return advanceBrowse(deps, { userId, runId: null }, session, async () => null);
}

/**
 * What the browser asks of the person, as one plain sentence for the card: no markdown, and
 * web addresses shortened to their site ("github.com" rather than a long sign-in link).
 */
export function plainAsk(raw: string): string {
  const text = raw
    .trim()
    .split("\n")[0]!
    .replace(/[`*_]/g, "")
    .replace(/https?:\/\/[^\s)"'<>]+/g, (match) => {
      // Punctuation after a link belongs to the sentence.
      const [, url, tail] = /^(.*?)([.,;:!?]*)$/.exec(match)!;
      try {
        return new URL(url!).hostname.replace(/^www\./, "") + tail;
      } catch {
        return match;
      }
    })
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 200 ? text.slice(0, 197) + "..." : text;
}

/** The assistant's short name for the job, or the task's first words when it gave none. */
export function jobTitle(given: unknown, task: string): string {
  const name = typeof given === "string" ? given.replace(/\s+/g, " ").trim() : "";
  if (name) return name.slice(0, 80);
  const words = task.replace(/\s+/g, " ").trim().split(" ").slice(0, 5).join(" ");
  const short = words.replace(/[.,;:!?]+$/, "");
  return short ? short[0]!.toUpperCase() + short.slice(1, 80) : "Browser task";
}

/**
 * Takes a picture of the page the browser is showing, for the card and for after it closes,
 * and notes its tabs. Best effort: a browser that has just closed simply keeps its last picture.
 */
async function takePicture(
  deps: BrowserDeps,
  ctx: BrowseContext,
  s: BrowserSessionRow,
): Promise<BrowserTab[] | null> {
  if (!s.bu_browser_id) return null;
  try {
    const shot = await deps.browser.capture(s.bu_browser_id);
    if (!shot) return null;
    const file = await saveFile(deps.sql, ctx.userId, {
      kind: "generated",
      name: "browser.jpg",
      mime: "image/jpeg",
      data: shot.jpeg,
      runId: ctx.runId,
    });
    await withUser(deps.sql, ctx.userId, async (tx) => {
      const [old] = await tx<{ screenshot_file_id: string | null }[]>`
        SELECT screenshot_file_id FROM browser_sessions WHERE id = ${s.id} FOR UPDATE`;
      await tx`UPDATE browser_sessions
               SET screenshot_file_id = ${file.id}, screenshot_at = now(),
                   tabs = ${tx.json(shot.tabs as unknown as Parameters<typeof tx.json>[0])}
               WHERE id = ${s.id}`;
      if (old?.screenshot_file_id) await tx`DELETE FROM files WHERE id = ${old.screenshot_file_id}`;
    });
    return shot.tabs;
  } catch (err) {
    // Never log the error's details: they could carry the browser's address.
    console.error(`browse ${s.id}: no picture of the page (${(err as Error).name})`);
    return null;
  }
}

/** What happened in the browser since we last looked: the live view link and the latest step. */
function readEvents(events: BuEvent[], deps: BrowserDeps) {
  const out: { live?: string; browserId?: string; step?: string } = {};
  for (const e of events) {
    const d = e.data ?? {};
    if (
      e.type === "browser.ready" ||
      e.type === "browser.reattached" ||
      e.type === "browser.attached"
    ) {
      if (typeof d.live_view_url === "string") out.live = sealSecret(d.live_view_url, deps.secret);
      if (typeof d.browser_session_id === "string") out.browserId = d.browser_session_id;
    }
    if (e.type === "core.event") {
      const part = (d.part ?? {}) as {
        type?: string;
        text?: string;
        tool?: string;
        state?: { input?: { code?: string } };
      };
      // The agent's final "NEEDS_SIGN_IN: ..." or "BLOCKED: ..." reply is for us, not a step.
      if (
        part.type === "text" &&
        part.text?.trim() &&
        !/^(NEEDS_SIGN_IN|NEEDS_CODE|NEEDS_USER|BLOCKED):/.test(part.text.trim())
      ) {
        const line = part.text.trim().split("\n")[0]!.replace(/[*`_]/g, "");
        out.step = line.length > 140 ? line.slice(0, 137) + "..." : line;
      }
      const nav =
        part.tool === "browser_execute" &&
        part.state?.input?.code?.match(/navigate\(\{\s*url:\s*["']([^"']+)/);
      if (nav) {
        try {
          out.step = `Opening ${new URL(nav[1]!).hostname.replace(/^www\./, "")}`;
        } catch {
          // Not a URL; keep the last step.
        }
      }
    }
  }
  return out;
}

/** Copies files the agent saved into outputs/ during this session into our own store. */
async function copyOutputs(deps: BrowserDeps, ctx: BrowseContext, s: BrowserSessionRow) {
  if (!s.bu_workspace_id) return [];
  const [run] = ctx.runId
    ? await withUser(
        deps.sql,
        ctx.userId,
        (tx) => tx<{ chat_id: string }[]>`SELECT chat_id FROM runs WHERE id = ${ctx.runId}`,
      )
    : [{ chat_id: s.chat_id }];
  const listed = await deps.browser.listFiles(s.bu_workspace_id, "outputs/", true);
  const fresh = listed
    .filter((f) => s.outputs_before[f.path] !== f.lastModified && f.size > 0)
    .slice(0, MAX_OUTPUT_FILES);
  const saved: { name: string; note?: string }[] = [];
  for (const f of fresh) {
    const name = f.path.split("/").pop() ?? "file";
    if (f.size > MAX_FILE_BYTES) {
      saved.push({ name, note: "too large to keep (over 20 MB)" });
      continue;
    }
    try {
      // Links expire after 60 seconds, so each file is copied straight away.
      const data = await deps.browser.download(f.url!, MAX_FILE_BYTES);
      await saveFile(deps.sql, ctx.userId, {
        kind: "browser_download",
        name,
        mime: mimeFor(name),
        data,
        chatId: run?.chat_id ?? null,
        runId: ctx.runId,
      });
      saved.push({ name });
    } catch (err) {
      console.error(`browse ${s.id}: couldn't copy ${f.path}`, err);
      saved.push({ name, note: "couldn't be copied" });
    }
  }
  return saved;
}

async function stopQuietly(deps: BrowserDeps, s: BrowserSessionRow) {
  try {
    if (s.bu_run_id && s.status === "running") await deps.browser.cancelRun(s.bu_run_id);
  } catch {
    // Already finished.
  }
  try {
    if (s.bu_browser_id) await deps.browser.stopBrowser(s.bu_browser_id);
  } catch {
    // Already stopped.
  }
}

/** The tool result for a finished session, as it goes back to the model. */
export function resultFor(s: BrowserSessionRow): Record<string, unknown> {
  if (s.status === "done" && s.result) return JSON.parse(s.result) as Record<string, unknown>;
  if (s.status === "stopped") return { error: "The user stopped the browser. Stop now." };
  return {
    error: `${s.error ?? "The browser failed."} Answer without it and say what you couldn't check.`,
  };
}

/**
 * Checks on a browse call. Returns the tool result once it is finished (also on later calls,
 * so a result that failed to reach Travila is sent again), or null while it is still going.
 * `register` gives the starting page a citation number.
 */
export async function advanceBrowse(
  deps: BrowserDeps,
  ctx: BrowseContext,
  session: BrowserSessionRow,
  register: (url: string, title: string, injection: boolean) => Promise<number | null>,
): Promise<Record<string, unknown> | null> {
  const now = deps.now?.() ?? new Date();
  // One check at a time, at most one every 2 seconds, whoever is polling. A check can take a
  // while (a picture, a sign-in), so it holds a lease that it gives back when it ends.
  const [s] = await withUser(
    deps.sql,
    ctx.userId,
    (tx) => tx<BrowserSessionRow[]>`
      UPDATE browser_sessions SET checked_at = ${new Date(now.getTime() + CHECK_LEASE_MS)}
      WHERE id = ${session.id}
        AND (checked_at IS NULL
             OR checked_at <= ${new Date(now.getTime() - (deps.checkGapMs ?? CHECK_GAP_MS))})
      RETURNING *`,
  );
  if (!s) return null;
  try {
    return await check(deps, ctx, s, now, register);
  } finally {
    await withUser(
      deps.sql,
      ctx.userId,
      (tx) => tx`UPDATE browser_sessions SET checked_at = ${now} WHERE id = ${s.id}`,
    );
  }
}

async function check(
  deps: BrowserDeps,
  ctx: BrowseContext,
  s: BrowserSessionRow,
  now: Date,
  register: (url: string, title: string, injection: boolean) => Promise<number | null>,
): Promise<Record<string, unknown> | null> {
  if (!isActive(s)) return resultFor(s);

  // The freshest copy of the session, for the picture (it needs the browser's id).
  let latest = s;
  const fail = async (error: string, extra: Record<string, unknown> = {}) => {
    await takePicture(deps, ctx, latest);
    await stopQuietly(deps, latest);
    const row = await update(
      deps,
      ctx,
      s.id,
      { status: "failed", error, finished_at: now, ...extra },
      [latest.status],
    );
    return row ? resultFor(row) : null;
  };

  if (s.status === "starting") {
    const age = now.getTime() - new Date(s.created_at).getTime();
    return age > START_TIMEOUT_MS ? fail("The browser didn't start in time.") : null;
  }
  if (s.status === "needs_user" || s.status === "user_control") {
    const since = s.waiting_since ? now.getTime() - new Date(s.waiting_since).getTime() : 0;
    return since > WAIT_FOR_USER_MS
      ? fail("The user didn't hand the browser back, so it was closed.")
      : null;
  }

  // Running: read new events first, then the status, so nothing is missed at the end.
  let after = Number(s.events_after);
  const seen: { live?: string; browserId?: string; step?: string } = {};
  for (let page = 0; page < 5; page++) {
    const res = await deps.browser.runEvents(s.bu_run_id!, after);
    Object.assign(seen, readEvents(res.events, deps));
    after = res.nextAfter ?? after;
    if (!res.hasMore) break;
  }
  const status = await deps.browser.runStatus(s.bu_run_id!);
  const progress: Record<string, unknown> = { events_after: after };
  if (seen.live) progress.live_view_url_ciphertext = seen.live;
  if (seen.browserId) progress.bu_browser_id = seen.browserId;
  if (seen.step) progress.step = seen.step;
  // Null when the person took over meanwhile; their take-over wins.
  const current = await update(deps, ctx, s.id, progress, ["running"]);
  if (!current) return null;
  latest = current;
  if (!isTerminal(status)) {
    const age = current.screenshot_at
      ? now.getTime() - new Date(current.screenshot_at).getTime()
      : Infinity;
    if (age >= PICTURE_GAP_MS) {
      const tabs = await takePicture(deps, ctx, current);
      // Past the sign-in page after a sign-in we sent: it worked.
      const page = tabs?.find((t) => t.active)?.url;
      if (page && hostOf(page) === current.sign_in_site && !looksLikeSignIn(page)) {
        await signInWorked(deps, ctx, current);
      }
      if (page && hostOf(page) === current.code_site && !looksLikeSignIn(page)) {
        await savedCodeWorked(deps, ctx, current);
      }
    }
    return null;
  }

  if (status !== "completed") {
    const run = await deps.browser.getRun(s.bu_run_id!).catch(() => null);
    return fail(
      status === "cancelled"
        ? "The browser run was cancelled."
        : `The browser agent failed. ${run?.error?.slice(0, 200) ?? ""}`.trim(),
    );
  }

  const run = await deps.browser.getRun(s.bu_run_id!);
  const report = (run.result ?? "").trim();
  if (report.startsWith("BLOCKED:")) {
    const why = report.slice("BLOCKED:".length).trim().split("\n")[0]!.slice(0, 200);
    return fail(`The website blocked the browser${why ? `: ${why}` : "."}`, { blocked: true });
  }
  const asking = /^(NEEDS_SIGN_IN|NEEDS_CODE|NEEDS_USER):/.exec(report);
  if (asking) {
    const ask = plainAsk(report.slice(asking[0].length));
    const tabs = await takePicture(deps, ctx, current);
    // Where a sign-in may be typed comes from the page the browser is really on, never from
    // the agent's words (a page could talk the agent into naming another site).
    const site = hostOf(tabs?.find((t) => t.active)?.url);
    const kind =
      site && asking[1] === "NEEDS_SIGN_IN"
        ? "sign_in"
        : site && asking[1] === "NEEDS_CODE"
          ? "code"
          : null;
    const fields: Record<string, unknown> = {
      status: "needs_user",
      needs_user: ask || "The browser needs you.",
      ask_kind: kind,
      ask_site: kind ? site : null,
      ask_problem: null,
      ask_saved_account: null,
      step: null,
      waiting_since: now,
    };
    const sentHere = !!current.sign_in_by && current.sign_in_site === site;
    if (kind === "code" && sentHere) {
      // Asked for a code: the site took the sign-in.
      await signInWorked(deps, ctx, current);
    }
    if (kind === "code") {
      const codeHere = !!current.code_by && current.code_site === site;
      if (codeHere && current.code_by === "saved") {
        // The code from the saved key was turned down (a clock or key problem): ask the person.
        fields.ask_problem = "saved_code_rejected";
      } else if (!codeHere) {
        // The sign-in ladder, 2-step: a saved authenticator key for this site makes the code.
        const saved =
          sentHere && current.vault_credential_id
            ? await loginSummary(deps.sql, ctx.userId, current.vault_credential_id)
            : await findLogin(deps.sql, ctx.userId, site!);
        // A login set to "Ask before using" that the person just approved counts as approved.
        const approved = !saved?.askBeforeUse || (sentHere && current.sign_in_by === "saved");
        if (saved?.hasCodeKey && approved && saved.site === site) {
          const row = await useSavedCode(deps, ctx, current, site!, saved.id).catch((err) => {
            console.error(`browse ${s.id}: saved code didn't start (${(err as Error).name})`);
            return null;
          });
          if (row) return null;
        }
      }
    }
    if (kind === "sign_in" && sentHere && !current.sign_in_note) {
      // Back on the sign-in page of the same site: the site turned the sign-in down.
      fields.ask_problem = current.sign_in_by === "saved" ? "saved_rejected" : "typed_rejected";
      if (current.vault_credential_id) {
        await recordResult(deps.sql, ctx.userId, current.vault_credential_id, "rejected", s.id);
      }
    } else if (kind === "sign_in" && !(current.sign_in_by === "saved" && sentHere)) {
      // The sign-in ladder: a saved login for this site fills in by itself (once per page).
      const saved = await findLogin(deps.sql, ctx.userId, site!);
      if (saved?.lastResult === "rejected") {
        fields.ask_problem = "saved_rejected";
        fields.vault_credential_id = saved.id;
      } else if (saved?.askBeforeUse) {
        fields.ask_saved_account = saved.account;
        fields.vault_credential_id = saved.id;
      } else if (saved) {
        const row = await useSavedLogin(deps, ctx, current, site!, saved.id).catch((err) => {
          console.error(`browse ${s.id}: saved sign-in didn't start (${(err as Error).name})`);
          return null;
        });
        if (row) return null;
      }
    }
    await update(deps, ctx, s.id, fields, ["running"]);
    return null;
  }

  const files = await copyOutputs(deps, ctx, current);
  await takePicture(deps, ctx, current);
  await stopQuietly(deps, { ...current, status: "done" });
  const task = current.task ?? "";
  const startUrl = task && /^Start at: (\S+)$/m.exec(task)?.[1];
  const injection = detectInjection(report);
  const n = startUrl
    ? await register(startUrl, new URL(startUrl).hostname.replace(/^www\./, ""), injection)
    : null;
  const text =
    report.length > REPORT_CHAR_LIMIT
      ? report.slice(0, REPORT_CHAR_LIMIT) + "\n[report cut here]"
      : report;
  const result: Record<string, unknown> = {
    report: fence("browser agent report", text || "(The agent finished without a report.)"),
    files_downloaded: files.map((f) => (f.note ? `${f.name} (${f.note})` : f.name)),
  };
  if (n !== null) {
    result.n = n;
    result.cite_as = `[${n}]`;
  }
  if (files.length) result.note = "The user can download these files from your answer.";
  await signInWorked(deps, ctx, current);
  await savedCodeWorked(deps, ctx, current);
  const [{ sign_in_note: note } = { sign_in_note: null }] = await withUser(
    deps.sql,
    ctx.userId,
    (tx) => tx<{ sign_in_note: string | null }[]>`
      SELECT sign_in_note FROM browser_sessions WHERE id = ${s.id}`,
  );
  // So the answer can say how it signed in, instead of guessing.
  if (note) result.sign_in = note;
  const done = await update(
    deps,
    ctx,
    s.id,
    {
      status: "done",
      result: JSON.stringify(result),
      cost_usd: run.totalCostUsd ?? null,
      step: null,
      finished_at: now,
    },
    ["running"],
  );
  return done ? result : null;
}

async function owned(deps: BrowserDeps, userId: string, id: string): Promise<BrowserSessionRow> {
  const [row] = await withUser(
    deps.sql,
    userId,
    (tx) => tx<BrowserSessionRow[]>`SELECT * FROM browser_sessions WHERE id = ${id}`,
  );
  if (!row) throw new NotFound("browser session");
  return row;
}

/** The person takes control of the browser; the agent's run is cancelled, which pauses it. */
export async function takeOver(deps: BrowserDeps, userId: string, id: string) {
  const s = await owned(deps, userId, id);
  const ctx = { userId, runId: s.run_id };
  const now = deps.now?.() ?? new Date();
  if (s.status === "user_control") return s;
  if (s.status === "needs_user") {
    return (
      (await update(deps, ctx, s.id, { status: "user_control", user_took_over_at: now }, [
        "needs_user",
      ])) ?? s
    );
  }
  if (s.status !== "running") throw new Conflict("This browser session has ended.");
  const row = await update(
    deps,
    ctx,
    s.id,
    { status: "user_control", user_took_over_at: now, waiting_since: now, step: null },
    ["running"],
  );
  if (!row) throw new Conflict("The browser just finished; there's nothing to take over.");
  try {
    await deps.browser.cancelRun(s.bu_run_id!);
  } catch (err) {
    console.error(`browse ${s.id}: cancel for take-over failed`, err);
  }
  return row;
}

/** The person hands the browser back; the agent continues from the current page. */
export async function handBack(deps: BrowserDeps, userId: string, id: string) {
  const s = await owned(deps, userId, id);
  const ctx = { userId, runId: s.run_id };
  if (s.status !== "user_control" && s.status !== "needs_user") {
    throw new Conflict("The browser isn't waiting for you.");
  }
  let run;
  try {
    run = await deps.browser.createRun({
      task: "The person took over the browser and has now handed it back to you. Look at the current page first, then continue and finish the original task, following the same rules.",
      secrets: await moreSecrets(deps, userId, s),
      sessionId: s.bu_session_id!,
      workspaceId: s.bu_workspace_id ?? undefined,
      profileId: s.bu_profile_id ?? undefined,
      maxCostUsd: MAX_COST_USD,
      keepAlive: KEEP_ALIVE_S,
    });
  } catch (err) {
    if ((err as { status?: number }).status === 409) {
      throw new Conflict("The browser is still stopping. Try again in a few seconds.");
    }
    throw err;
  }
  return (
    (await update(
      deps,
      ctx,
      s.id,
      {
        status: "running",
        bu_run_id: run.id,
        events_after: 0,
        needs_user: null,
        ask_kind: null,
        ask_site: null,
        ask_problem: null,
        ask_saved_account: null,
        // They signed in themselves, if at all; a later sign-in page isn't a turned-down login.
        sign_in_by: null,
        sign_in_site: null,
        code_by: null,
        code_site: null,
        waiting_since: null,
        step: "Continuing from where you left it",
      },
      ["user_control", "needs_user"],
    )) ?? s
  );
}

/** Longest sign-in value accepted (Browser Use's limit is 4096 bytes). */
const MAX_SECRET_CHARS = 1000;

/** Pages that are still part of signing in, judged from the address. */
export function looksLikeSignIn(url: string): boolean {
  try {
    const u = new URL(url);
    return /log-?in|sign-?in|signon|session|auth|sso|password|2fa|mfa|verify|challenge|checkpoint/i.test(
      u.pathname + u.search,
    );
  } catch {
    return true;
  }
}

/**
 * Notes that the site took a sign-in we sent (once: the first check to see it wins), and logs it
 * against the saved login. Returns the card's note, or null if there was nothing new to note.
 */
async function signInWorked(
  deps: BrowserDeps,
  ctx: BrowseContext,
  s: BrowserSessionRow,
): Promise<string | null> {
  if (!s.sign_in_by || s.sign_in_note || !s.sign_in_site) return null;
  const site = s.sign_in_site;
  const note =
    s.sign_in_by === "saved"
      ? `Signed in to ${site} with your saved login`
      : s.vault_credential_id
        ? `Signed in to ${site}. Your login is saved for next time`
        : `Signed in to ${site}`;
  const [row] = await withUser(
    deps.sql,
    ctx.userId,
    (tx) => tx`UPDATE browser_sessions SET sign_in_note = ${note}
               WHERE id = ${s.id} AND sign_in_note IS NULL RETURNING id`,
  );
  if (!row) return null;
  if (s.vault_credential_id) {
    await recordResult(deps.sql, ctx.userId, s.vault_credential_id, "worked", s.id);
  }
  return note;
}

/**
 * Starts the follow-up run that types a sign-in into the page. The values go to Browser Use as
 * secrets, which it types in by name and only on `site`; the agent, our model and our logs never
 * see them.
 */
async function sendSignIn(
  deps: BrowserDeps,
  ctx: BrowseContext,
  s: BrowserSessionRow,
  site: string,
  login: { username: string; password: string },
  by: "typed" | "saved",
  credentialId: string | null,
): Promise<BrowserSessionRow | null> {
  const bind = (alias: string, value: string) => ({ alias, value, allowedDomains: [site] });
  const task = [
    by === "saved"
      ? `The person's saved sign-in for ${site} is ready for you.`
      : `The person has given you their sign-in for ${site}.`,
    login.username
      ? 'Their username or email is the secret named "login_username" and their password is the secret named "login_password".'
      : 'Their password is the secret named "login_password" (the username is already filled in or remembered).',
    "You can't see the values: ask for a secret by its name to have it typed into the field that has focus.",
    "Before typing each one, focus its field with element.focus() (find the field by its label, name or type, not by screen position) and check that it has focus. Never read back what was typed.",
    `Type them into the sign-in form on ${site}, submit it, then continue and finish the original task, following the same rules.`,
    'If the sign-in is refused, stop and make your final reply start with "NEEDS_SIGN_IN:" and say what the site showed. If the site asks for a one-time code, reply starting with "NEEDS_CODE:".',
  ].join("\n");
  const run = await deps.browser.createRun({
    task,
    secrets: [
      ...(login.username ? [bind("login_username", login.username)] : []),
      bind("login_password", login.password),
      ...(await moreSecrets(deps, ctx.userId, s)),
    ],
    sessionId: s.bu_session_id!,
    workspaceId: s.bu_workspace_id ?? undefined,
    profileId: s.bu_profile_id ?? undefined,
    maxCostUsd: MAX_COST_USD,
    keepAlive: KEEP_ALIVE_S,
  });
  return update(
    deps,
    ctx,
    s.id,
    {
      status: "running",
      bu_run_id: run.id,
      events_after: 0,
      needs_user: null,
      ask_kind: null,
      ask_site: null,
      ask_problem: null,
      ask_saved_account: null,
      waiting_since: null,
      step:
        by === "saved" ? `Signing in to ${site} with your saved login` : `Signing in to ${site}`,
      sign_in_by: by,
      sign_in_site: site,
      vault_credential_id: credentialId,
      sign_in_note: null,
    },
    [s.status],
  );
}

/** Types a 2-step code made from the saved authenticator key. Null if there is none. */
async function useSavedCode(
  deps: BrowserDeps,
  ctx: BrowseContext,
  s: BrowserSessionRow,
  site: string,
  credentialId: string,
): Promise<BrowserSessionRow | null> {
  const code = await codeForRun(
    deps.sql,
    vaultKey(deps),
    ctx.userId,
    credentialId,
    site,
    s.id,
    deps.now?.() ?? new Date(),
  );
  if (!code) return null;
  return sendCode(deps, ctx, s, site, code, "saved");
}

/** Fills a saved login from the vault. Null if it can't be opened. */
async function useSavedLogin(
  deps: BrowserDeps,
  ctx: BrowseContext,
  s: BrowserSessionRow,
  site: string,
  credentialId: string,
): Promise<BrowserSessionRow | null> {
  const login = await loginForRun(deps.sql, vaultKey(deps), ctx.userId, credentialId, site, s.id);
  if (!login) return null;
  return sendSignIn(deps, ctx, s, site, login, "saved", credentialId);
}

/** Browser Use's errors are never passed on or logged: its reply could repeat what was sent. */
async function guarded<T>(s: BrowserSessionRow, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof Conflict || err instanceof BadRequest) throw err;
    const status = (err as { status?: number }).status;
    if (status === 409) {
      throw new Conflict("The browser is still busy. Try again in a few seconds.");
    }
    console.error(`browse ${s.id}: sign-in run didn't start (HTTP ${status ?? "?"})`);
    throw new Conflict("The browser couldn't take your sign-in. Try again, or take control.");
  }
}

/**
 * The secure sign-in box: the person's sign-in (or one-time code) goes straight to Browser Use
 * with a follow-up run, which types it into the page. Only for the site the browser was on when
 * it asked. With "Save for next time" (the default) the login is also saved in the vault, bound
 * to that site; `useSaved` fills the saved one instead (for logins set to "Ask before using").
 */
export async function signIn(
  deps: BrowserDeps,
  userId: string,
  id: string,
  input: {
    username?: string;
    password?: string;
    code?: string;
    save?: boolean;
    useSaved?: boolean;
  },
) {
  const s = await owned(deps, userId, id);
  const ctx = { userId, runId: s.run_id };
  if (s.status !== "needs_user" || !s.ask_kind || !s.ask_site) {
    throw new Conflict("The browser isn't asking for a sign-in.");
  }
  const site = s.ask_site;
  if (s.ask_kind === "sign_in" && input.useSaved) {
    const saved = await findLogin(deps.sql, userId, site);
    if (!saved) throw new Conflict(`There's no saved login for ${site} now. Type it instead.`);
    const row = await guarded(s, () => useSavedLogin(deps, ctx, s, site, saved.id));
    if (!row)
      throw new Conflict(`The saved login for ${site} couldn't be opened. Type it instead.`);
    return row;
  }
  if (s.ask_kind === "sign_in") {
    const username = input.username?.trim() ?? "";
    const password = input.password ?? "";
    if (!password || password.length > MAX_SECRET_CHARS || username.length > MAX_SECRET_CHARS) {
      throw new BadRequest("Enter your password.");
    }
    let credentialId: string | null = null;
    if (input.save !== false) {
      const page = s.tabs?.find?.((t) => t.active)?.url;
      credentialId = await saveLogin(deps.sql, vaultKey(deps), userId, {
        site,
        username,
        password,
        loginPath: page && hostOf(page) === site ? new URL(page).pathname : null,
        // Replaces the saved login the site just turned down.
        replaceId: s.vault_credential_id,
        browserSessionId: s.id,
      });
    }
    return (
      (await guarded(s, () =>
        sendSignIn(deps, ctx, s, site, { username, password }, "typed", credentialId),
      )) ?? s
    );
  }

  const code = input.code?.replace(/\s+/g, "") ?? "";
  if (!code || code.length > 64) throw new BadRequest("Enter the code.");
  return (await guarded(s, () => sendCode(deps, ctx, s, site, code, "typed"))) ?? s;
}

/** Starts the follow-up run that types a one-time code into the page, on `site` only. */
async function sendCode(
  deps: BrowserDeps,
  ctx: BrowseContext,
  s: BrowserSessionRow,
  site: string,
  code: string,
  by: "typed" | "saved",
): Promise<BrowserSessionRow | null> {
  const task = [
    by === "saved"
      ? `The 2-step code for ${site} is ready for you. It is the secret named "login_code".`
      : `The person has given you the one-time code ${site} asked for. It is the secret named "login_code".`,
    "You can't see it: ask for the secret by its name to have it typed into the field that has focus. Focus the code field with element.focus() first. Never read back what was typed.",
    "Type it into the code field straight away, submit it, then continue and finish the original task, following the same rules.",
    'If the code is refused, stop and make your final reply start with "NEEDS_CODE:" and say what the site showed.',
  ].join("\n");
  const run = await deps.browser.createRun({
    task,
    secrets: [
      { alias: "login_code", value: code, allowedDomains: [site] },
      ...(await moreSecrets(deps, ctx.userId, s)),
    ],
    sessionId: s.bu_session_id!,
    workspaceId: s.bu_workspace_id ?? undefined,
    profileId: s.bu_profile_id ?? undefined,
    maxCostUsd: MAX_COST_USD,
    keepAlive: KEEP_ALIVE_S,
  });
  return update(
    deps,
    ctx,
    s.id,
    {
      status: "running",
      bu_run_id: run.id,
      events_after: 0,
      needs_user: null,
      ask_kind: null,
      ask_site: null,
      ask_problem: null,
      ask_saved_account: null,
      waiting_since: null,
      step: by === "saved" ? "Entering the 2-step code from your vault" : "Entering your code",
      code_by: by,
      code_site: site,
    },
    [s.status],
  );
}

/**
 * The site took a code made from the saved key: the card says so. Once per browser session
 * (the note changes only the first time).
 */
async function savedCodeWorked(deps: BrowserDeps, ctx: BrowseContext, s: BrowserSessionRow) {
  if (s.code_by !== "saved" || !s.code_site) return;
  const note = `Signed in to ${s.code_site} with your saved login and 2-step code`;
  await withUser(
    deps.sql,
    ctx.userId,
    (tx) => tx`UPDATE browser_sessions SET sign_in_note = ${note}
               WHERE id = ${s.id} AND sign_in_note IS DISTINCT FROM ${note}`,
  );
}

/** Stop button: closes every browser the run still has open. */
export async function stopBrowsing(deps: BrowserDeps, ctx: BrowseContext) {
  const rows = await withUser(
    deps.sql,
    ctx.userId,
    (tx) => tx<BrowserSessionRow[]>`
      SELECT * FROM browser_sessions WHERE run_id = ${ctx.runId} AND status = ANY(${[...ACTIVE]})`,
  );
  for (const s of rows) {
    await update(deps, ctx, s.id, { status: "stopped", finished_at: deps.now?.() ?? new Date() });
    await stopQuietly(deps, s);
  }
}

/** Every browser job in these runs, oldest first, by run. Only ever sent to their owner. */
export async function browserViewsFor(
  sql: Sql,
  userId: string,
  runIds: string[],
  secret: string,
): Promise<Map<string, BrowserView[]>> {
  const out = new Map<string, BrowserView[]>();
  if (!runIds.length) return out;
  const rows = await withUser(
    sql,
    userId,
    (tx) => tx<BrowserSessionRow[]>`
      SELECT * FROM browser_sessions WHERE run_id = ANY(${runIds}) ORDER BY created_at`,
  );
  for (const row of rows) {
    const list = out.get(row.run_id!) ?? [];
    list.push(viewOf(row, secret));
    out.set(row.run_id!, list);
  }
  return out;
}

/** The status in Muse's words. */
export function labelFor(s: BrowserSessionRow): string {
  switch (s.status) {
    case "starting":
      return "Working on it";
    case "running":
      return "Browsing";
    case "needs_user":
      return "Waiting for you";
    case "user_control":
      return "You're in control";
    case "done":
      return "Done";
    case "stopped":
      return "Stopped";
    default:
      return s.blocked ? "Site blocked" : "Couldn't finish";
  }
}

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.hostname.replace(/^www\./, "") : null;
  } catch {
    return null;
  }
}

export function viewOf(s: BrowserSessionRow, secret: string): BrowserView {
  const active = isActive(s);
  const tabs = (Array.isArray(s.tabs) ? s.tabs : []).filter((t) => t.url !== "about:blank");
  const startUrl = s.task ? /^Start at: (\S+)$/m.exec(s.task)?.[1] : null;
  return {
    id: s.id,
    status: s.status,
    label: labelFor(s),
    title: s.title ?? jobTitle(null, (s.task ?? "").split("\n")[0] ?? ""),
    site: hostOf(tabs.find((t) => t.active)?.url) ?? hostOf(startUrl),
    tabs,
    step: active ? s.step : null,
    needsUser: s.status === "needs_user" ? s.needs_user : null,
    ask:
      s.status === "needs_user" && s.ask_kind && s.ask_site
        ? {
            kind: s.ask_kind,
            site: s.ask_site,
            problem:
              s.ask_kind === "sign_in" || s.ask_problem === "saved_code_rejected"
                ? s.ask_problem
                : null,
            savedAccount: s.ask_kind === "sign_in" ? s.ask_saved_account : null,
          }
        : null,
    note: s.sign_in_note,
    liveUrl:
      active && s.live_view_url_ciphertext ? openSecret(s.live_view_url_ciphertext, secret) : null,
    screenshotId: s.screenshot_file_id,
    closed: !active,
    failed: s.status === "failed" || s.status === "stopped",
  };
}
