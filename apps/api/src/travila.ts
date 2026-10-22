import { postJson } from "./http.js";
import type { ToolDefinition } from "@ai-assistant/agent";

/** The parts of Travila's conversation API we use. Swappable for a fake in tests. */
export interface Travila {
  createThread(userId: string, input: CreateThreadInput): Promise<string>;
  /** Replaces a thread's model, instructions and tools (used when they change after it was made). */
  updateThreadConfig(userId: string, threadId: string, input: CreateThreadInput): Promise<void>;
  sendMessage(
    userId: string,
    threadId: string,
    text: string,
    images?: InlineImage[],
  ): Promise<string>;
  getState(userId: string, threadId: string): Promise<TravilaState>;
  listPendingClientTools(userId: string, threadId: string): Promise<TravilaToolCall[]>;
  submitClientToolResults(
    userId: string,
    threadId: string,
    runId: string,
    results: { toolCallId: string; toolName: string; resultJson: unknown }[],
  ): Promise<void>;
  searchMemories(
    userId: string,
    query: string,
    topK: number,
  ): Promise<{ id: string; memory: string }[]>;
}

/** A picture sent with the message for the model to look at (base64 bytes). */
export interface InlineImage {
  mime: string;
  base64: string;
}

export interface CreateThreadInput {
  title: string;
  systemPrompt: string;
  models: readonly string[];
  reasoningEffort: string;
  clientTools: ToolDefinition[];
  timezone: string;
  memory: boolean;
  maxLoops: number;
  clientToolTimeoutMs: number;
}

function generationConfig(input: CreateThreadInput) {
  return {
    models: input.models,
    systemPrompt: input.systemPrompt,
    reasoning: { effort: input.reasoningEffort, exclude: false },
    clientTools: input.clientTools,
    toolPolicy: { clientToolTimeoutMs: input.clientToolTimeoutMs },
    timeAware: { includeCurrentTime: true, timezone: input.timezone },
    mem0: input.memory
      ? { enabled: true, searchTopK: 5, searchThreshold: 0.15 }
      : { enabled: false },
  };
}

export interface TravilaContentPart {
  type: string;
  content?: string;
}

export interface TravilaToolCall {
  id: string;
  name: string;
  argumentsJson?: Record<string, unknown>;
  status?: string;
  isClientTool?: boolean;
}

export interface TravilaMessage {
  role: string;
  content?: TravilaContentPart[];
  toolCalls?: TravilaToolCall[];
  messageId?: string;
  sequence?: string;
  generatedBy?: string;
  model?: string;
  generationContext?: { model?: string };
  usage?: Record<string, unknown>;
  finishReason?: string;
}

export interface TravilaState {
  messageHistory?: TravilaMessage[];
  activeRunId?: string;
  activeRunning?: boolean;
  lastRunStatus?: string;
}

export class TravilaHttp implements Travila {
  constructor(
    private readonly base: string,
    private readonly apiKey: string,
  ) {}

  private call<T>(userId: string, op: string, body: unknown, retries = 2) {
    const headers: Record<string, string> = { "X-On-Behalf-Of": userId };
    if (this.apiKey) headers["X-API-Key"] = this.apiKey;
    return postJson<T>("Travila", `${this.base}/api/v1/llm/${op}`, body, headers, { retries });
  }

  async createThread(userId: string, input: CreateThreadInput): Promise<string> {
    const res = await this.call<{ thread: { threadId: string } }>(userId, "create-thread", {
      title: input.title,
      defaultGenerationConfig: generationConfig(input),
    });
    const threadId = res.thread.threadId;
    // Thread creation ignores settings, so they are applied separately.
    await this.call(userId, "update-settings", {
      conversationKey: threadId,
      // A new message cancels a run still going (only possible after the user pressed Stop:
      // the API allows one active run per chat).
      settings: { maxLoops: input.maxLoops, interruptPolicy: "INTERRUPT_POLICY_CANCEL_ONGOING" },
    });
    return threadId;
  }

  async updateThreadConfig(userId: string, threadId: string, input: CreateThreadInput) {
    await this.call(userId, "update-default-generation-config", {
      conversationKey: threadId,
      defaultGenerationConfig: generationConfig(input),
    });
  }

  async sendMessage(
    userId: string,
    threadId: string,
    text: string,
    images: InlineImage[] = [],
  ): Promise<string> {
    // Never retried automatically: a lost response doesn't mean the message wasn't accepted.
    const res = await this.call<{ runId: string }>(
      userId,
      "send-message",
      {
        conversationKey: threadId,
        userMessage: {
          role: "ROLE_USER",
          content: [
            { type: "CONTENT_PART_TYPE_TEXT", content: text },
            ...images.map((img) => ({
              type: "CONTENT_PART_TYPE_IMAGE_BASE64",
              content: img.base64,
              metadata: { mimeType: img.mime },
            })),
          ],
        },
      },
      0,
    );
    return res.runId;
  }

  getState(userId: string, threadId: string): Promise<TravilaState> {
    return this.call<TravilaState>(userId, "conversation-state", { conversationKey: threadId });
  }

  async listPendingClientTools(userId: string, threadId: string): Promise<TravilaToolCall[]> {
    const res = await this.call<{ toolCalls?: TravilaToolCall[] }>(
      userId,
      "list-pending-client-tools",
      {
        conversationKey: threadId,
      },
    );
    return res.toolCalls ?? [];
  }

  async submitClientToolResults(
    userId: string,
    threadId: string,
    runId: string,
    results: { toolCallId: string; toolName: string; resultJson: unknown }[],
  ): Promise<void> {
    await this.call(
      userId,
      "submit-client-tool-results",
      { conversationKey: threadId, runId, results },
      0,
    );
  }

  async searchMemories(userId: string, query: string, topK: number) {
    const res = await this.call<{ memories?: { id: string; memory: string }[] }>(
      userId,
      "search-memories",
      { query, topK, threshold: 0.1 },
    );
    return res.memories ?? [];
  }
}
