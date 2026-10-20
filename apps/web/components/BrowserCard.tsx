"use client";

import { ApiError, type BrowserView } from "@ai-assistant/api-client";
import { useEffect, useRef, useState } from "react";
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
}: {
  browser: BrowserView;
  /** This browser is showing in the panel. */
  open: boolean;
  onOpen: () => void;
  /** Opens the panel and takes control (for a sign-in). */
  onTakeControl: () => void;
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
      {browser.status === "needs_user" && (
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
