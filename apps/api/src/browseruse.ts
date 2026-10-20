import { HttpError } from "./http.js";

/**
 * Browser Use (API v4): a hosted browser agent. We give it a task; it drives a real cloud browser
 * and reports back. Each person has their own profile (cookies, sign-ins) and workspace (files).
 * The key goes in X-Browser-Use-API-Key; in the cloud environment the network proxy adds it.
 */

export type BuRunStatus =
  "queued" | "dispatching" | "running" | "completed" | "failed" | "cancelled";

export interface BuRun {
  id: string;
  status: BuRunStatus;
  sessionId: string;
  workspaceId: string | null;
  result: string | null;
  error: string | null;
  totalCostUsd?: string;
}

export interface BuEvent {
  id: number;
  type: string;
  data: Record<string, unknown>;
}

export interface BuFile {
  path: string;
  size: number;
  lastModified: string;
  url?: string | null;
}

export interface CreateRunInput {
  task: string;
  sessionId?: string;
  workspaceId?: string;
  profileId?: string;
  maxCostUsd: number;
  keepAlive: number;
}

export interface BrowserUse {
  createProfile(name: string, userId: string): Promise<string>;
  createWorkspace(name: string): Promise<string>;
  /** Puts a file under uploads/ in the workspace and returns its path there. */
  upload(
    workspaceId: string,
    file: { name: string; contentType: string; data: Uint8Array },
  ): Promise<string>;
  createRun(input: CreateRunInput): Promise<{ id: string; sessionId: string; workspaceId: string }>;
  runStatus(runId: string): Promise<BuRunStatus>;
  getRun(runId: string): Promise<BuRun>;
  runEvents(
    runId: string,
    after: number,
  ): Promise<{ events: BuEvent[]; nextAfter: number | null; hasMore: boolean }>;
  cancelRun(runId: string): Promise<void>;
  stopBrowser(browserId: string): Promise<void>;
  /** Files in the workspace under `prefix`. With urls, each has a download link valid for 60 seconds. */
  listFiles(workspaceId: string, prefix: string, urls: boolean): Promise<BuFile[]>;
  download(url: string, maxBytes: number): Promise<Uint8Array>;
}

const TERMINAL = new Set<BuRunStatus>(["completed", "failed", "cancelled"]);
export const isTerminal = (s: BuRunStatus) => TERMINAL.has(s);

export class BrowserUseHttp implements BrowserUse {
  constructor(
    private readonly base: string,
    private readonly apiKey: string,
  ) {}

  private async call<T>(
    method: string,
    path: string,
    body?: unknown,
    { retries = 2, timeoutMs = 30000 } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.apiKey) headers["X-Browser-Use-API-Key"] = this.apiKey;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${this.base}/api/v4${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      if (res.ok) return (text ? JSON.parse(text) : {}) as T;
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= retries) throw new HttpError(res.status, text, "Browser Use");
      const wait = Number(res.headers.get("retry-after")) * 1000 || 500 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, Math.min(wait, 4000)));
    }
  }

  async createProfile(name: string, userId: string) {
    return (await this.call<{ id: string }>("POST", "/profiles", { name, userId })).id;
  }

  async createWorkspace(name: string) {
    return (await this.call<{ id: string }>("POST", "/workspaces", { name })).id;
  }

  async upload(workspaceId: string, file: { name: string; contentType: string; data: Uint8Array }) {
    const res = await this.call<{ files: { path: string; uploadUrl: string }[] }>(
      "POST",
      `/workspaces/${workspaceId}/files/upload`,
      { files: [{ name: file.name, contentType: file.contentType, size: file.data.byteLength }] },
    );
    const target = res.files[0]!;
    // The presigned URL is pinned to this exact type and size.
    const put = await fetch(target.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": file.contentType },
      body: file.data,
      signal: AbortSignal.timeout(120000),
    });
    if (!put.ok) throw new HttpError(put.status, await put.text(), "Browser Use upload");
    return target.path;
  }

  async createRun(input: CreateRunInput) {
    // Never retried: a lost response doesn't mean the run didn't start (and it costs money).
    return this.call<{ id: string; sessionId: string; workspaceId: string }>(
      "POST",
      "/runs",
      {
        task: input.task,
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        browserSettings: input.profileId ? { profileId: input.profileId } : undefined,
        maxCostUsd: input.maxCostUsd,
        keepAlive: input.keepAlive,
      },
      { retries: 0 },
    );
  }

  async runStatus(runId: string) {
    return (await this.call<{ status: BuRunStatus }>("GET", `/runs/${runId}/status`)).status;
  }

  getRun(runId: string) {
    return this.call<BuRun>("GET", `/runs/${runId}`);
  }

  runEvents(runId: string, after: number) {
    return this.call<{ events: BuEvent[]; nextAfter: number | null; hasMore: boolean }>(
      "GET",
      `/runs/${runId}/events?after=${after}&limit=200`,
    );
  }

  async cancelRun(runId: string) {
    await this.call("POST", `/runs/${runId}/cancel`, {});
  }

  async stopBrowser(browserId: string) {
    await this.call("PATCH", `/browsers/${browserId}`, { action: "stop" });
  }

  async listFiles(workspaceId: string, prefix: string, urls: boolean) {
    const files: BuFile[] = [];
    let cursor: string | null = null;
    do {
      const q = new URLSearchParams({ prefix, limit: "100", includeUrls: String(urls) });
      if (cursor) q.set("cursor", cursor);
      const page: { files: BuFile[]; nextCursor?: string | null; hasMore?: boolean } =
        await this.call("GET", `/workspaces/${workspaceId}/files?${q}`);
      files.push(...page.files);
      cursor = page.hasMore ? (page.nextCursor ?? null) : null;
    } while (cursor && files.length < 500);
    return files;
  }

  async download(url: string, maxBytes: number) {
    const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new HttpError(res.status, await res.text(), "Browser Use download");
    const length = Number(res.headers.get("content-length"));
    if (length > maxBytes) throw new Error(`File is larger than ${maxBytes} bytes`);
    const data = new Uint8Array(await res.arrayBuffer());
    if (data.byteLength > maxBytes) throw new Error(`File is larger than ${maxBytes} bytes`);
    return data;
  }
}
