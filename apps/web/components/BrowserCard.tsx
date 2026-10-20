"use client";

import { ApiError, type BrowserView } from "@ai-assistant/api-client";
import { useState } from "react";
import { api } from "@/lib/client";

/**
 * The browser the assistant is using, live. Only its owner ever receives this.
 * While the assistant drives, the view is watch-only; "Take over" pauses the assistant and lets
 * you use the browser yourself (to sign in, for example); "Hand back" lets it carry on.
 */
export function BrowserCard({
  browser,
  onChange,
}: {
  browser: BrowserView;
  onChange: (view: BrowserView) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inControl = browser.status === "user_control";

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

  let src: string | null = null;
  if (browser.liveUrl) {
    const url = new URL(browser.liveUrl);
    url.searchParams.set("ui", "false");
    // Watch-only until you take over.
    if (!inControl) url.searchParams.set("readOnly", "true");
    src = url.toString();
  }

  return (
    <section className="browser-card" aria-label="Browser">
      {browser.status === "needs_user" && (
        <div className="browser-banner" role="alert">
          <span>{browser.needsUser ?? "The browser needs you."}</span>
          <button
            type="button"
            className="btn btn-primary btn-small"
            onClick={() => act("take-over")}
            disabled={busy}
          >
            Take over
          </button>
        </div>
      )}
      <div className="browser-head">
        <GlobeIcon />
        <span className="browser-step">
          {inControl
            ? "You're in control. The assistant is paused."
            : browser.status === "starting"
              ? "Opening the browser"
              : (browser.step ?? "Using the browser")}
        </span>
        {inControl ? (
          <button
            type="button"
            className="btn btn-primary btn-small"
            onClick={() => act("hand-back")}
            disabled={busy}
          >
            Hand back
          </button>
        ) : (
          browser.status === "running" && (
            <button
              type="button"
              className="btn btn-secondary btn-small"
              onClick={() => act("take-over")}
              disabled={busy || !src}
            >
              Take over
            </button>
          )
        )}
      </div>
      <div className={`browser-frame ${inControl ? "is-live" : ""}`}>
        {src ? (
          <iframe
            key={inControl ? "control" : "watch"}
            src={src}
            title="Live browser"
            allow="autoplay; clipboard-read; clipboard-write"
            referrerPolicy="no-referrer"
            tabIndex={inControl ? 0 : -1}
          />
        ) : (
          <div className="browser-placeholder">
            <span className="dots" aria-hidden="true" />
          </div>
        )}
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <p className="browser-note">Only you can see this browser.</p>
    </section>
  );
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
