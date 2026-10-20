import {
  CLIENT_TOOL_TIMEOUT_MS,
  MAIN_INSTRUCTIONS,
  MAX_LOOPS,
  MODELS,
  PROFILE_VERSION,
  REASONING_EFFORT,
  TOOLS,
} from "@ai-assistant/agent";
import {
  withUser,
  type ChatRow,
  type FileRow,
  type MessagePart,
  type MessageRow,
  type RunRow,
  type Sql,
} from "@ai-assistant/db";
import type { MessageView, RunView } from "@ai-assistant/api-client";
import {
  advanceBrowse,
  browserViewFor,
  findBrowserSession,
  stopBrowsing,
  type BrowserDeps,
} from "./browser.js";
import { groundAnswer } from "./citations.js";
import { Conflict, NotFound } from "./errors.js";
import { attachmentNote, fileTexts, fileView } from "./files.js";
import {
  claimToolCall,
  doneLineFor,
  finishToolCall,
  registerSources,
  runTool,
  statusLineFor,
  type ToolDeps,
} from "./tools.js";
import type { CreateThreadInput, Travila, TravilaMessage, TravilaToolCall } from "./travila.js";

/**
 * The run orchestrator. Travila can't stream, so the browser polls GET /runs/:id and each poll
 * moves the run forward: it reads Travila's state, runs any tools the model is waiting on,
 * and saves the finished answer. Nothing depends on one long-lived request, so a refresh or a
 * dropped connection just resumes polling the same run.
 */

export interface Session {
  userId: string;
  travilaUserId: string;
  timezone: string;
}

export interface Deps extends ToolDeps {
  sql: Sql;
  travila: Travila;
  now?: () => Date;
  /** Keeps background work alive after the response (e.g. Vercel's waitUntil). Tests await it. */
  defer?: (work: Promise<unknown>) => void;
  browserCheckGapMs?: number;
}

export type { MessageView, RunView, SourceView } from "@ai-assistant/api-client";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const RUN_DEADLINE_MS = 6 * 60 * 1000;
/** Runs that use the browser get longer: it is slower, and the person may take it over. */
const BROWSER_RUN_DEADLINE_MS = 25 * 60 * 1000;

const browserDeps = (deps: Deps): BrowserDeps => ({
  sql: deps.sql,
  browser: deps.browser,
  secret: deps.secret,
  now: deps.now,
  checkGapMs: deps.browserCheckGapMs,
});

export { NotFound, Conflict };

function textOf(message: TravilaMessage, type: string): string {
  return (message.content ?? [])
    .filter((p) => p.type === type && p.content)
    .map((p) => p.content!)
    .join("")
    .trim();
}

async function loadChat(sql: Sql, s: Session, chatId: string): Promise<ChatRow> {
  const [chat] = await withUser(
    sql,
    s.userId,
    (tx) => tx<ChatRow[]>`SELECT * FROM chats WHERE id = ${chatId}`,
  );
  if (!chat) throw new NotFound("chat");
  return chat;
}

