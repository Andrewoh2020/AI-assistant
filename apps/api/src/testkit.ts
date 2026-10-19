// Test helpers: a disposable database, a scripted fake of Travila and a fake search engine.
import { connect, type Sql } from "@ai-assistant/db";
import { migrateUp } from "@ai-assistant/db/migrate";
import type { FetchedPage, SearchBackend, SearchResult } from "./search.js";
import type {
  CreateThreadInput,
  Travila,
  TravilaMessage,
  TravilaState,
  TravilaToolCall,
} from "./travila.js";

/** A separate database for API tests, so they never collide with the db package's tests. */
export async function testDatabase(): Promise<Sql | null> {
  const base = process.env.DATABASE_URL;
  if (!base) return null;
  const url = new URL(base);
  const name = `${url.pathname.slice(1)}_api`;
  const admin = connect(base);
  const [exists] = await admin`SELECT 1 FROM pg_database WHERE datname = ${name}`;
  if (!exists) await admin.unsafe(`CREATE DATABASE "${name}"`);
  await admin.end();
  url.pathname = `/${name}`;
  const sql = connect(url.toString());
  await migrateUp(sql);
  return sql;
}

type Step =
  | { tools: { name: string; args: Record<string, unknown> }[] }
  | { answer: string; reasoning?: string };

interface FakeThread {
  userId: string;
  input: CreateThreadInput;
  history: TravilaMessage[];
  runId: string | null;
  running: boolean;
  pending: TravilaToolCall[];
  script: Step[];
  lastStatus?: string;
}

/**
 * Plays a scripted conversation: each user message consumes the next script, which can ask for
 * tool calls (the run then waits for results) and finally gives an answer.
 */
export class FakeTravila implements Travila {
  threads = new Map<string, FakeThread>();
  scripts: Step[][] = [];
  submitted: {
    threadId: string;
    results: { toolCallId: string; toolName: string; resultJson: unknown }[];
  }[] = [];
  sends = 0;
  memories: { id: string; memory: string }[] = [];
  private seq = 0;

  private id(prefix: string) {
    return `${prefix}_${++this.seq}_${crypto.randomUUID().slice(0, 8)}`;
  }

  private thread(userId: string, threadId: string): FakeThread {
    const t = this.threads.get(threadId);
    // Travila scopes threads to the X-On-Behalf-Of user.
    if (!t || t.userId !== userId) throw new Error("thread not found for this user");
    return t;
  }

  async createThread(userId: string, input: CreateThreadInput) {
    const id = this.id("thread");
    this.threads.set(id, {
      userId,
      input,
      history: [],
      runId: null,
      running: false,
      pending: [],
      script: [],
    });
    return id;
  }

  async sendMessage(userId: string, threadId: string, text: string) {
    const t = this.thread(userId, threadId);
    this.sends++;
    t.runId = this.id("run");
    t.running = true;
    t.script = [...(this.scripts.shift() ?? [{ answer: "ok" }])];
    t.history.push({
      role: "ROLE_USER",
      content: [{ type: "CONTENT_PART_TYPE_TEXT", content: text }],
    });
    this.step(t);
    return t.runId;
  }

  private step(t: FakeThread) {
    const next = t.script.shift();
    if (!next) {
      t.running = false;
      t.lastStatus = "AGENT_STATUS_FAILED";
      return;
    }
    if ("tools" in next) {
      t.pending = next.tools.map((c) => ({
        id: this.id("call"),
        name: c.name,
        argumentsJson: c.args,
        isClientTool: true,
      }));
      t.history.push({
        role: "ROLE_ASSISTANT",
        generatedBy: t.runId!,
        toolCalls: t.pending,
        finishReason: "tool_calls",
        content: [],
      });
      return;
    }
    const content = [{ type: "CONTENT_PART_TYPE_TEXT", content: next.answer }];
    if (next.reasoning)
      content.unshift({ type: "CONTENT_PART_TYPE_REASONING", content: next.reasoning });
    t.history.push({
      role: "ROLE_ASSISTANT",
      generatedBy: t.runId!,
      content,
      finishReason: "stop",
      messageId: this.id("msg"),
      model: "deepseek/fake",
    });
    t.running = false;
    t.lastStatus = "AGENT_STATUS_COMPLETED";
  }

  async getState(userId: string, threadId: string): Promise<TravilaState> {
    const t = this.thread(userId, threadId);
    return {
      messageHistory: t.history,
      activeRunId: t.runId ?? undefined,
      activeRunning: t.running,
      lastRunStatus: t.lastStatus,
    };
  }

  async listPendingClientTools(userId: string, threadId: string) {
    return this.thread(userId, threadId).pending;
  }

  async submitClientToolResults(
    userId: string,
    threadId: string,
    runId: string,
    results: { toolCallId: string; toolName: string; resultJson: unknown }[],
  ) {
    const t = this.thread(userId, threadId);
    if (runId !== t.runId) throw new Error("wrong run");
    this.submitted.push({ threadId, results });
    t.pending = [];
    this.step(t);
  }

  async searchMemories() {
    return this.memories;
  }
}

export class FakeSearch implements SearchBackend {
  results: SearchResult[] = [];
  pages = new Map<string, FetchedPage>();
  queries: string[] = [];
  fetched: string[] = [];

  async search(query: string) {
    this.queries.push(query);
    return this.results;
  }

  async fetch(url: string) {
    this.fetched.push(url);
    const page = this.pages.get(url);
    if (!page) throw new Error("404");
    return page;
  }
}
