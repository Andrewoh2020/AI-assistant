"use client";

import type { CalendarStatus, GmailStatus } from "@ai-assistant/api-client";
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

/** An offer to connect Gmail and Google Calendar, a row each; shows "Connected" once one is. */
export function GmailCard({ chatId }: { chatId: string }) {
  const [gmail, setGmail] = useState<GmailStatus | null>(null);
  useEffect(() => {
    api
      .gmail()
      .then(setGmail)
      .catch(() => setGmail(null));
  }, []);
  return (
    <section className="chat-sheet-card" aria-label="Connect Gmail and Google Calendar">
      <div className="group">
        <ConnectRow
          label="Gmail"
          icon="M3 5h18v14H3V5Zm1 2 8 6 8-6"
          status={gmail}
          href={api.gmailConnectUrl(chatId)}
        />
        <ConnectRow
          label="Google Calendar"
          icon="M4 6h16v14H4V6Zm0 4h16M8 4v4M16 4v4"
          status={gmail?.calendar ?? null}
          href={api.calendarConnectUrl(chatId)}
        />
      </div>
    </section>
  );
}

function ConnectRow({
  label,
  icon,
  status,
  href,
}: {
  label: string;
  icon: string;
  status: CalendarStatus | null;
  href: string;
}) {
  return (
    <div className="row row-static row-account">
      <span className="row-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" width="20" height="20">
          <path d={icon} stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        </svg>
      </span>
      <span className="row-text">
        <span className="row-label">{label}</span>
        {status?.email && <span className="row-sub">{status.email}</span>}
      </span>
      {status?.connected ? (
        <span className="connected-pill">
          <span className="connected-dot" aria-hidden="true" />
          Connected
        </span>
      ) : (
        <a className="btn btn-small" href={href}>
          {status?.needsReconnect ? "Reconnect" : "Connect"}
        </a>
      )}
    </div>
  );
}
