import {
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
  type MessagePart,
  type MessageRow,
  type RunRow,
  type Sql,
} from "@ai-assistant/db";
import type { MessageView, RunView } from "@ai-assistant/api-client";
import { groundAnswer } from "./citations.js";
import { claimToolCall, doneLineFor, runTool, statusLineFor, type ToolDeps } from "./tools.js";
import type { Travila, TravilaMessage } from "./travila.js";

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
}

export type { MessageView, RunView, SourceView } from "@ai-assistant/api-client";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const RUN_DEADLINE_MS = 6 * 60 * 1000;

export class NotFound extends Error {}
export class Conflict extends Error {}

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
      createdAt: new Date(m.created_at).toISOString(),
      runId: m.run_id,
      clientMessageId: m.client_message_id,
    };
  });
}

async function runView(sql: Sql, s: Session, run: RunRow): Promise<RunView> {
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

/** Creates the user's Main chat on first use, and returns all their open chats. */
export async function listChats(sql: Sql, s: Session): Promise<ChatRow[]> {
  return withUser(sql, s.userId, async (tx) => {
    await tx`INSERT INTO chats (user_id, kind, title) VALUES (${s.userId}, 'main', 'Main')
             ON CONFLICT (user_id) WHERE kind = 'main' DO NOTHING`;
    // Archived chats are included; the website shows them only when asked to.
    return tx<ChatRow[]>`SELECT * FROM chats
                         ORDER BY (kind = 'main') DESC, pinned DESC, updated_at DESC`;
  });
}

/** Pins or archives a side chat. Main can't be archived. */
export async function updateChat(
  sql: Sql,
  s: Session,
  chatId: string,
  input: { pinned?: boolean; archived?: boolean },
): Promise<ChatRow> {
  return withUser(sql, s.userId, async (tx) => {
    const [chat] = await tx<ChatRow[]>`SELECT * FROM chats WHERE id = ${chatId}`;
    if (!chat) throw new NotFound();
    if (chat.kind === "main" && (input.archived || input.pinned !== undefined)) {
      throw new Conflict("Main chat can't be pinned or archived.");
    }
    const pinned = input.pinned ?? chat.pinned;
    const archived = input.archived === undefined ? chat.archived_at !== null : input.archived;
    const [updated] = await tx<ChatRow[]>`
      UPDATE chats SET pinned = ${pinned},
        archived_at = CASE WHEN ${archived}::boolean THEN coalesce(archived_at, now()) ELSE NULL END
      WHERE id = ${chatId} RETURNING *`;
    return updated!;
  });
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

export async function getChat(sql: Sql, s: Session, chatId: string) {
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
    activeRun: runs[0] ? await runView(sql, s, runs[0]) : null,
    // Questions that got no answer (failed or stopped), so the chat can say so after a reload.
    endedRuns: await Promise.all(unanswered.map((r) => runView(sql, s, r))),
  };
}

/** Saves the user's message and starts a Travila run for it. Safe to retry with the same clientMessageId. */
export async function sendMessage(
  deps: Deps,
  s: Session,
  chatId: string,
  input: { text: string; clientMessageId: string },
): Promise<{ message: MessageView; run: RunView }> {
  const { sql, travila } = deps;
  const chat = await loadChat(sql, s, chatId);

  const created = await withUser(sql, s.userId, async (tx) => {
    const [dupe] = await tx<MessageRow[]>`SELECT * FROM messages
      WHERE chat_id = ${chatId} AND client_message_id = ${input.clientMessageId}`;
    if (dupe) return { duplicate: dupe };
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
              ${tx.json([{ type: "text", text: input.text }] as never)}, ${run!.id}, ${input.clientMessageId})
      RETURNING *`;
    if (chat.kind === "side" && !chat.title) {
      await tx`UPDATE chats SET title = ${input.text.slice(0, 60)} WHERE id = ${chatId}`;
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
    return { message: (await messageViews(sql, s, [dupe]))[0]!, run: await runView(sql, s, run!) };
  }

  const { run, message } = created;
  try {
    let threadId = chat.travila_thread_id;
    if (!threadId) {
      threadId = await travila.createThread(s.travilaUserId, {
        title: chat.kind === "main" ? "Main" : (chat.title ?? input.text.slice(0, 60)),
        systemPrompt: MAIN_INSTRUCTIONS,
        models: MODELS,
        reasoningEffort: REASONING_EFFORT,
        clientTools: TOOLS,
        timezone: s.timezone,
        memory: !chat.clean_room,
        maxLoops: MAX_LOOPS,
      });
      await withUser(
        sql,
        s.userId,
        (tx) => tx`UPDATE chats SET travila_thread_id = ${threadId} WHERE id = ${chatId}`,
      );
    }
    const travilaRunId = await travila.sendMessage(s.travilaUserId, threadId, input.text);
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
    run: await runView(sql, s, fresh!),
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
  if (TERMINAL.has(run.status) || !run.travila_run_id) return runView(sql, s, run);
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
      const claimed = (
        await Promise.all(
          pending.map(async (call) => ({ call, id: await claimToolCall(ctx, call) })),
        )
      ).filter((c): c is { call: typeof c.call; id: string } => c.id !== null);
      if (claimed.length) {
        // Tools run in the background so this poll can return right away with the status line
        // ("Searching: ..."); later polls see the claim and don't run them again.
        const work = (async () => {
          const results = await Promise.all(
            claimed.map(async ({ call, id }) => ({
              toolCallId: call.id,
              toolName: call.name,
              resultJson: await runTool(ctx, deps, id, call),
            })),
          );
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
    if (run.started_at && now.getTime() - new Date(run.started_at).getTime() > RUN_DEADLINE_MS) {
      await updateRun(sql, s, run.id, {
        status: "failed",
        error: "This took too long, so I stopped. Try asking again.",
      });
    }
    return runView(sql, s, await loadRun(sql, s, runId));
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
    if (settling && age < RUN_DEADLINE_MS) return runView(sql, s, run);
    await updateRun(sql, s, run.id, {
      status: "failed",
      error:
        state.lastRunStatus === "AGENT_STATUS_FAILED"
          ? "The model couldn't finish this answer. Try asking again."
          : "No answer came back. Try asking again.",
    });
    return runView(sql, s, await loadRun(sql, s, runId));
  }

  return finalizeRun(deps, s, run, runMessages);
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
  return runView(sql, s, await loadRun(sql, s, run.id));
}

/** Stop button: the run is marked stopped at once; any tool the model is waiting on gets a "stopped" result. */
export async function stopRun(deps: Deps, s: Session, runId: string): Promise<RunView> {
  const { sql, travila } = deps;
  const run = await loadRun(sql, s, runId);
  if (TERMINAL.has(run.status)) return runView(sql, s, run);
  await updateRun(sql, s, run.id, { status: "cancelled", status_line: "Stopped" });
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
  return runView(sql, s, await loadRun(sql, s, runId));
}
