"use client";

import { ApiError, type BrowserView } from "@ai-assistant/api-client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "@/lib/client";

/**
 * The browser, Muse style: a small card in the chat ("Browser · Browsing · Check GitHub
 * notifications", a picture of the page, "Open preview"), and a panel on the right with the live
 * browser. Only the browser's owner ever receives any of this.
 */

/** "Browsing · Check GitHub notifications" */
function statusLine(browser: BrowserView) {
  return `${browser.label} · ${browser.title}`;
}

export function BrowserCard({
  browser,
  open,
  onOpen,
  onTakeControl,
  onChange,
}: {
  browser: BrowserView;
  /** This browser is showing in the panel. */
  open: boolean;
  onOpen: () => void;
  /** Opens the panel and takes control (for a sign-in). */
  onTakeControl: () => void;
  onChange: (view: BrowserView) => void;
}) {
  return (
    <section className="bcard" aria-label={`Browser: ${statusLine(browser)}`}>
      <div className="bcard-head">
        <span className={`bcard-icon ${browser.failed ? "is-failed" : ""}`}>
          <GlobeIcon />
        </span>
        <div className="bcard-text">
          <strong>Browser</strong>
          <span>{statusLine(browser)}</span>
        </div>
      </div>
      {browser.note && (
        <p className="bcard-note">
          <CheckIcon />
          {browser.note}
        </p>
      )}
      {browser.status === "needs_user" && browser.ask && (
        <SignInBox browser={browser} onChange={onChange} onTakeControl={onTakeControl} />
      )}
      {browser.status === "needs_user" && !browser.ask && (
        <div className="bcard-ask" role="alert">
          <p>{browser.needsUser ?? "The browser needs you to sign in."}</p>
          <button type="button" className="btn btn-accent btn-small" onClick={onTakeControl}>
            Take control of the browser
          </button>
        </div>
      )}
      <button type="button" className="bcard-thumb" onClick={onOpen} tabIndex={-1} aria-hidden>
        {browser.screenshotId ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={api.fileViewUrl(browser.screenshotId)} alt="" />
        ) : (
          <span className="bcard-thumb-empty">
            {browser.closed ? "No picture of the page" : <span className="dots" />}
          </span>
        )}
      </button>
      <button
        type="button"
        className="bcard-open"
        onClick={onOpen}
        aria-pressed={open}
        aria-controls="browser-panel"
      >
        {open ? "Showing in preview" : "Open preview"}
      </button>
    </section>
  );
}

/**
 * The secure sign-in box. What is typed here goes straight to the browser, which types it only
 * into the site it is on; the assistant never sees it. With "Save for next time" (ticked by
 * default) it is also saved in the person's vault, so next time it fills in by itself. It is a
 * normal login form, so a password manager on the device offers to fill it.
 */
