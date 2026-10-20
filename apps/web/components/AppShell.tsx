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
import { Answer } from "./Answer";

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
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const [query, setQuery] = useState("");
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

  const mainChat = chats.find((c) => c.kind === "main");
  const sideChats = chats.filter((c) => c.kind !== "main");
  const runByUserMessage = new Map(endedRuns.map((r) => [r.id, r]));
  const working = !!activeRunId;
  const isEmpty = messages.length === 0 && !working;

  const q = query.trim().toLowerCase();
  const shownSideChats = q
    ? sideChats.filter((c) => (c.title || "New side chat").toLowerCase().includes(q))
    : sideChats;

  return (
    <div className={`shell ${navOpen ? "nav-open" : ""} ${sidebarHidden ? "sidebar-hidden" : ""}`}>
      <a className="skip-link" href="#composer-input">
        Skip to the message box
      </a>

      <nav className="rail" aria-label="Sections">
        <div className="rail-tabs">
          <Link
            href={mainChat ? `/chat/${mainChat.id}` : "/"}
            className="rail-btn is-current"
            aria-label="Chat"
            title="Chat"
          >
            <ChatIcon />
          </Link>
          {COMING_SOON.map(({ label, Icon }) => (
            <button
              key={label}
              className="rail-btn"
              type="button"
              disabled
              aria-label={`${label} (coming soon)`}
              title={`${label} (coming soon)`}
            >
              <Icon />
            </button>
          ))}
        </div>
        <button
          className="rail-btn"
          type="button"
          aria-label={sidebarHidden ? "Show chats" : "Hide chats"}
          aria-expanded={!sidebarHidden}
          onClick={() => setSidebarHidden(!sidebarHidden)}
        >
          <MenuIcon />
        </button>
      </nav>

      <nav className="sidebar" aria-label="Chats">
        <div className="sidebar-head">
          <label className="search">
            <SearchIcon />
            <span className="sr-only">Search chats</span>
            <input
              type="search"
              placeholder="Search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <details className="more">
            <summary className="icon-btn" aria-label="More" title="More">
              <MoreIcon />
            </summary>
            <div className="menu" role="menu">
              <p className="menu-who">{me?.displayName || me?.email}</p>
              <button className="menu-item" type="button" role="menuitem" onClick={signOut}>
                Sign out
              </button>
            </div>
          </details>
        </div>
        <ul className="chat-list">
          {mainChat && (
            <li>
              <ChatLink chat={mainChat} current={chatId} onPick={() => setNavOpen(false)} />
            </li>
          )}
        </ul>
        <div className="nav-label">
          <span>Side chats</span>
          <button
            className="icon-btn"
            type="button"
            onClick={newSideChat}
            aria-label="New side chat"
            title="New side chat"
          >
            <PlusIcon />
          </button>
        </div>
        <ul className="chat-list">
          {shownSideChats.map((c) => (
            <li key={c.id}>
              <ChatLink chat={c} current={chatId} onPick={() => setNavOpen(false)} />
            </li>
          ))}
          {q && shownSideChats.length === 0 && <li className="muted nav-empty">No matches</li>}
        </ul>
      </nav>

      <main className="chat">
        <header className="chat-head">
          <button
            className="btn btn-secondary btn-round nav-toggle"
            type="button"
            aria-expanded={navOpen}
            aria-label="Chats"
            onClick={() => setNavOpen(!navOpen)}
          >
            <MenuIcon />
          </button>
          <h1>{chat ? (chat.kind === "main" ? "Main chat" : chat.title || "Side chat") : ""}</h1>
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
                    <Answer
                      message={m}
                      onCite={onCite}
                      highlight={selected?.messageId === m.id ? selected.n : null}
                    />
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
          <div className="composer-box">
            <label className="sr-only" htmlFor="composer-input">
              Message
            </label>
            <textarea
              id="composer-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Message"
              rows={1}
              maxLength={8000}
            />
            {working ? (
              <button className="send-btn is-active" type="button" onClick={stop} aria-label="Stop">
                <StopIcon />
              </button>
            ) : (
              <button
                className={`send-btn ${draft.trim() ? "is-active" : ""}`}
                type="submit"
                disabled={!draft.trim()}
                aria-label="Send"
              >
                <ArrowUpIcon />
              </button>
            )}
          </div>
        </form>
      </main>
    </div>
  );
}

function ChatLink({
  chat,
  current,
  onPick,
}: {
  chat: ChatSummary;
  current: string;
  onPick: () => void;
}) {
  const isCurrent = chat.id === current;
  const isMain = chat.kind === "main";
  return (
    <Link
      href={`/chat/${chat.id}`}
      className={isCurrent ? "is-current" : undefined}
      aria-current={isCurrent ? "page" : undefined}
      onClick={onPick}
    >
      <span>{isMain ? "Main chat" : chat.title || "New side chat"}</span>
    </Link>
  );
}

function ChatIcon() {
  return (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 4c4.7 0 8.5 3.1 8.5 7s-3.8 7-8.5 7c-.9 0-1.8-.1-2.6-.3L5 19.5l1.2-3.4C4.6 14.8 3.5 13 3.5 11c0-3.9 3.8-7 8.5-7Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MenuIcon() {
  return (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 9h14M5 15h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

type IconProps = { d: string };
function Icon({ d }: IconProps) {
  return (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d={d}
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
const SearchIcon = () => <Icon d="M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM20 20l-4-4" />;
const FeedIcon = () => (
  <Icon d="M8 4h10a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V9h4V4Zm0 5v11M11 8h6M11 12h6" />
);
const IdeasIcon = () => (
  <Icon d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2V16h5v-.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3Z" />
);
const GoalsIcon = () => (
  <Icon d="M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm2.5 8.5 2.5 2.5 5-6" />
);
const LibraryIcon = () => (
  <Icon d="M7 10.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM14 10.5l3-6 3 6h-6ZM4 14h6v6H4v-6ZM17 20a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
);
const PlusIcon = () => <Icon d="M12 5v14M5 12h14" />;
const ArrowUpIcon = () => <Icon d="M12 19V5M6 11l6-6 6 6" />;
function StopIcon() {
  return (
    <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" />
    </svg>
  );
}
function MoreIcon() {
  return (
    <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="5" cy="12" r="1.6" fill="currentColor" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" />
      <circle cx="19" cy="12" r="1.6" fill="currentColor" />
    </svg>
  );
}

/** Muse's other tabs. Shown so the layout matches; they arrive in later milestones. */
const COMING_SOON = [
  { label: "Search", Icon: SearchIcon },
  { label: "Feed", Icon: FeedIcon },
  { label: "Ideas", Icon: IdeasIcon },
  { label: "Goals", Icon: GoalsIcon },
  { label: "Library", Icon: LibraryIcon },
];