export async function messageViews(
  sql: Sql,
  s: Session,
  messages: MessageRow[],
): Promise<MessageView[]> {
  const runIds = [...new Set(messages.map((m) => m.run_id).filter((x): x is string => !!x))];
  const sources = runIds.length
    ? await withUser(
        sql,
        s.userId,
        (tx) => tx<
          {
            run_id: string;
            ref_number: number;
            title: string | null;
            url: string;
            site_name: string | null;
            published_at: Date | null;
            injection_flag: boolean;
          }[]
        >`SELECT run_id, ref_number, title, url, site_name, published_at, injection_flag
        FROM sources WHERE run_id = ANY(${runIds}) ORDER BY ref_number`,
      )
    : [];
  const messageIds = messages.map((m) => m.id);
  const [attached, downloaded] = await withUser(
    sql,
    s.userId,
    async (tx) =>
      [
        messageIds.length
          ? await tx<(FileRow & { message_id: string })[]>`
            SELECT a.message_id, f.* FROM attachments a JOIN files f ON f.id = a.file_id
            WHERE a.message_id = ANY(${messageIds}) ORDER BY a.created_at`
          : [],
        runIds.length
          ? await tx<FileRow[]>`
            SELECT * FROM files WHERE run_id = ANY(${runIds}) AND kind = 'browser_download'
            ORDER BY created_at`
          : [],
      ] as const,
  );
  return messages.map((m) => {
    const textPart = m.parts.find(
      (p): p is Extract<MessagePart, { type: "text" }> => p.type === "text",
    );
    const reasoning = m.parts.find((p) => p.type === "reasoning") as { text: string } | undefined;
    // Sources are shown numbered 1, 2, 3 in the order the answer first cites them.
    const display = new Map((textPart?.citations ?? []).map((ref, i) => [ref, i + 1]));
    const text = (textPart?.text ?? "").replace(/\[(\d{1,3})\](?!\()/g, (whole, n: string) =>
      display.has(Number(n)) ? `[${display.get(Number(n))}]` : whole,
    );
    return {
      id: m.id,
      role: m.role,
      text,
      reasoning: reasoning?.text ?? null,
      sources: sources
        .filter(
          (src) => src.run_id === m.run_id && display.has(src.ref_number) && m.role === "assistant",
        )
        .map((src) => ({
          n: display.get(src.ref_number)!,
          title: src.title,
          url: src.url,
          siteName: src.site_name,
          date: src.published_at ? src.published_at.toISOString().slice(0, 10) : null,
          flagged: src.injection_flag,
        }))
        .sort((a, b) => a.n - b.n),
      files: (m.role === "user"
        ? attached.filter((f) => f.message_id === m.id)
        : downloaded.filter((f) => f.run_id === m.run_id)
      ).map(fileView),
      createdAt: new Date(m.created_at).toISOString(),
      runId: m.run_id,
      clientMessageId: m.client_message_id,
    };
  });
}

async function runView(deps: Deps, s: Session, run: RunRow): Promise<RunView> {
  const { sql } = deps;
  let message: MessageView | null = null;
  if (run.status === "completed") {
    const rows = await withUser(
      sql,
      s.userId,
      (tx) => tx<MessageRow[]>`
      SELECT * FROM messages WHERE run_id = ${run.id} AND role = 'assistant' ORDER BY created_at DESC LIMIT 1`,
    );
    message = rows[0] ? ((await messageViews(sql, s, rows))[0] ?? null) : null;
  }
  return {
    id: run.id,
    chatId: run.chat_id,
    status: run.status,
    statusLine: run.status_line,
    error: run.error,
    message,
    browser: TERMINAL.has(run.status)
      ? null
      : await browserViewFor(browserDeps(deps), { userId: s.userId, runId: run.id }),
  };
}

async function updateRun(
  sql: Sql,
  s: Session,
  runId: string,
  fields: Partial<Pick<RunRow, "status" | "status_line" | "error">>,
) {
  const [row] = await withUser(
    sql,
    s.userId,
    (tx) => tx<RunRow[]>`
    UPDATE runs SET
      status = coalesce(${fields.status ?? null}, status),
      status_line = coalesce(${fields.status_line ?? null}, status_line),
      error = coalesce(${fields.error ?? null}, error),
      finished_at = CASE WHEN ${fields.status ?? null}::text IN ('completed', 'failed', 'cancelled') THEN now() ELSE finished_at END
    WHERE id = ${runId} AND status NOT IN ('completed', 'failed', 'cancelled')
    RETURNING *`,
  );
  return row;
}

export type ChatListRow = ChatRow & { last_active_at: Date; active_run_id: string | null };

/**
 * Creates the user's Main chat on first use, and returns all their chats: Main first, then pinned,
 * then the most recently used. "Recently used" is the last message, so renaming or pinning a chat
 * doesn't move it. Each chat says which reply, if any, is still being worked on.
 */
export async function listChats(sql: Sql, s: Session): Promise<ChatListRow[]> {
  return withUser(sql, s.userId, async (tx) => {
    await tx`INSERT INTO chats (user_id, kind, title) VALUES (${s.userId}, 'main', 'Main')
             ON CONFLICT (user_id) WHERE kind = 'main' DO NOTHING`;
    // Archived chats are included; the website shows them only when asked to.
    return tx<ChatListRow[]>`
      SELECT c.*,
        coalesce((SELECT max(m.created_at) FROM messages m WHERE m.chat_id = c.id), c.created_at)
          AS last_active_at,
        (SELECT r.id FROM runs r WHERE r.chat_id = c.id
           AND r.status NOT IN ('completed', 'failed', 'cancelled')
           ORDER BY r.created_at DESC LIMIT 1) AS active_run_id
      FROM chats c
      ORDER BY (c.kind = 'main') DESC, c.pinned DESC, last_active_at DESC, c.created_at DESC`;
  });
}

/** Pins, archives or renames a side chat. Main can't be changed. */
export async function updateChat(
  sql: Sql,
  s: Session,
  chatId: string,
  input: { pinned?: boolean; archived?: boolean; title?: string },
): Promise<ChatRow> {
  return withUser(sql, s.userId, async (tx) => {
    const [chat] = await tx<ChatRow[]>`SELECT * FROM chats WHERE id = ${chatId}`;
    if (!chat) throw new NotFound();
    if (
      chat.kind === "main" &&
      (input.archived || input.pinned !== undefined || input.title !== undefined)
    ) {
      throw new Conflict("Main chat can't be renamed, pinned or archived.");
    }
    const pinned = input.pinned ?? chat.pinned;
    const archived = input.archived === undefined ? chat.archived_at !== null : input.archived;
    const title = input.title === undefined ? chat.title : input.title;
    const [updated] = await tx<ChatRow[]>`
      UPDATE chats SET pinned = ${pinned}, title = ${title},
        archived_at = CASE WHEN ${archived}::boolean THEN coalesce(archived_at, now()) ELSE NULL END
      WHERE id = ${chatId} RETURNING *`;
    return updated!;
  });
}

/** Deletes a side chat with everything in it. Main can't be deleted. */
export async function deleteChat(sql: Sql, s: Session, chatId: string): Promise<void> {
  await withUser(sql, s.userId, async (tx) => {
    const [chat] = await tx<ChatRow[]>`SELECT * FROM chats WHERE id = ${chatId}`;
    if (!chat) throw new NotFound();
    if (chat.kind === "main") throw new Conflict("Main chat can't be deleted.");
    await tx`DELETE FROM chats WHERE id = ${chatId}`;
  });
}

/**
 * Names a side chat after its first message: the first line, cut at a word break so it fits the
 * sidebar. The user can rename it any time.
 */
export function titleFrom(text: string, max = 48): string {
  const line = text.trim().split(/\r?\n/)[0]!.replace(/\s+/g, " ").trim();
  if (line.length <= max) return line;
  const cut = line.slice(0, max + 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : line.slice(0, max)).replace(/[\s,.;:!?-]+$/, "")}…`;
}

export async function createSideChat(
  sql: Sql,
  s: Session,
  input: { title?: string; cleanRoom?: boolean },
) {
  const [chat] = await withUser(
    sql,
    s.userId,
    (tx) => tx<ChatRow[]>`
    INSERT INTO chats (user_id, kind, title, clean_room)
    VALUES (${s.userId}, 'side', ${input.title?.slice(0, 120) || null}, ${input.cleanRoom ?? false})
    RETURNING *`,
  );
  return chat!;
}

export async function getChat(deps: Deps, s: Session, chatId: string) {
  const { sql } = deps;
  const chat = await loadChat(sql, s, chatId);
  const [messages, runs, unanswered] = await withUser(
    sql,
    s.userId,
    async (tx) =>
      [
        await tx<
          MessageRow[]
        >`SELECT * FROM messages WHERE chat_id = ${chatId} ORDER BY created_at, id`,
        await tx<RunRow[]>`SELECT * FROM runs WHERE chat_id = ${chatId}
                       AND status NOT IN ('completed', 'failed', 'cancelled')
                       ORDER BY created_at DESC LIMIT 1`,
        await tx<
          RunRow[]
        >`SELECT * FROM runs WHERE chat_id = ${chatId} AND status IN ('failed', 'cancelled')`,
      ] as const,
  );
  return {
    chat,
    messages: await messageViews(sql, s, messages),
    activeRun: runs[0] ? await runView(deps, s, runs[0]) : null,
    // Questions that got no answer (failed or stopped), so the chat can say so after a reload.
    endedRuns: await Promise.all(unanswered.map((r) => runView(deps, s, r))),
  };
}

function threadInput(chat: ChatRow, s: Session, title: string): CreateThreadInput {
  return {
    title,
    systemPrompt: MAIN_INSTRUCTIONS,
    models: MODELS,
    reasoningEffort: REASONING_EFFORT,
    clientTools: TOOLS,
    timezone: s.timezone,
    memory: !chat.clean_room,
    maxLoops: MAX_LOOPS,
    clientToolTimeoutMs: CLIENT_TOOL_TIMEOUT_MS,
  };
}

/**
 * Saves the user's message (with any files they attached) and starts a Travila run for it.
 * Safe to retry with the same clientMessageId.
 */
export async function sendMessage(
  deps: Deps,
  s: Session,
  chatId: string,
  input: { text: string; clientMessageId: string; fileIds?: string[] },
): Promise<{ message: MessageView; run: RunView }> {
  const { sql, travila } = deps;
  const chat = await loadChat(sql, s, chatId);
  const fileIds = [...new Set(input.fileIds ?? [])];
  let files: FileRow[] = [];

  const created = await withUser(sql, s.userId, async (tx) => {
    const [dupe] = await tx<MessageRow[]>`SELECT * FROM messages
      WHERE chat_id = ${chatId} AND client_message_id = ${input.clientMessageId}`;
    if (dupe) return { duplicate: dupe };
    if (fileIds.length) {
      // Row-level security hides other people's files, so a foreign id simply isn't found.
      files = await tx<
        FileRow[]
      >`SELECT * FROM files WHERE id = ANY(${fileIds}) AND kind = 'upload'`;
      if (files.length !== fileIds.length) throw new NotFound("file");
    }
    const [active] = await tx`SELECT id FROM runs WHERE chat_id = ${chatId}
      AND status NOT IN ('completed', 'failed', 'cancelled')`;
    if (active) throw new Conflict("A reply is still in progress in this chat");
    const [run] = await tx<
      RunRow[]
    >`INSERT INTO runs (user_id, chat_id, status, status_line, model, profile_version, reasoning_effort)
      VALUES (${s.userId}, ${chatId}, 'queued', 'Starting', ${MODELS[0]}, ${PROFILE_VERSION}, ${REASONING_EFFORT})
      RETURNING *`;
    const [message] = await tx<
      MessageRow[]
    >`INSERT INTO messages (user_id, chat_id, role, sender_user_id, parts, run_id, client_message_id)
      VALUES (${s.userId}, ${chatId}, 'user', ${s.userId},
              ${tx.json([{ type: "text", text: input.text }, ...files.map((f) => ({ type: "attachment_ref", fileId: f.id }))] as never)},
              ${run!.id}, ${input.clientMessageId})
      RETURNING *`;
    for (const f of files) {
      await tx`INSERT INTO attachments (user_id, message_id, file_id)
               VALUES (${s.userId}, ${message!.id}, ${f.id})`;
    }
    if (chat.kind === "side" && !chat.title) {
      await tx`UPDATE chats SET title = ${titleFrom(input.text)} WHERE id = ${chatId}`;
    } else {
      await tx`UPDATE chats SET updated_at = now() WHERE id = ${chatId}`;
    }
    return { run: run!, message: message! };
  });

  if ("duplicate" in created) {
    const dupe = created.duplicate!;
    const [run] = await withUser(
      sql,
      s.userId,
      (tx) => tx<RunRow[]>`SELECT * FROM runs WHERE id = ${dupe.run_id}`,
    );
    return { message: (await messageViews(sql, s, [dupe]))[0]!, run: await runView(deps, s, run!) };
  }

  const { run, message } = created;
  try {
    let threadId = chat.travila_thread_id;
    const config = threadInput(
      chat,
      s,
      chat.kind === "main" ? "Main" : (chat.title ?? titleFrom(input.text)),
    );
    if (!threadId) {
      threadId = await travila.createThread(s.travilaUserId, config);
      await withUser(
        sql,
        s.userId,
        (tx) => tx`UPDATE chats SET travila_thread_id = ${threadId},
                   travila_profile_version = ${PROFILE_VERSION} WHERE id = ${chatId}`,
      );
    } else if (chat.travila_profile_version !== PROFILE_VERSION) {
      // A chat started before the assistant's instructions or tools changed gets the new ones.
      await travila.updateThreadConfig(s.travilaUserId, threadId, config);
      await withUser(
        sql,
        s.userId,
        (tx) =>
          tx`UPDATE chats SET travila_profile_version = ${PROFILE_VERSION} WHERE id = ${chatId}`,
      );
    }
    const travilaRunId = await travila.sendMessage(
      s.travilaUserId,
      threadId,
      input.text +
        attachmentNote(
          files,
          await fileTexts(
            sql,
            s.userId,
            files.map((f) => f.id),
          ),
        ),
    );
    await withUser(
      sql,
      s.userId,
      (tx) => tx`UPDATE runs SET travila_run_id = ${travilaRunId}, status = 'running',
      status_line = 'Thinking', started_at = now() WHERE id = ${run.id}`,
    );
  } catch (err) {
    await updateRun(sql, s, run.id, {
      status: "failed",
      error:
        `Couldn't reach the assistant service. ${err instanceof Error ? err.message.slice(0, 200) : ""}`.trim(),
    });
  }
  const [fresh] = await withUser(
    sql,
    s.userId,
    (tx) => tx<RunRow[]>`SELECT * FROM runs WHERE id = ${run.id}`,
  );
  return {
    message: (await messageViews(sql, s, [message]))[0]!,
    run: await runView(deps, s, fresh!),
  };
}

