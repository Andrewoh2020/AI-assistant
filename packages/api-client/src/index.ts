/**
 * The API's request and response shapes, plus a small client. Shared by the web app now and the
 * Expo app later, so both talk to the backend the same way.
 */

export type RunStatus =
  "queued" | "running" | "awaiting_tools" | "completed" | "failed" | "cancelled";

export interface SourceView {
  n: number;
  title: string | null;
  url: string;
  siteName: string | null;
  date: string | null;
  /** The page contained text that tried to give the assistant instructions. */
  flagged: boolean;
}

export interface MessageView {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  reasoning: string | null;
  sources: SourceView[];
  createdAt: string;
  runId: string | null;
  clientMessageId: string | null;
}

export interface RunView {
  id: string;
  chatId: string;
  status: RunStatus;
  statusLine: string | null;
  error: string | null;
  message: MessageView | null;
}

export interface ChatSummary {
  id: string;
  kind: "main" | "side" | "group";
  title: string | null;
  cleanRoom: boolean;
  pinned: boolean;
  archived: boolean;
  updatedAt: string;
}

export interface Me {
  userId: string;
  displayName: string | null;
  email: string | null;
  timezone: string;
}

export const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function createClient(baseUrl: string, fetchImpl: typeof fetch = fetch) {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      credentials: "include",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`);
    return data as T;
  }

  return {
    signUp: (input: {
      email: string;
      password: string;
      displayName?: string;
      inviteCode: string;
      timezone: string;
    }) => call<{ ok: true }>("POST", "/auth/sign-up", input),
    signIn: (input: { email: string; password: string; timezone: string }) =>
      call<{ ok: true }>("POST", "/auth/sign-in", input),
    signOut: () => call<{ ok: true }>("POST", "/auth/sign-out", {}),
    me: () => call<Me>("GET", "/me"),
    listChats: () => call<{ chats: ChatSummary[] }>("GET", "/chats"),
    createSideChat: (input: { title?: string; cleanRoom?: boolean }) =>
      call<{ chat: ChatSummary }>("POST", "/chats", input),
    updateChat: (id: string, input: { pinned?: boolean; archived?: boolean }) =>
      call<{ chat: ChatSummary }>("PATCH", `/chats/${id}`, input),
    getChat: (id: string) =>
      call<{
        chat: ChatSummary;
        messages: MessageView[];
        activeRun: RunView | null;
        endedRuns: RunView[];
      }>("GET", `/chats/${id}`),
    sendMessage: (chatId: string, input: { text: string; clientMessageId: string }) =>
      call<{ message: MessageView; run: RunView }>("POST", `/chats/${chatId}/messages`, input),
    pollRun: (id: string) => call<{ run: RunView }>("GET", `/runs/${id}`),
    stopRun: (id: string) => call<{ run: RunView }>("POST", `/runs/${id}/stop`, {}),
  };
}

export type ApiClient = ReturnType<typeof createClient>;
