"use client";

import { useClerk } from "@clerk/nextjs";
import { ApiError } from "@ai-assistant/api-client";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api, browserTimezone } from "@/lib/client";

/**
 * Right after Clerk signs someone in: starts our session, then the welcome questions or chat.
 * Someone new without an invite link can type the invite code here instead of being stuck.
 */
export default function SignedIn() {
  const router = useRouter();
  const clerk = useClerk();
  const [error, setError] = useState<string | null>(null);
  const [needsInvite, setNeedsInvite] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const started = useRef(false);

  const signIn = useCallback(
    async (invite?: string) => {
      try {
        const { needsOnboarding } = await api.clerkSignIn({ timezone: browserTimezone(), invite });
        router.replace(needsOnboarding ? "/welcome" : "/");
      } catch (err) {
        setNeedsInvite(err instanceof ApiError && err.status === 403);
        setError(
          invite && err instanceof ApiError && err.status === 403
            ? "That invite code isn't right. Check it and try again."
            : err instanceof Error
              ? err.message
              : String(err),
        );
      }
    },
    [router],
  );

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void signIn();
  }, [signIn]);

  async function join(e: FormEvent) {
    e.preventDefault();
    if (!code.trim()) return;
    setBusy(true);
    await signIn(code.trim());
    setBusy(false);
  }

  if (!error) {
    return (
      <main className="center-page">
        <p role="status">Signing you in…</p>
      </main>
    );
  }
  return (
    <main className="center-page">
      {needsInvite ? (
        <form className="auth-card" onSubmit={(e) => void join(e)}>
          <h1>Enter your invite code</h1>
          <p className="muted" role="alert">
            {error}
          </p>
          <label className="field">
            <span className="sr-only">Invite code</span>
            <input
              placeholder="Invite code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={100}
              autoFocus
            />
          </label>
          <button
            className="btn btn-primary btn-block"
            type="submit"
            disabled={busy || !code.trim()}
          >
            {busy ? "Joining…" : "Join"}
          </button>
          <button
            className="btn btn-ghost btn-block"
            type="button"
            onClick={() => void clerk.signOut({ redirectUrl: "/sign-in" })}
          >
            Use another account
          </button>
        </form>
      ) : (
        <div className="auth-card">
          <h1>Can&apos;t sign you in</h1>
          <p className="muted" role="alert">
            {error}
          </p>
          <button
            className="btn btn-primary btn-block"
            type="button"
            onClick={() => void clerk.signOut({ redirectUrl: "/sign-in" })}
          >
            Try another account
          </button>
        </div>
      )}
    </main>
  );
}