async function loadRun(sql: Sql, s: Session, runId: string): Promise<RunRow> {
  const [run] = await withUser(
    sql,
    s.userId,
    (tx) => tx<RunRow[]>`SELECT * FROM runs WHERE id = ${runId}`,
  );
  if (!run) throw new NotFound("run");
  return run;
}

/** One step of the run: called on every poll. */
export async function advanceRun(deps: Deps, s: Session, runId: string): Promise<RunView> {
  const { sql, travila } = deps;
  const now = deps.now?.() ?? new Date();
  let run = await loadRun(sql, s, runId);
  if (TERMINAL.has(run.status) || !run.travila_run_id) return runView(deps, s, run);
  const chat = await loadChat(sql, s, run.chat_id);
  const threadId = chat.travila_thread_id!;

  const state = await travila.getState(s.travilaUserId, threadId);
  const active = !!state.activeRunning && state.activeRunId === run.travila_run_id;

  if (active) {
    const pending = (await travila.listPendingClientTools(s.travilaUserId, threadId)).filter(
      (c) => c.isClientTool !== false,
    );
    if (pending.length) {
      await updateRun(sql, s, run.id, {
        status: "awaiting_tools",
        status_line: statusLineFor(pending),
      });
      const ctx = { sql, userId: s.userId, travilaUserId: s.travilaUserId, runId: run.id };
      // A browse call that has started is checked on rather than run again.
      const browsing = (
        await Promise.all(
          pending
            .filter((c) => c.name === "browse")
            .map(async (call) => ({ call, session: await findBrowserSession(sql, ctx, call.id) })),
        )
      ).filter((b) => b.session !== null);
      for (const { call, session } of browsing) {
        const work = checkBrowse(deps, s, run, threadId, call, session!).catch((err) =>
          console.error(`run ${run.id}: browse check failed`, err),
        );
        (deps.defer ?? ((p: Promise<unknown>) => void p))(work);
      }
      const started = new Set(browsing.map((b) => b.call.id));
      const claimed = (
        await Promise.all(
          pending
            .filter((call) => !started.has(call.id))
            .map(async (call) => ({ call, id: await claimToolCall(ctx, call) })),
        )
      ).filter((c): c is { call: typeof c.call; id: string } => c.id !== null);
      if (claimed.length) {
        // Tools run in the background so this poll can return right away with the status line
        // ("Searching: ..."); later polls see the claim and don't run them again.
        const work = (async () => {
          const results = (
            await Promise.all(
              claimed.map(async ({ call, id }) => ({
                toolCallId: call.id,
                toolName: call.name,
                resultJson: await runTool(ctx, deps, id, call),
              })),
            )
          ).filter(
            (r): r is typeof r & { resultJson: Record<string, unknown> } => r.resultJson !== null,
          );
          // Browse only started; a later poll sends its result.
          if (!results.length) return;
          // The user may have pressed Stop while the tools ran.
          const latest = await loadRun(sql, s, runId);
          if (latest.status === "cancelled") return;
          await travila.submitClientToolResults(
            s.travilaUserId,
            threadId,
            latest.travila_run_id!,
            results,
          );
          await updateRun(sql, s, run.id, {
            status: "running",
            status_line: doneLineFor(claimed.map((c) => c.call)),
          });
        })().catch((err) => console.error(`run ${run.id}: tool step failed`, err));
        (deps.defer ?? ((p: Promise<unknown>) => void p))(work);
      }
    } else {
      await updateRun(sql, s, run.id, { status: "running" });
    }
    if (run.started_at) {
      const [browsed] = await withUser(
        sql,
        s.userId,
        (tx) => tx`SELECT 1 FROM browser_sessions WHERE run_id = ${run.id} LIMIT 1`,
      );
      const deadline = browsed ? BROWSER_RUN_DEADLINE_MS : RUN_DEADLINE_MS;
      if (now.getTime() - new Date(run.started_at).getTime() > deadline) {
        await stopBrowsing(browserDeps(deps), { userId: s.userId, runId: run.id });
        await updateRun(sql, s, run.id, {
          status: "failed",
          error: "This took too long, so I stopped. Try asking again.",
        });
      }
    }
    return runView(deps, s, await loadRun(sql, s, runId));
  }

  const runMessages = (state.messageHistory ?? []).filter(
    (m) => m.generatedBy === run.travila_run_id && m.role === "ROLE_ASSISTANT",
  );
  const last = runMessages.at(-1);
  const answer = last ? textOf(last, "CONTENT_PART_TYPE_TEXT") : "";

  if (!last || !answer) {
    const age = run.started_at ? now.getTime() - new Date(run.started_at).getTime() : 0;
    // Just after sending, Travila may not show the run as active yet.
    const settling =
      !state.lastRunStatus || (age < 15000 && state.lastRunStatus !== "AGENT_STATUS_FAILED");
    if (settling && age < RUN_DEADLINE_MS) return runView(deps, s, run);
    await updateRun(sql, s, run.id, {
      status: "failed",
      error:
        state.lastRunStatus === "AGENT_STATUS_FAILED"
          ? "The model couldn't finish this answer. Try asking again."
          : "No answer came back. Try asking again.",
    });
    return runView(deps, s, await loadRun(sql, s, runId));
  }

  return finalizeRun(deps, s, run, runMessages);
}

