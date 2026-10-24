// Test helpers: a disposable database, a scripted fake of Travila and a fake search engine.
import { connect, type Sql } from "@ai-assistant/db";
import { migrateUp } from "@ai-assistant/db/migrate";
import type {
  BrowserUse,
  BuEvent,
  BuFile,
  BuRun,
  BuRunStatus,
  CreateRunInput,
} from "./browseruse.js";
import type { FetchedPage, SearchBackend, SearchResult } from "./search.js";
import type {
  CreateThreadInput,
  InlineImage,
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
  | { answer: string; reasoning?: string; cutOff?: boolean };

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

  configUpdates: { threadId: string; input: CreateThreadInput }[] = [];

  async updateThreadConfig(userId: string, threadId: string, input: CreateThreadInput) {
    const t = this.thread(userId, threadId);
    t.input = input;
    this.configUpdates.push({ threadId, input });
  }

  images: InlineImage[][] = [];

  async sendMessage(userId: string, threadId: string, text: string, images: InlineImage[] = []) {
    const t = this.thread(userId, threadId);
    this.sends++;
    this.images.push(images);
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
      // A cut-off reply: the model's connection broke, but Travila still ends the run "completed".
      finishReason: next.cutOff ? "error" : "stop",
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

interface FakeBrowseScript {
  /** How many status checks say "running" before the run ends. */
  polls?: number;
  status?: "completed" | "failed";
  result?: string;
  /** Files the agent "saves" into outputs/. */
  outputs?: { name: string; data: string }[];
}

/** A scripted Browser Use: each run plays the next script. Files live in memory. */
export class FakeBrowserUse implements BrowserUse {
  scripts: FakeBrowseScript[] = [];
  runs = new Map<
    string,
    {
      input: CreateRunInput;
      script: FakeBrowseScript;
      checks: number;
      cancelled: boolean;
      sessionId: string;
      workspaceId: string;
    }
  >();
  workspaces = new Map<string, Map<string, { data: Uint8Array; lastModified: string }>>();
  profiles: { name: string; userId: string; id: string }[] = [];
  stopped: string[] = [];
  private clock = 0;

  async createProfile(name: string, userId: string) {
    const id = crypto.randomUUID();
    this.profiles.push({ name, userId, id });
    return id;
  }

  async createWorkspace() {
    const id = crypto.randomUUID();
    this.workspaces.set(id, new Map());
    return id;
  }

  private put(workspaceId: string, path: string, data: Uint8Array) {
    this.workspaces.get(workspaceId)!.set(path, {
      data,
      lastModified: new Date(Date.UTC(2026, 0, 1, 0, 0, ++this.clock)).toISOString(),
    });
  }

  async upload(workspaceId: string, file: { name: string; data: Uint8Array }) {
    const path = `uploads/${file.name}`;
    this.put(workspaceId, path, new Uint8Array(file.data));
    return path;
  }

  async createRun(input: CreateRunInput) {
    const id = crypto.randomUUID();
    const previous = input.sessionId
      ? [...this.runs.values()].find((r) => r.sessionId === input.sessionId)
      : undefined;
    const sessionId = input.sessionId ?? crypto.randomUUID();
    const workspaceId =
      input.workspaceId ?? previous?.workspaceId ?? (await this.createWorkspace());
    const script = this.scripts.shift() ?? { result: "Done." };
    this.runs.set(id, { input, script, checks: 0, cancelled: false, sessionId, workspaceId });
    return { id, sessionId, workspaceId };
  }

  async runStatus(runId: string): Promise<BuRunStatus> {
    const run = this.runs.get(runId)!;
    if (run.cancelled) return "cancelled";
    if (run.checks++ < (run.script.polls ?? 0)) return "running";
    const status = run.script.status ?? "completed";
    if (status === "completed" && run.script.outputs) {
      for (const o of run.script.outputs) {
        this.put(run.workspaceId, `outputs/${o.name}`, new TextEncoder().encode(o.data));
      }
      run.script.outputs = undefined;
    }
    return status;
  }

  async getRun(runId: string): Promise<BuRun> {
    const run = this.runs.get(runId)!;
    return {
      id: runId,
      status: run.cancelled ? "cancelled" : (run.script.status ?? "completed"),
      sessionId: run.sessionId,
      workspaceId: run.workspaceId,
      result: run.script.status === "failed" ? null : (run.script.result ?? "Done."),
      error: run.script.status === "failed" ? "agent crashed" : null,
      totalCostUsd: "0.01",
    };
  }

  async runEvents(runId: string, after: number) {
    const run = this.runs.get(runId)!;
    const events: BuEvent[] = [
      {
        id: 1,
        type: "browser.ready",
        data: {
          live_view_url: `https://live.example/${run.sessionId}`,
          browser_session_id: `browser-${run.sessionId}`,
        },
      },
      {
        id: 2,
        type: "core.event",
        data: { part: { type: "text", text: "Opening the page now." } },
      },
    ].filter((e) => e.id > after);
    return { events, nextAfter: events.at(-1)?.id ?? after, hasMore: false };
  }

  async cancelRun(runId: string) {
    this.runs.get(runId)!.cancelled = true;
  }

  async stopBrowser(browserId: string) {
    this.stopped.push(browserId);
  }

  async listFiles(workspaceId: string, prefix: string, urls: boolean): Promise<BuFile[]> {
    return [...(this.workspaces.get(workspaceId) ?? new Map()).entries()]
      .filter(([path]) => path.startsWith(prefix))
      .map(([path, f]) => ({
        path,
        size: f.data.byteLength,
        lastModified: f.lastModified,
        url: urls ? `fake://${workspaceId}/${path}` : null,
      }));
  }

  async download(url: string) {
    const [, workspaceId, ...rest] = url.replace("fake://", "/").split("/");
    return this.workspaces.get(workspaceId!)!.get(rest.join("/"))!.data;
  }

  /** Pictures taken, by browser id. A stopped browser gives none, like the real one. */
  captures: string[] = [];

  async capture(browserId: string) {
    if (this.stopped.includes(browserId)) return null;
    this.captures.push(browserId);
    return {
      jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      tabs: [
        { url: "about:blank", title: "about:blank", active: false },
        { url: "https://www.example.com/page", title: "Example page", active: true },
      ],
    };
  }
}
