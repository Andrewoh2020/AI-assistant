/** Row shapes for the phase 1 tables (migrations/0001_core.up.sql). */

export type ChatKind = "main" | "side" | "group";

export interface ChatRow {
  id: string;
  user_id: string;
  created_at: Date;
  updated_at: Date;
  kind: ChatKind;
  title: string | null;
  travila_thread_id: string | null;
  clean_room: boolean;
  pinned: boolean;
  archived_at: Date | null;
  travila_profile_version: string | null;
}

export type MessagePart =
  | { type: "text"; text: string; citations?: number[] }
  | { type: "reasoning"; text: string }
  | { type: "card"; card: unknown }
  | { type: "artifact_ref"; artifactId: string }
  | { type: "approval_ref"; approvalId: string }
  | { type: "attachment_ref"; fileId: string };

export interface MessageRow {
  id: string;
  user_id: string;
  created_at: Date;
  chat_id: string;
  role: "user" | "assistant" | "system";
  sender_user_id: string | null;
  parts: MessagePart[];
  travila_message_id: string | null;
  run_id: string | null;
  origin: "reply" | "proactive" | "correction";
  language: string | null;
  client_message_id: string | null;
}

export type RunStatus =
  "queued" | "running" | "awaiting_tools" | "completed" | "failed" | "cancelled";

export interface RunRow {
  id: string;
  user_id: string;
  created_at: Date;
  chat_id: string;
  travila_run_id: string | null;
  status: RunStatus;
  status_line: string | null;
  model: string | null;
  profile_version: string | null;
  reasoning_effort: string | null;
  started_at: Date | null;
  finished_at: Date | null;
  usage: Record<string, unknown> | null;
  error: string | null;
}

export interface ToolCallRow {
  id: string;
  user_id: string;
  run_id: string;
  travila_tool_call_id: string | null;
  tool: string;
  args: Record<string, unknown>;
  policy_decision: "allow" | "deny" | "ask" | null;
  decision_reason: string | null;
  status: "pending" | "running" | "succeeded" | "failed" | "denied";
  tainted: boolean;
}

export interface SourceRow {
  id: string;
  user_id: string;
  created_at: Date;
  run_id: string;
  tool_call_id: string | null;
  url: string;
  title: string | null;
  fetched_at: Date | null;
  content_hash: string | null;
  origin: "search" | "fetch" | "browse";
  injection_flag: boolean;
  ref_number: number | null;
  site_name: string | null;
  published_at: Date | null;
}

export interface FileRow {
  id: string;
  user_id: string;
  created_at: Date;
  kind: "upload" | "generated" | "artifact" | "browser_download";
  storage: "travila" | "browser_use_workspace" | "own";
  storage_key: string;
  name: string | null;
  mime: string | null;
  bytes: string | number | null;
  sha256: string | null;
  chat_id: string | null;
  run_id: string | null;
  bu_path: string | null;
}

export type BrowserSessionStatus =
  "starting" | "running" | "needs_user" | "user_control" | "done" | "failed" | "stopped";

export interface BrowserSessionRow {
  id: string;
  user_id: string;
  created_at: Date;
  run_id: string | null;
  tool_call_id: string | null;
  bu_session_id: string | null;
  bu_browser_id: string | null;
  bu_profile_id: string | null;
  bu_workspace_id: string | null;
  bu_run_id: string | null;
  status: BrowserSessionStatus;
  live_view_url_ciphertext: string | null;
  user_took_over_at: Date | null;
  task: string | null;
  step: string | null;
  needs_user: string | null;
  result: string | null;
  error: string | null;
  events_after: string | number;
  outputs_before: Record<string, string>;
  cost_usd: string | null;
  checked_at: Date | null;
  waiting_since: Date | null;
  finished_at: Date | null;
  /** A 2-5 word name for the job, from the assistant. */
  title: string | null;
  /** The last picture of the page (a file of kind 'generated'). */
  screenshot_file_id: string | null;
  screenshot_at: Date | null;
  /** The browser's tabs when that picture was taken. */
  tabs: BrowserTab[];
  /** The site refused the browser (a bot wall, or access denied). */
  blocked: boolean;
}

export interface BrowserTab {
  url: string;
  title: string | null;
  active: boolean;
}
