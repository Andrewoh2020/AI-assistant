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

export interface FileView {
  id: string;
  name: string;
  mime: string;
  bytes: number;
  /** "upload": the person attached it. "download": the browser got it for them. */
  kind: "upload" | "download";
}

export type BrowserStatus =
  "starting" | "running" | "needs_user" | "user_control" | "done" | "failed" | "stopped";

export interface BrowserTabView {
  url: string;
  title: string | null;
  /** The tab the browser was showing. */
  active: boolean;
}

/** A browser job the assistant ran, live or finished. Only ever sent to its owner. */
export interface BrowserView {
  id: string;
  /** needs_user: the agent asked the person to do something. user_control: they took over. */
  status: BrowserStatus;
  /**
   * The status in Muse's words: Working on it, Browsing, Sign-in needed, You're in control,
   * Done, Site blocked, Couldn't finish, Stopped.
   */
  label: string;
  /** A short name for the job, like "Check GitHub notifications". */
  title: string;
  /** The site it is on, like "github.com". */
  site: string | null;
  tabs: BrowserTabView[];
  step: string | null;
  needsUser: string | null;
  /** The live browser. Works like a password while the browser is open; never share it. */
  liveUrl: string | null;
  /** The last picture of the page, if there is one (see fileViewUrl). */
  screenshotId: string | null;
  /** The browser has closed; only the last picture is left. */
  closed: boolean;
  /** It failed, was blocked or was stopped (the card's globe turns red). */
  failed: boolean;
}

export interface MessageView {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  reasoning: string | null;
  sources: SourceView[];
  files: FileView[];
  /** Browser jobs behind this answer, shown as cards above it. */
  browsers: BrowserView[];
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
  /** Browser jobs in this run so far, oldest first. */
  browsers: BrowserView[];
}

export interface ChatSummary {
  id: string;
  kind: "main" | "side" | "group";
  title: string | null;
  cleanRoom: boolean;
  pinned: boolean;
  archived: boolean;
  /** When the chat last had a message (or was created, if it has none). */
  updatedAt: string;
  /** The reply still being worked on in this chat, if any. Only set in the chat list. */
  activeRunId: string | null;
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
    updateChat: (id: string, input: { pinned?: boolean; archived?: boolean; title?: string }) =>
      call<{ chat: ChatSummary }>("PATCH", `/chats/${id}`, input),
    deleteChat: (id: string) => call<{ ok: true }>("DELETE", `/chats/${id}`),
    getChat: (id: string) =>
      call<{
        chat: ChatSummary;
        messages: MessageView[];
        activeRun: RunView | null;
        endedRuns: RunView[];
      }>("GET", `/chats/${id}`),
    sendMessage: (
      chatId: string,
      input: { text: string; clientMessageId: string; fileIds?: string[] },
    ) => call<{ message: MessageView; run: RunView }>("POST", `/chats/${chatId}/messages`, input),
    pollRun: (id: string) => call<{ run: RunView }>("GET", `/runs/${id}`),
    stopRun: (id: string) => call<{ run: RunView }>("POST", `/runs/${id}/stop`, {}),
    /** Sends the file's bytes as they are; the name travels in a header. */
    uploadFile: async (file: Blob & { name: string }, chatId?: string) => {
      const q = chatId ? `?chatId=${encodeURIComponent(chatId)}` : "";
      const res = await fetchImpl(`${baseUrl}/files${q}`, {
        method: "POST",
        credentials: "include",
        headers: {
          // Always raw bytes; the real type goes in X-File-Type so text and JSON files aren't
          // mistaken for a request body.
          "Content-Type": "application/octet-stream",
          "X-File-Type": file.type || "application/octet-stream",
          "X-File-Name": encodeURIComponent(file.name),
        },
        body: file,
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; file?: FileView };
      if (!res.ok) throw new ApiError(res.status, data.error ?? `Upload failed (${res.status})`);
      return data as { file: FileView };
    },
    fileUrl: (id: string) => `${baseUrl}/files/${id}/download`,
    /** Shows an image file in the page (browser pictures). */
    fileViewUrl: (id: string) => `${baseUrl}/files/${id}/view`,
    takeOverBrowser: (id: string) =>
      call<{ browser: BrowserView }>("POST", `/browser-sessions/${id}/take-over`, {}),
    handBackBrowser: (id: string) =>
      call<{ browser: BrowserView }>("POST", `/browser-sessions/${id}/hand-back`, {}),
  };
}

export type ApiClient = ReturnType<typeof createClient>;
