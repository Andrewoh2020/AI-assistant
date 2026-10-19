"use client";

import {
  ApiError,
  TERMINAL_STATUSES,
  type ChatSummary,
  type Me,
  type MessageView,
  type RunView,
} from "@ai-assistant/api-client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { api } from "@/lib/client";
import { Answer, SourcesList } from "./Answer";

const POLL_MS = 1500;

export function AppShell({ chatId }: { chatId: string }) {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [chat, setChat] = useState<ChatSummary | null>(null);
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [endedRuns, setEndedRuns] = useState<RunView[]>([]);
  const [activeRun, setActiveRun] = useState<RunView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [navOpen, setNavOpen] = useState(false);
  const [selected, setSelected] = useState<{ messageId: string; n: number | null } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const handleAuth = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) {
        router.replace("/sign-in");
        return true;
      }
      return false;
    },
    [router],
  );

  // Load the user, the chat list and this chat (including a reply still in progress).
  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    Promise.all([api.me(), api.listChats(), api.getChat(chatId)])
      .then(([meRes, list, data]) => {
        if (cancelled) return;
        setMe(meRes);
        setChats(list.chats);
        setChat(data.chat);
        setMessages(data.messages);
        setEndedRuns(data.endedRuns);
        setActiveRun(data.activeRun);
        const lastAnswer = [...data.messages]
          .reverse()
          .find((m) => m.role === "assistant" && m.sources.length);
        setSelected(lastAnswer ? { messageId: lastAnswer.id, n: null } : null);
      })
      .catch((err) => {
        if (!cancelled && !handleAuth(err))
          setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [chatId, handleAuth]);

  // Poll the active run until it finishes. Each poll also moves the run forward on the server.
  const activeRunId = activeRun && !TERMINAL_STATUSES.has(activeRun.status) ? activeRun.id : null;
  useEffect(() => {
    if (!activeRunId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const { run } = await api.pollRun(activeRunId);
        if (stopped) return;
        setActiveRun(run);
        if (TERMINAL_STATUSES.has(run.status)) {
          if (run.message) {
            const answer = run.message;
            setMessages((prev) =>
              prev.some((m) => m.id === answer.id) ? prev : [...prev, answer],
            );
            if (answer.sources.length) setSelected({ messageId: answer.id, n: null });
          } else {
            setEndedRuns((prev) => [...prev.filter((r) => r.id !== run.id), run]);
          }
          setActiveRun(null);
          return;
        }
      } catch (err) {
        if (handleAuth(err)) return;
        // A failed poll is retried; the run keeps going on the server.
      }
      if (!stopped) timer = setTimeout(tick, POLL_MS);
    };
    timer = setTimeout(tick, 300);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [activeRunId, handleAuth]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, activeRunId, endedRuns.length]);

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || activeRunId) return;
    setSendError(null);
    const clientMessageId = crypto.randomUUID();
    try {
      const res = await api.sendMessage(chatId, { text: trimmed, clientMessageId });
      setDraft("");
      setMessages((prev) => [...prev, res.message]);
      if (TERMINAL_STATUSES.has(res.run.status)) setEndedRuns((prev) => [...prev, res.run]);
      else setActiveRun(res.run);
    } catch (err) {
      if (!handleAuth(err)) setSendError(err instanceof Error ? err.message : String(err));
    }
  }

  async function stop() {
    if (!activeRunId) return;
    try {
      const { run } = await api.stopRun(activeRunId);
      setEndedRuns((prev) => [...prev, run]);
      setActiveRun(null);
    } catch (err) {
      handleAuth(err);
    }
  }

  async function newSideChat() {
    try {
      const { chat: created } = await api.createSideChat({});
      setChats((prev) => [prev[0]!, created, ...prev.slice(1)].filter(Boolean));
      router.push(`/chat/${created.id}`);
    } catch (err) {
      handleAuth(err);
    }
  }

  async function signOut() {
    await api.signOut().catch(() => {});
    router.replace("/sign-in");
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void send(draft);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(draft);
    }
  }

  function onCite(message: MessageView, n: number) {
    setSelected({ messageId: message.id, n });
    document
      .getElementById(`src-${message.id}-${n}`)
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  const selectedMessage = selected ? messages.find((m) => m.id === selected.messageId) : undefined;
  const runByUserMessage = new Map(endedRuns.map((r) => [r.id, r]));
  const working = !!activeRunId;
  const isEmpty = messages.length === 0 && !working;

  return (
    <div className={`shell ${navOpen ? "nav-open" : ""}`}>
      <a className="skip-link" href="#composer-input">
        Skip to the message box
      </a>

      <nav className="sidebar" aria-label="Chats">
        <div className="sidebar-head">
          <span className="brand">Assistant</span>
          <button className="btn btn-secondary btn-small" type="button" onClick={newSideChat}>
            New side chat
          </button>
        </div>
        <ul className="chat-list">
          {chats.map((c) => (
            <li key={c.id}>
              <Link
                href={`/chat/${c.id}`}
                className={c.id === chatId ? "is-current" : undefined}
                aria-current={c.id === chatId ? "page" : undefined}
                onClick={() => setNavOpen(false)}
              >
                {c.kind === "main" ? "Main" : c.title || "New side chat"}
              </Link>
            </li>
          ))}
        </ul>
        <div className="sidebar-foot">
          <span className="who">{me?.displayName || me?.email}</span>
          <button className="btn btn-ghost btn-small" type="button" onClick={signOut}>
            Sign out
          </button>
        </div>
      </nav>

      <main className="chat">
        <header className="chat-head">
          <button
            className="btn btn-ghost btn-small nav-toggle"
            type="button"
            aria-expanded={navOpen}
            onClick={() => setNavOpen(!navOpen)}
          >
            Chats
          </button>
          <h1>{chat ? (chat.kind === "main" ? "Main" : chat.title || "Side chat") : ""}</h1>
        </header>

        <div className="messages" aria-live="polite">
          {loadError && (
            <p className="notice notice-danger" role="alert">
              Couldn&apos;t open this chat: {loadError}
            </p>
          )}
          {isEmpty && !loadError && chat && (
            <div className="empty">
              <h2>What would you like to know?</h2>
              <p>
                Ask anything. For current topics I search the web and show where each fact came
                from.
              </p>
            </div>
          )}
          {messages.map((m) => {
            const ended = m.role === "user" && m.runId ? runByUserMessage.get(m.runId) : undefined;
            return (
              <div key={m.id}>
                <article
                  className={`turn turn-${m.role}`}
                  aria-label={m.role === "user" ? "You" : "Assistant"}
                >
                  {m.role === "user" ? (
                    <p className="user-text">{m.text}</p>
                  ) : (
                    <Answer message={m} onCite={onCite} />
                  )}
                </article>
                {ended && (
                  <p
                    className={`notice ${ended.status === "failed" ? "notice-danger" : ""}`}
                    role="status"
                  >
                    {ended.status === "cancelled"
                      ? "Stopped. Nothing more will be added to this answer."
                      : `Failed: ${ended.error ?? "unknown error"}`}
                    {ended.status === "failed" && (
                      <button
                        className="btn btn-ghost btn-small"
                        type="button"
                        onClick={() => send(m.text)}
                        disabled={working}
                      >
                        Try again
                      </button>
                    )}
                  </p>
                )}
              </div>
            );
          })}
          {working && (
            <div className="progress" role="status">
              <span className="dots" aria-hidden="true" />
              <span>{activeRun?.statusLine || "Thinking"}…</span>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        <form className="composer" onSubmit={onSubmit}>
          {sendError && (
            <p className="form-error" role="alert">
              {sendError}
            </p>
          )}
          <label className="sr-only" htmlFor="composer-input">
            Message
          </label>
          <textarea
            id="composer-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask anything"
            rows={1}
            maxLength={8000}
          />
          {working ? (
            <button className="btn btn-secondary" type="button" onClick={stop}>
              Stop
            </button>
          ) : (
            <button className="btn btn-primary" type="submit" disabled={!draft.trim()}>
              Send
            </button>
          )}
        </form>
      </main>

      <aside className="detail" aria-label="Sources for the selected answer">
        {selectedMessage && selectedMessage.sources.length > 0 ? (
          <SourcesList message={selectedMessage} highlight={selected?.n ?? null} />
        ) : (
          <p className="muted">Sources for an answer appear here.</p>
        )}
      </aside>
    </div>
  );
}