/** Checks on a running browse call and, once it is finished, sends its result to Travila. */
async function checkBrowse(
  deps: Deps,
  s: Session,
  run: RunRow,
  threadId: string,
  call: TravilaToolCall,
  session: NonNullable<Awaited<ReturnType<typeof findBrowserSession>>>,
) {
  const { sql } = deps;
  const ctx = { userId: s.userId, runId: run.id };
  const result = await advanceBrowse(
    browserDeps(deps),
    ctx,
    session,
    async (url, title, injection) => {
      const [n] = await registerSources(
        { sql, userId: s.userId, travilaUserId: s.travilaUserId, runId: run.id },
        session.tool_call_id!,
        [{ url, title, origin: "browse", injection }],
      );
      return n ?? null;
    },
  );
  if (!result) return;
  const latest = await loadRun(sql, s, run.id);
  if (TERMINAL.has(latest.status)) return;
  await finishToolCall(
    { sql, userId: s.userId, travilaUserId: s.travilaUserId, runId: run.id },
    session.tool_call_id!,
    {
      status: "error" in result ? "failed" : "succeeded",
      decision: "allow",
      reason: typeof result.error === "string" ? result.error.slice(0, 500) : undefined,
    },
  );
  await deps.travila.submitClientToolResults(s.travilaUserId, threadId, latest.travila_run_id!, [
    { toolCallId: call.id, toolName: call.name, resultJson: result },
  ]);
  await updateRun(sql, s, run.id, { status: "running", status_line: doneLineFor([call]) });
}