function SignInBox({
  browser,
  onChange,
  onTakeControl,
}: {
  browser: BrowserView;
  onChange: (view: BrowserView) => void;
  onTakeControl: () => void;
}) {
  const { kind, site, problem, savedAccount } = browser.ask!;
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [save, setSave] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(input: Parameters<typeof api.signInBrowser>[1]) {
    setBusy(true);
    setError(null);
    try {
      const { browser: view } = await api.signInBrowser(browser.id, input);
      setPassword("");
      setCode("");
      onChange(view);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void send(kind === "sign_in" ? { username, password, save } : { code });
  }

  return (
    <form className="bsign" onSubmit={submit} aria-label={`Sign in to ${site}`}>
      <p className="bsign-title">
        {kind === "sign_in" ? `Sign in to ${site}` : `Enter the code from ${site}`}
      </p>
      {problem ? (
        <p className="bsign-problem" role="alert">
          {problem === "saved_rejected"
            ? `${site} rejected the saved login. Type the new one and it will replace the old one.`
            : problem === "saved_code_rejected"
              ? `${site} didn't take the code from your saved authenticator key. Enter the code from your authenticator app.`
              : `${site} didn't accept that sign-in. Check it and try again.`}
        </p>
      ) : (
        browser.needsUser && <p className="bsign-ask">{browser.needsUser}</p>
      )}
      {kind === "sign_in" && savedAccount !== null && (
        <div className="bsign-saved">
          <p>
            You have a saved login for {site}
            {savedAccount ? ` (${savedAccount})` : ""}, set to ask before using it.
          </p>
          <button
            type="button"
            className="btn btn-accent bsign-submit"
            onClick={() => void send({ useSaved: true })}
            disabled={busy}
          >
            Use saved login
          </button>
          <p className="bsign-or">Or type a different one</p>
        </div>
      )}
      {kind === "sign_in" ? (
        <>
          <label className="bsign-field">
            <span>Email or username</span>
            <input
              name="username"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              maxLength={1000}
            />
          </label>
          <label className="bsign-field">
            <span>Password</span>
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              maxLength={1000}
            />
          </label>
          <label className="bsign-check">
            <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} />
            <span>Save for next time</span>
          </label>
        </>
      ) : (
        <label className="bsign-field">
          <span>Code</span>
          <input
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
            maxLength={64}
          />
        </label>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="btn btn-accent bsign-submit" disabled={busy}>
        {busy ? "Sending…" : kind === "sign_in" ? "Sign in" : "Send code"}
      </button>
      <p className="bsign-note">
        {kind === "sign_in" && save
          ? `Typed only into ${site} and saved in your vault. The assistant never sees it. Untick to use it once.`
          : `Typed only into ${site}. The assistant never sees it, and it isn't kept.`}
      </p>
      <button type="button" className="bsign-alt" onClick={onTakeControl} disabled={busy}>
        Or take control of the browser and do it yourself
      </button>
    </form>
  );
}

export function BrowserPanel({
  browser,
  takeControlNow,
  onChange,
  onClose,
}: {
  browser: BrowserView;
  /** Take control as soon as the panel opens (the card's sign-in button). */
  takeControlNow: boolean;
  onChange: (view: BrowserView) => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inControl = browser.status === "user_control";
  const canTake = !browser.closed && !inControl && !!browser.liveUrl;
  const closeRef = useRef<HTMLButtonElement>(null);

  async function act(action: "take-over" | "hand-back") {
    setBusy(true);
    setError(null);
    try {
      const { browser: view } =
        action === "take-over"
          ? await api.takeOverBrowser(browser.id)
          : await api.handBackBrowser(browser.id);
      onChange(view);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  }

  // The card's "Take control of the browser" opens the panel and takes control in one step.
  const tookRef = useRef(false);
  useEffect(() => {
    if (takeControlNow && canTake && !tookRef.current) {
      tookRef.current = true;
      void act("take-over");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [takeControlNow, canTake]);

  // Focus starts on the close button when the panel opens; Escape closes it.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    closeRef.current?.focus();
  }, [browser.id]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  let src: string | null = null;
  if (browser.liveUrl && !browser.closed) {
    const url = new URL(browser.liveUrl);
    url.searchParams.set("ui", "false");
    // Watch-only until you take control.
    if (!inControl) url.searchParams.set("readOnly", "true");
    src = url.toString();
  }
  const tabs = browser.tabs.length
    ? browser.tabs
    : browser.site
      ? [{ url: `https://${browser.site}`, title: null, active: true }]
      : [];

  return (
    <aside id="browser-panel" className="bpanel" aria-label="Browser preview">
      <header className="bpanel-head">
        <div className="bpanel-title">
          <h2>{browser.title}</h2>
          <p>
            {browser.label}
            {browser.site ? ` · ${browser.site}` : ""}
          </p>
        </div>
        {inControl ? (
          <button
            type="button"
            className="btn btn-accent btn-small"
            onClick={() => act("hand-back")}
            disabled={busy}
          >
            Hand back
          </button>
        ) : (
          canTake && (
            <button
              type="button"
              className="btn btn-accent btn-small"
              onClick={() => act("take-over")}
              disabled={busy}
            >
              Take control of the browser
            </button>
          )
        )}
        <button
          ref={closeRef}
          type="button"
          className="icon-btn"
          onClick={onClose}
          aria-label="Close preview"
          title="Close"
        >
          <CloseIcon />
        </button>
      </header>
      {error && (
        <p className="form-error bpanel-error" role="alert">
          {error}
        </p>
      )}
      {tabs.length > 0 && (
        <div className="bpanel-tabs" role="list" aria-label="Tabs">
          {tabs.map((t, i) => (
            <span
              key={`${t.url}-${i}`}
              role="listitem"
              className={`bpanel-tab ${t.active ? "is-active" : ""}`}
              title={t.url}
            >
              {t.title || hostOf(t.url)}
            </span>
          ))}
        </div>
      )}
      <div className={`bpanel-view ${inControl ? "is-live" : ""}`}>
        {src ? (
          <iframe
            key={inControl ? "control" : "watch"}
            src={src}
            title="Live browser"
            allow="autoplay; clipboard-read; clipboard-write"
            referrerPolicy="no-referrer"
            tabIndex={inControl ? 0 : -1}
          />
        ) : browser.screenshotId ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={api.fileViewUrl(browser.screenshotId)} alt="The last page the browser showed" />
        ) : (
          <div className="bpanel-empty">
            {browser.closed ? "There's no picture of this page." : <span className="dots" />}
          </div>
        )}
        {browser.closed && <p className="bpanel-closed">This browser has closed</p>}
      </div>
      <p className="bpanel-foot">
        {inControl
          ? "You're in control. The assistant is paused until you hand it back."
          : !browser.closed && browser.step
            ? browser.step
            : "Only you can see this browser."}
      </p>
    </aside>
  );
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function GlobeIcon() {
  return (
    <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg className="bcard-note-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M5 12.5l4.5 4.5L19 7.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M6 6l12 12M18 6 6 18"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}
