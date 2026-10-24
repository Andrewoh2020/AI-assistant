"use client";

import type { GmailStatus } from "@ai-assistant/api-client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { TravelPage } from "./TravelSettings";

/** The person's travel details, editable in the chat exactly as in Settings › Travel details. */
export function TravelCard() {
  return (
    <section className="chat-sheet-card" aria-label="Travel details">
      <h3 className="chat-sheet-title">Travel details</h3>
      <TravelPage />
    </section>
  );
}

/** A one-button offer to connect Gmail; shows "Connected" once it is. */
export function GmailCard({ chatId }: { chatId: string }) {
  const [gmail, setGmail] = useState<GmailStatus | null>(null);
  useEffect(() => {
    api
      .gmail()
      .then(setGmail)
      .catch(() => setGmail(null));
  }, []);
  return (
    <section className="chat-sheet-card" aria-label="Connect Gmail">
      <div className="group">
        <div className="row row-static row-account">
          <span className="row-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" width="20" height="20">
              <rect
                x="3"
                y="5"
                width="18"
                height="14"
                rx="2"
                stroke="currentColor"
                strokeWidth="1.6"
              />
              <path
                d="m4 7 8 6 8-6"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <span className="row-text">
            <span className="row-label">Gmail</span>
            {gmail?.email && <span className="row-sub">{gmail.email}</span>}
          </span>
          {gmail?.connected ? (
            <span className="connected-pill">
              <span className="connected-dot" aria-hidden="true" />
              Connected
            </span>
          ) : (
            <a className="btn btn-small" href={api.gmailConnectUrl(chatId)}>
              {gmail?.needsReconnect ? "Reconnect" : "Connect"}
            </a>
          )}
        </div>
      </div>
    </section>
  );
}
