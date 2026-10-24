"use client";

import {
  ApiError,
  TERMINAL_STATUSES,
  type BrowserView,
  type ChatSummary,
  type FileView,
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
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { api } from "@/lib/client";
import { usePref } from "@/lib/prefs";
import { Answer } from "./Answer";
import { BrowserCard, BrowserPanel } from "./BrowserCard";
import { FileChip, FileList, PaperclipIcon } from "./Files";
import { Menu, MenuItem } from "./Menu";
import { Settings, VaultIcon, type GmailResult } from "./Settings";

const POLL_MS = 1500;
/** Replies in chats you aren't looking at keep going too, checked a little less often. */
const BACKGROUND_POLL_MS = 3000;

type ChatChange = { pinned?: boolean; archived?: boolean; title?: string };

// Each chat keeps its own unsent message while you switch between chats. Kept outside the
// component so it survives moving from one chat page to another.
const drafts = new Map<string, string>();

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
  // Chats whose reply finished while you were looking at another chat.
  const [unread, setUnread] = useState<ReadonlySet<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState<ChatSummary | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Files attached to the message being written (already uploaded).
  const [attachments, setAttachments] = useState<FileView[]>([]);
  const [uploading, setUploading] = useState(0);
  // The message being sent, shown at once while the server accepts it.
  const [pending, setPending] = useState<{ text: string; files: FileView[] } | null>(null);
  const sendingRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [navOpen, setNavOpen] = useState(false);
  // "Keep chat panel visible": on, the chat list stays beside the chat; off, the rail's chat
  // button opens it over the chat and it closes after you pick one.
  const [keepPanel, setKeepPanel] = usePref("keepChatPanel", true);
  const [showArchived, setShowArchived] = usePref("showArchivedChats", false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<{ messageId: string; n: number | null } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const panelToggleRef = useRef<HTMLAnchorElement>(null);
  // The browser shown in the right-hand preview panel.
  const [preview, setPreview] = useState<{ id: string; takeControl: boolean } | null>(null);
  const [settings, setSettings] = useState<"home" | "vault" | "connections" | null>(null);
  const [gmailResult, setGmailResult] = useState<GmailResult | null>(null);
  // Back from Google's sign-in (connecting Gmail): open Settings where it left off.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get("settings") !== "connections") return;
    setSettings("connections");
    const result = q.get("gmail");
    if (
      result === "connected" ||
      result === "cancelled" ||
      result === "failed" ||
      result === "unavailable"
    ) {
      setGmailResult(result);
    }
    window.history.replaceState(null, "", window.location.pathname);
  }, []);
  // The chat list opens over the chat (not beside it) when it isn't kept visible, or while the
  // browser preview takes the room.
  const floating = !keepPanel || !!preview;
  // Opened by hovering over the Chat icon: it closes again when the pointer leaves.
  const hoverOpened = useRef(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hoverOpen = (e: ReactPointerEvent) => {
    if (!floating || e.pointerType !== "mouse") return;
    clearTimeout(hoverTimer.current);
    if (!panelOpen) {
      hoverOpened.current = true;
      setPanelOpen(true);
    }
  };
  const hoverLeave = (e: ReactPointerEvent) => {
    if (e.pointerType !== "mouse" || !hoverOpened.current) return;
    clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => {
      hoverOpened.current = false;
      setPanelOpen(false);
    }, 300);
  };
  useEffect(() => () => clearTimeout(hoverTimer.current), []);

  // A chat panel opened over the chat closes when you click anywhere else, or press Escape.
  useEffect(() => {
    if (!panelOpen || !floating) return;
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!sidebarRef.current?.contains(t) && !panelToggleRef.current?.contains(t)) {
        setPanelOpen(false);
      }
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setPanelOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [panelOpen, floating]);

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

  const refreshChats = useCallback(async () => {
    try {
      setChats((await api.listChats()).chats);
    } catch (err) {
      handleAuth(err);
    }
  }, [handleAuth]);

  // Switching chats: clear what was on screen, bring back this chat's unsent message, and mark
  // its new reply as seen.
  useEffect(() => {
    setChat(null);
    setMessages([]);
    setEndedRuns([]);
    setActiveRun(null);
    setSendError(null);
    setSelected(null);
    setAttachments([]);
    setPending(null);
    setPreview(null);
    setDraft(drafts.get(chatId) ?? "");
    setUnread((prev) => {
      if (!prev.has(chatId)) return prev;
      const next = new Set(prev);
      next.delete(chatId);
      return next;
    });
  }, [chatId]);

  function changeDraft(text: string) {
    setDraft(text);
    if (text) drafts.set(chatId, text);
    else drafts.delete(chatId);
  }

  // Load the user, the chat list and this chat (including a reply still in progress).
  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    setPreview(null);
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
        // A brand-new chat is ready to type in.
        if (data.messages.length === 0 && !data.activeRun) inputRef.current?.focus();
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
          void refreshChats();
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
  }, [activeRunId, handleAuth, refreshChats]);

  // Replies still being worked on in other chats. Polling moves them forward on the server, so a
  // side chat keeps answering while you read Main, and the chat list shows when it's done.
  const backgroundRuns = chats
    .filter((c) => c.id !== chatId && c.activeRunId)
    .map((c) => `${c.id}:${c.activeRunId}`)
    .join(",");
  useEffect(() => {
    if (!backgroundRuns) return;
    const pairs = backgroundRuns.split(",").map((p) => p.split(":") as [string, string]);
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const finished: string[] = [];
      await Promise.all(
        pairs.map(async ([id, runId]) => {
          try {
            const { run } = await api.pollRun(runId);
            if (TERMINAL_STATUSES.has(run.status)) finished.push(id);
          } catch (err) {
            // A deleted chat's run is gone; the next chat list drops it.
            if (err instanceof ApiError && err.status === 403) finished.push(id);
            else handleAuth(err);
          }
        }),
      );
      if (stopped) return;
      if (finished.length) {
        setUnread((prev) => new Set([...prev, ...finished]));
        await refreshChats();
        return;
      }
      timer = setTimeout(tick, BACKGROUND_POLL_MS);
    };
    timer = setTimeout(tick, BACKGROUND_POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [backgroundRuns, handleAuth, refreshChats]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, activeRunId, endedRuns.length, pending]);

  async function send(text: string, files: FileView[] = attachments) {
    const trimmed = text.trim();
    // One send at a time: a second Enter while the first is on its way does nothing.
    if (!trimmed || activeRunId || uploading || sendingRef.current) return;
    sendingRef.current = true;
    setSendError(null);
    // Show the message and "Thinking" straight away, and empty the box.
    const fromComposer = text === draft;
    setPending({ text: trimmed, files });
    if (fromComposer) {
      changeDraft("");
      setAttachments([]);
    }
    const clientMessageId = crypto.randomUUID();
    try {
      const res = await api.sendMessage(chatId, {
        text: trimmed,
        clientMessageId,
        fileIds: files.map((f) => f.id),
      });
      setMessages((prev) => [...prev, res.message]);
      setChats((prev) =>
        prev.map((c) =>
          c.id === chatId ? { ...c, activeRunId: res.run.id, title: c.title ?? trimmed } : c,
        ),
      );
      if (TERMINAL_STATUSES.has(res.run.status)) setEndedRuns((prev) => [...prev, res.run]);
      else setActiveRun(res.run);
      // The first message names a new side chat and moves it to the top of the list.
      void refreshChats();
    } catch (err) {
      // Put the message back so nothing is lost.
      if (fromComposer) {
        if (!drafts.get(chatId)) changeDraft(text);
        setAttachments((a) => (a.length ? a : files));
      }
      if (!handleAuth(err)) setSendError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
      sendingRef.current = false;
    }
  }

  async function attach(list: FileList | null) {
    const picked = [...(list ?? [])];
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (!picked.length) return;
    setSendError(null);
    setUploading((n) => n + picked.length);
    for (const file of picked) {
      try {
        if (file.size > 20 * 1024 * 1024) throw new Error(`${file.name} is over 20 MB.`);
        const { file: uploaded } = await api.uploadFile(file, chatId);
        setAttachments((prev) => [...prev, uploaded].slice(0, 10));
      } catch (err) {
        if (!handleAuth(err)) setSendError(err instanceof Error ? err.message : String(err));
      } finally {
        setUploading((n) => n - 1);
      }
    }
  }

  // Dragging files over the window turns the message box into a drop target, like Muse.
  const [dragging, setDragging] = useState(false);
  const attachRef = useRef(attach);
  attachRef.current = attach;
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDragging(true);
    };
    const clear = () => {
      depth = 0;
      setDragging(false);
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      // No relatedTarget means the drag left the window (or was cancelled).
      if (depth === 0 || !e.relatedTarget) clear();
    };
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      // Without this the browser would open the file instead of handing it to us.
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      clear();
      void attachRef.current(e.dataTransfer?.files ?? null);
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("dragover", onOver);
    window.addEventListener("drop", onDrop);
    // The pointer moving normally again means any drag is over, whatever events were missed.
    window.addEventListener("pointermove", clear);
    return () => {
      window.removeEventListener("pointermove", clear);
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

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

  // Opens a fresh side chat. A side chat you opened but never wrote in is reused, so clicking
  // "+" twice doesn't leave empty chats behind.
  async function newSideChat() {
    picked();
    const unused = chats.find((c) => c.kind === "side" && !c.title && !c.archived);
    if (unused) {
      if (unused.id === chatId) inputRef.current?.focus();
      else router.push(`/chat/${unused.id}`);
      return;
    }
    try {
      const { chat: created } = await api.createSideChat({});
      setChats((prev) => [
        ...prev.filter((c) => c.kind === "main"),
        created,
        ...prev.filter((c) => c.kind !== "main"),
      ]);
      router.push(`/chat/${created.id}`);
    } catch (err) {
      handleAuth(err);
    }
  }

  async function updateChat(id: string, change: ChatChange) {
    try {
      const { chat: updated } = await api.updateChat(id, change);
      // Show the change at once; the fresh list below puts it in the right place.
      setChats((prev) =>
        prev.map((c) => (c.id === id ? { ...c, ...updated, activeRunId: c.activeRunId } : c)),
      );
      if (updated.id === chatId) setChat(updated);
      await refreshChats();
    } catch (err) {
      handleAuth(err);
    }
  }

  async function deleteChat(target: ChatSummary) {
    setConfirmDelete(null);
    try {
      await api.deleteChat(target.id);
      drafts.delete(target.id);
      setChats((prev) => prev.filter((c) => c.id !== target.id));
      if (target.id === chatId) {
        const main = chats.find((c) => c.kind === "main");
        router.replace(main ? `/chat/${main.id}` : "/");
      }
      await refreshChats();
    } catch (err) {
      if (!handleAuth(err))
        setSendError(`Couldn't delete that chat: ${err instanceof Error ? err.message : err}`);
    }
  }

  function picked() {
    setNavOpen(false);
    if (floating) setPanelOpen(false);
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

  // Every browser in this chat, newest data first (the active run's is live).
  const allBrowsers: BrowserView[] = [
    ...(activeRun?.browsers ?? []),
    ...endedRuns.flatMap((r) => r.browsers),
    ...messages.flatMap((m) => m.browsers),
  ];
  const previewBrowser = preview ? allBrowsers.find((b) => b.id === preview.id) : undefined;

  function updateBrowser(view: BrowserView) {
    setActiveRun((run) =>
      run ? { ...run, browsers: run.browsers.map((b) => (b.id === view.id ? view : b)) } : run,
    );
  }

  function browserCards(list: BrowserView[]) {
    return list.map((b) => (
      <BrowserCard
        key={b.id}
        browser={b}
        open={preview?.id === b.id}
        onOpen={() => setPreview({ id: b.id, takeControl: false })}
        onTakeControl={() => setPreview({ id: b.id, takeControl: true })}
        onChange={updateBrowser}
      />
    ));
  }

  // A browser waiting on the person: the chat says so instead of "working".
  const waitingBrowser = activeRun?.browsers.find(
    (b) => b.status === "needs_user" || b.status === "user_control",
  );
  const waitingFor = !waitingBrowser
    ? null
    : waitingBrowser.status === "needs_user"
      ? "Waiting for you to sign in in the browser"
      : "Waiting for you to hand the browser back";

  const mainChat = chats.find((c) => c.kind === "main");
  const sideChats = chats.filter((c) => c.kind !== "main" && !c.archived);
  const archivedChats = chats.filter((c) => c.archived);
  const runByUserMessage = new Map(endedRuns.map((r) => [r.id, r]));
  const working = !!activeRunId || !!pending;
  const isEmpty = messages.length === 0 && !working;

  const q = query.trim().toLowerCase();
  const matches = (c: ChatSummary) => (c.title || "New side chat").toLowerCase().includes(q);
  const shownSideChats = q ? sideChats.filter(matches) : sideChats;
  const shownArchived = q ? archivedChats.filter(matches) : archivedChats;
  const panelShown = keepPanel || panelOpen;

  return (
    <div
      className={`shell ${navOpen ? "nav-open" : ""} ${keepPanel ? "" : "panel-floating"} ${panelShown ? "" : "sidebar-hidden"} ${previewBrowser ? "has-preview" : ""} ${panelOpen ? "panel-open" : ""}`}
    >
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
            ref={panelToggleRef}
            aria-expanded={floating ? panelOpen : undefined}
            onPointerEnter={hoverOpen}
            onPointerLeave={hoverLeave}
            onClick={(e) => {
              // With the panel not kept visible, Chat opens the chat list over the chat.
              if (!floating) return;
              e.preventDefault();
              clearTimeout(hoverTimer.current);
              // A click on a list hovering opened keeps it open; otherwise it toggles.
              if (hoverOpened.current) hoverOpened.current = false;
              else setPanelOpen(!panelOpen);
            }}
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
        <Menu label="Menu" trigger={<MenuIcon />} className="rail-menu" buttonClassName="rail-btn">
          {(close) => (
            <>
              <p className="menu-who">{me?.displayName || me?.email}</p>
              <MenuItem
                icon={<SettingsIcon />}
                onSelect={() => {
                  setSettings("home");
                  close();
                }}
              >
                Settings
              </MenuItem>
              <MenuItem
                icon={<VaultIcon />}
                onSelect={() => {
                  setSettings("vault");
                  close();
                }}
              >
                Saved logins
              </MenuItem>
              <hr className="menu-divider" />
              <MenuItem icon={<SignOutIcon />} onSelect={signOut}>
                Sign out
              </MenuItem>
            </>
          )}
        </Menu>
      </nav>

      <nav
        className="sidebar"
        aria-label="Chats"
        ref={sidebarRef}
        onPointerEnter={() => clearTimeout(hoverTimer.current)}
        onPointerLeave={hoverLeave}
      >
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
          <Menu label="More" trigger={<MoreIcon />}>
            {(close) => (
              <>
                <MenuItem
                  checked={keepPanel}
                  onSelect={() => {
                    setKeepPanel(!keepPanel);
                    setPanelOpen(false);
                    close();
                  }}
                >
                  Keep chat panel visible
                </MenuItem>
                <hr className="menu-divider" />
                <MenuItem
                  icon={<ArchiveIcon />}
                  onSelect={() => {
                    setShowArchived(!showArchived);
                    close();
                  }}
                >
                  {showArchived ? "Hide archived chats" : "Show archived chats"}
                </MenuItem>
              </>
            )}
          </Menu>
        </div>
        <div className="sidebar-scroll">
          <ul className="chat-list">
            {mainChat && (
              <li>
                <ChatLink
                  chat={mainChat}
                  current={chatId}
                  unread={unread.has(mainChat.id)}
                  onPick={picked}
                />
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
                <ChatLink
                  chat={c}
                  current={chatId}
                  unread={unread.has(c.id)}
                  onPick={picked}
                  onUpdate={updateChat}
                  onDelete={setConfirmDelete}
                />
              </li>
            ))}
            {q && shownSideChats.length === 0 && <li className="muted nav-empty">No matches</li>}
          </ul>
          {showArchived && (
            <>
              <p className="nav-label">
                <span>Archived</span>
              </p>
              <ul className="chat-list">
                {shownArchived.map((c) => (
                  <li key={c.id}>
                    <ChatLink
                      chat={c}
                      current={chatId}
                      unread={unread.has(c.id)}
                      onPick={picked}
                      onUpdate={updateChat}
                      onDelete={setConfirmDelete}
                    />
                  </li>
                ))}
                {shownArchived.length === 0 && (
                  <li className="muted nav-empty">No archived chats</li>
                )}
              </ul>
            </>
          )}
        </div>
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
          {/* Phones have no rail, so Settings sits in the header, as in Muse's app. */}
          <button
            className="btn btn-secondary btn-round nav-toggle head-settings"
            type="button"
            aria-label="Settings"
            onClick={() => setSettings("home")}
          >
            <SettingsIcon />
          </button>
        </header>

        {working && (
          <div className="working-pill" role="status">
            <strong>Assistant</strong>
            <span>{waitingFor ? "is waiting for you" : "is working"}</span>
          </div>
        )}
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
                {chat.kind === "side"
                  ? "This side chat keeps its own history, separate from Main chat. It's named after your first message."
                  : "Ask anything. For current topics I search the web and show where each fact came from."}
              </p>
            </div>
          )}
          {messages.map((m) => {
            const ended = m.role === "user" && m.runId ? runByUserMessage.get(m.runId) : undefined;
            return (
              <div key={m.id}>
                {m.role === "assistant" && browserCards(m.browsers)}
                <article
                  className={`turn turn-${m.role}`}
                  aria-label={m.role === "user" ? "You" : "Assistant"}
                >
                  {m.role === "user" ? (
                    <div className="user-turn">
                      <p className="user-text">{m.text}</p>
                      <FileList files={m.files} />
                    </div>
                  ) : (
                    <Answer
                      message={m}
                      onCite={onCite}
                      highlight={selected?.messageId === m.id ? selected.n : null}
                    />
                  )}
                </article>
                {ended && browserCards(ended.browsers)}
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
                        onClick={() => send(m.text, m.files)}
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
          {pending && (
            <article className="turn turn-user" aria-label="You">
              <div className="user-turn">
                <p className="user-text">{pending.text}</p>
                <FileList files={pending.files} />
              </div>
            </article>
          )}
          {working && activeRun && activeRun.browsers.length > 0 && (
            <div>{browserCards(activeRun.browsers)}</div>
          )}
          {working && (
            <div className="progress" role="status">
              <span className="dots" aria-hidden="true" />
              <span>{waitingFor ?? `${activeRun?.statusLine || "Thinking"}…`}</span>
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
          {(attachments.length > 0 || uploading > 0) && (
            <div className="composer-files">
              {attachments.map((f) => (
                <FileChip
                  key={f.id}
                  file={f}
                  onRemove={() => setAttachments((prev) => prev.filter((x) => x.id !== f.id))}
                />
              ))}
              {uploading > 0 && <span className="file-chip file-chip-busy">Uploading…</span>}
            </div>
          )}
          <div className={`composer-box ${dragging ? "is-dropping" : ""}`}>
            {dragging && (
              <div className="drop-hint" aria-live="polite">
                <UploadIcon />
                Drop files to attach
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={(e) => void attach(e.target.files)}
            />
            <button
              type="button"
              className="attach-btn"
              onClick={() => fileInputRef.current?.click()}
              aria-label="Attach files"
              title="Attach files"
              disabled={attachments.length >= 10}
            >
              <PaperclipIcon />
            </button>
            <label className="sr-only" htmlFor="composer-input">
              Message
            </label>
            <textarea
              id="composer-input"
              ref={inputRef}
              value={draft}
              onChange={(e) => changeDraft(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Message"
              rows={1}
              maxLength={8000}
            />
            {working ? (
              <button
                className="send-btn is-active"
                type="button"
                onClick={stop}
                disabled={!activeRunId}
                aria-label="Stop"
              >
                <StopIcon />
              </button>
            ) : (
              <button
                className={`send-btn ${draft.trim() && !uploading ? "is-active" : ""}`}
                type="submit"
                disabled={!draft.trim() || uploading > 0}
                aria-label="Send"
              >
                <ArrowUpIcon />
              </button>
            )}
          </div>
        </form>
      </main>

      {confirmDelete && (
        <ConfirmDialog
          title={`Delete "${chatName(confirmDelete)}"?`}
          confirmLabel="Delete"
          onConfirm={() => deleteChat(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        >
          This deletes the side chat and all of its messages. It can&apos;t be undone.
        </ConfirmDialog>
      )}
      {settings && (
        <Settings
          start={settings}
          gmailResult={gmailResult}
          onClose={() => {
            setSettings(null);
            setGmailResult(null);
          }}
          onSignOut={signOut}
        />
      )}
      {previewBrowser && (
        <BrowserPanel
          browser={previewBrowser}
          takeControlNow={preview!.takeControl}
          onChange={updateBrowser}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}

function chatName(chat: ChatSummary) {
  return chat.kind === "main" ? "Main chat" : chat.title || "New side chat";
}

function ChatLink({
  chat,
  current,
  unread,
  onPick,
  onUpdate,
  onDelete,
}: {
  chat: ChatSummary;
  current: string;
  unread: boolean;
  onPick: () => void;
  onUpdate?: (id: string, change: ChatChange) => void;
  onDelete?: (chat: ChatSummary) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const isCurrent = chat.id === current;
  const name = chatName(chat);
  const working = !!chat.activeRunId && !isCurrent;

  if (renaming && onUpdate) {
    return (
      <RenameField
        name={chat.title ?? ""}
        onDone={(title) => {
          setRenaming(false);
          if (title && title !== chat.title) onUpdate(chat.id, { title });
        }}
      />
    );
  }

  return (
    <div className={`chat-row ${isCurrent ? "is-current" : ""}`}>
      <Link
        href={`/chat/${chat.id}`}
        aria-current={isCurrent ? "page" : undefined}
        onClick={onPick}
      >
        {chat.pinned && (
          <span className="pin" aria-label="Pinned">
            <PinIcon />
          </span>
        )}
        <span className="chat-name">{name}</span>
        {working ? (
          <span className="row-status is-working" title="Replying">
            <span className="sr-only">(replying)</span>
          </span>
        ) : (
          unread &&
          !isCurrent && (
            <span className="row-status is-unread" title="New reply">
              <span className="sr-only">(new reply)</span>
            </span>
          )
        )}
      </Link>
      {onUpdate && (
        <Menu label={`Options for ${name}`} trigger={<MoreIcon />} className="row-menu">
          {(close) => (
            <>
              <MenuItem
                icon={<PinIcon />}
                onSelect={() => {
                  onUpdate(chat.id, { pinned: !chat.pinned });
                  close();
                }}
              >
                {chat.pinned ? "Unpin" : "Pin"}
              </MenuItem>
              <MenuItem
                icon={<PencilIcon />}
                onSelect={() => {
                  setRenaming(true);
                  close();
                }}
              >
                Rename
              </MenuItem>
              <MenuItem
                icon={<ArchiveIcon />}
                onSelect={() => {
                  onUpdate(chat.id, { archived: !chat.archived });
                  close();
                }}
              >
                {chat.archived ? "Unarchive" : "Archive"}
              </MenuItem>
              {onDelete && (
                <>
                  <hr className="menu-divider" />
                  <MenuItem
                    icon={<TrashIcon />}
                    danger
                    onSelect={() => {
                      onDelete(chat);
                      close();
                    }}
                  >
                    Delete
                  </MenuItem>
                </>
              )}
            </>
          )}
        </Menu>
      )}
    </div>
  );
}

/** Renames a chat in place: Enter or clicking away saves, Escape cancels. */
function RenameField({ name, onDone }: { name: string; onDone: (title: string | null) => void }) {
  const [value, setValue] = useState(name);
  const done = useRef(false);
  const finish = (title: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(title);
  };
  return (
    <form
      className="chat-row is-renaming"
      onSubmit={(e) => {
        e.preventDefault();
        finish(value.replace(/\s+/g, " ").trim() || null);
      }}
    >
      <label className="sr-only" htmlFor="rename-chat">
        Chat name
      </label>
      <input
        id="rename-chat"
        className="rename-input"
        value={value}
        maxLength={120}
        autoFocus
        onFocus={(e) => e.target.select()}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => finish(value.replace(/\s+/g, " ").trim() || null)}
        onKeyDown={(e) => {
          if (e.key === "Escape") finish(null);
        }}
      />
    </form>
  );
}

/** A small centered dialog that asks before doing something that can't be undone. */
function ConfirmDialog({
  title,
  confirmLabel,
  onConfirm,
  onCancel,
  children,
}: {
  title: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="confirm"
      aria-labelledby="confirm-title"
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onCancel();
      }}
    >
      <h2 id="confirm-title">{title}</h2>
      <p>{children}</p>
      <div className="confirm-actions">
        <button className="btn btn-ghost" type="button" onClick={onCancel} autoFocus>
          Cancel
        </button>
        <button className="btn btn-danger" type="button" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </dialog>
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

function UploadIcon() {
  return (
    <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M7 18H6.5a4.5 4.5 0 0 1-.9-8.9 6 6 0 0 1 11.7-1A4.5 4.5 0 0 1 17.5 18H17M12 20v-8m0 0-3 3m3-3 3 3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
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
const PencilIcon = () => <Icon d="M4 20h4L19 9l-4-4L4 16v4ZM13 7l4 4" />;
const TrashIcon = () => (
  <Icon d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
);
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
const ArchiveIcon = () => (
  <Icon d="M4 5h16v4H4V5Zm1 4v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4" />
);
const SettingsIcon = () => (
  <Icon d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 13.5l1.6 1.2-2 3.4-1.9-.7a7 7 0 0 1-2 1.2L14.8 21h-4l-.3-2.4a7 7 0 0 1-2-1.2l-1.9.7-2-3.4 1.6-1.2a7 7 0 0 1 0-3L4.6 9.3l2-3.4 1.9.7a7 7 0 0 1 2-1.2L10.8 3h4l.3 2.4a7 7 0 0 1 2 1.2l1.9-.7 2 3.4-1.6 1.2a7 7 0 0 1 0 3Z" />
);
const SignOutIcon = () => (
  <Icon d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 8l-4 4 4 4M6 12h10" />
);
function PinIcon() {
  return (
    <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 3h6l-1 6 3 3v2h-4v6l-1 1-1-1v-6H7v-2l3-3-1-6Z" fill="currentColor" />
    </svg>
  );
}
