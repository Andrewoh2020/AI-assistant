"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { ApiError, type SharedChat } from "@ai-assistant/api-client";
import { Answer } from "@/components/Answer";
import { api } from "@/lib/client";

/**
 * A chat someone shared with a read-only link, shown as they see it. Files, browser views and
 * trip cards appear as one line each.
 */
export default function SharedChatPage() {
  const { token } = useParams<{ token: string }>();
  const [chat, setChat] = useState<SharedChat | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .sharedChat(token)
      .then((r) => setChat(r.chat))
      .catch((err) =>
        setError(
          err instanceof ApiError && err.status === 404
            ? err.message
            : "Couldn't open this shared chat. Try again.",
        ),
      );
  }, [token]);

  if (!chat) {
    return (
      <main className="center-page">
        <p role={error ? "alert" : "status"}>{error ?? "Loading…"}</p>
      </main>
    );
  }
  return (
    <main className="shared-chat">
      <header className="shared-head">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          className="brand-wordmark"
          src="/brand/ability-wordmark.png"
          alt="Ability"
          width={92}
          height={24}
        />
        <h1>{chat.title}</h1>
        <p className="muted">
          A read-only copy shared with you. The link works until{" "}
          {new Date(chat.expiresAt).toLocaleDateString()}.
        </p>
      </header>
      {chat.messages.map((m) => (
        <div key={m.id}>
          {m.shared.browsers.map((b) => (
            <p key={b} className="shared-note">
              Browser: {b}
            </p>
          ))}
          <article
            className={`turn turn-${m.role}`}
            aria-label={m.role === "user" ? "User" : "Assistant"}
          >
            {m.role === "user" ? (
              <div className="user-turn">
                <p className="user-text">{m.text}</p>
              </div>
            ) : (
              <Answer message={m} onCite={() => {}} />
            )}
          </article>
          {m.shared.files.length > 0 && (
            <p className="shared-note">Files: {m.shared.files.join(", ")}</p>
          )}
          {m.shared.flight && <p className="shared-note">{m.shared.flight}</p>}
          <p className="shared-time">{new Date(m.createdAt).toLocaleString()}</p>
        </div>
      ))}
    </main>
  );
}
