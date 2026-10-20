import { BROWSER_INSTRUCTIONS } from "@ai-assistant/agent";
import { withUser, type BrowserSessionRow, type FileRow, type Sql } from "@ai-assistant/db";
import type { BrowserView } from "@ai-assistant/api-client";
import { openSecret, sealSecret } from "./auth.js";
import { isTerminal, type BrowserUse, type BuEvent } from "./browseruse.js";
import { MAX_FILE_BYTES, mimeFor, readFile, saveFile } from "./files.js";
import { Conflict, NotFound } from "./errors.js";
import { detectInjection, fence } from "./untrusted.js";

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
}

export interface BrowseContext {
  userId: string;
  runId: string;
}

/** Spending cap for one browse run (Browser Use stops the run when it is reached). */
const MAX_COST_USD = 0.5;
/** Seconds the browser stays open after a run, for take-over. Free plans always get 120. */
const KEEP_ALIVE_S = 900;
const CHECK_GAP_MS = 2000;
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
async function takePicture(deps: BrowserDeps, ctx: BrowseContext, s: BrowserSessionRow) {
  if (!s.bu_browser_id) return;
  try {
    const shot = await deps.browser.capture(s.bu_browser_id);
    if (!shot) return;
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
  } catch (err) {
    // Never log the error's details: they could carry the browser's address.
    console.error(`browse ${s.id}: no picture of the page (${(err as Error).name})`);
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
      if (part.type === "text" && part.text?.trim()) {
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
  const [run] = await withUser(
    deps.sql,
    ctx.userId,
    (tx) => tx<{ chat_id: string }[]>`SELECT chat_id FROM runs WHERE id = ${ctx.runId}`,
  );
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
  // At most one check every 2 seconds, whoever is polling.
  const [s] = await withUser(
    deps.sql,
    ctx.userId,
    (tx) => tx<BrowserSessionRow[]>`
      UPDATE browser_sessions SET checked_at = ${now}
      WHERE id = ${session.id}
        AND (checked_at IS NULL
             OR checked_at <= ${new Date(now.getTime() - (deps.checkGapMs ?? CHECK_GAP_MS))})
      RETURNING *`,
  );
  if (!s) return null;
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
    if (age >= PICTURE_GAP_MS) await takePicture(deps, ctx, current);
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
  if (report.startsWith("NEEDS_USER:")) {
    const ask = report.slice("NEEDS_USER:".length).trim().split("\n")[0]!.slice(0, 300);
    await takePicture(deps, ctx, current);
    await update(
      deps,
      ctx,
      s.id,
      { status: "needs_user", needs_user: ask || "The browser needs you.", waiting_since: now },
      ["running"],
    );
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
  const ctx = { userId, runId: s.run_id ?? "" };
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
  const ctx = { userId, runId: s.run_id ?? "" };
  if (s.status !== "user_control" && s.status !== "needs_user") {
    throw new Conflict("The browser isn't waiting for you.");
  }
  let run;
  try {
    run = await deps.browser.createRun({
      task: "The person took over the browser and has now handed it back to you. Look at the current page first, then continue and finish the original task, following the same rules.",
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
        waiting_since: null,
        step: "Continuing from where you left it",
      },
      ["user_control", "needs_user"],
    )) ?? s
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
      return "Sign-in needed";
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
    liveUrl:
      active && s.live_view_url_ciphertext ? openSecret(s.live_view_url_ciphertext, secret) : null,
    screenshotId: s.screenshot_file_id,
    closed: !active,
    failed: s.status === "failed" || s.status === "stopped",
  };
}