async function finalizeRun(
  deps: Deps,
  s: Session,
  run: RunRow,
  runMessages: TravilaMessage[],
): Promise<RunView> {
  const { sql } = deps;
  const last = runMessages.at(-1)!;
  const reasoning = runMessages
    .map((m) => textOf(m, "CONTENT_PART_TYPE_REASONING"))
    .filter(Boolean)
    .join("\n\n");

  await withUser(sql, s.userId, async (tx) => {
    const sources = await tx<{ ref_number: number; url: string }[]>`
      SELECT ref_number, url FROM sources WHERE run_id = ${run.id}`;
    const grounded = groundAnswer(
      textOf(last, "CONTENT_PART_TYPE_TEXT"),
      new Map(sources.map((r) => [r.ref_number, r.url])),
    );
    const usage = runMessages.reduce<Record<string, number>>((acc, m) => {
      for (const [k, v] of Object.entries(m.usage ?? {}))
        if (typeof v === "number") acc[k] = (acc[k] ?? 0) + v;
      return acc;
    }, {});
    // Only the first poll to get here saves the answer.
    const [claimed] = await tx`
      UPDATE runs SET status = 'completed', status_line = NULL, finished_at = now(),
        model = ${last.generationContext?.model ?? last.model ?? run.model},
        usage = ${tx.json({ ...usage, removedUrls: grounded.removedUrls } as never)}
      WHERE id = ${run.id} AND status NOT IN ('completed', 'failed', 'cancelled') RETURNING id`;
    if (!claimed) return;
    if (grounded.removedUrls.length) {
      console.warn(
        `run ${run.id}: removed ${grounded.removedUrls.length} URL(s) not found in sources`,
      );
    }
    const parts: MessagePart[] = [{ type: "text", text: grounded.text, citations: grounded.cited }];
    if (reasoning) parts.push({ type: "reasoning", text: reasoning });
    await tx`INSERT INTO messages (user_id, chat_id, role, parts, run_id, travila_message_id, origin)
      VALUES (${s.userId}, ${run.chat_id}, 'assistant', ${tx.json(parts as never)}, ${run.id},
              ${last.messageId ?? null}, 'reply')`;
    await tx`UPDATE chats SET updated_at = now() WHERE id = ${run.chat_id}`;
  });
  return runView(deps, s, await loadRun(sql, s, run.id));
}

/** Stop button: the run is marked stopped at once; any tool the model is waiting on gets a "stopped" result. */
export async function stopRun(deps: Deps, s: Session, runId: string): Promise<RunView> {
  const { sql, travila } = deps;
  const run = await loadRun(sql, s, runId);
  if (TERMINAL.has(run.status)) return runView(deps, s, run);
  await updateRun(sql, s, run.id, { status: "cancelled", status_line: "Stopped" });
  await stopBrowsing(browserDeps(deps), { userId: s.userId, runId: run.id });
  const chat = await loadChat(sql, s, run.chat_id);
  if (chat.travila_thread_id && run.travila_run_id) {
    try {
      const pending = await travila.listPendingClientTools(s.travilaUserId, chat.travila_thread_id);
      if (pending.length) {
        await travila.submitClientToolResults(
          s.travilaUserId,
          chat.travila_thread_id,
          run.travila_run_id,
          pending.map((c) => ({
            toolCallId: c.id,
            toolName: c.name,
            resultJson: { error: "The user stopped this request. Stop now." },
          })),
        );
      }
    } catch {
      // Best effort: the next message cancels the run anyway.
    }
  }
  return runView(deps, s, await loadRun(sql, s, runId));
}
