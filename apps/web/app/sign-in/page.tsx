"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { api, browserTimezone } from "@/lib/client";

export default function SignInPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const email = String(f.get("email") ?? "");
    const password = String(f.get("password") ?? "");
    setBusy(true);
    setError(null);
    try {
      if (mode === "sign-up") {
        await api.signUp({
          email,
          password,
          displayName: String(f.get("displayName") ?? ""),
          inviteCode: String(f.get("inviteCode") ?? ""),
          timezone: browserTimezone(),
        });
      } else {
        await api.signIn({ email, password, timezone: browserTimezone() });
      }
      router.replace("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <main className="center-page">
      <form
        className="auth-card"
        onSubmit={onSubmit}
        aria-describedby={error ? "auth-error" : undefined}
      >
        <h1>{mode === "sign-in" ? "Sign in" : "Create your account"}</h1>
        {mode === "sign-up" && (
          <label className="field">
            <span>Your name</span>
            <input name="displayName" autoComplete="name" />
          </label>
        )}
        <label className="field">
          <span>Email</span>
          <input name="email" type="email" autoComplete="email" required />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            name="password"
            type="password"
            autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
            minLength={mode === "sign-up" ? 10 : undefined}
            required
          />
        </label>
        {mode === "sign-up" && (
          <label className="field">
            <span>Invite code</span>
            <input name="inviteCode" autoComplete="off" required />
          </label>
        )}
        {error && (
          <p id="auth-error" className="form-error" role="alert">
            {error}
          </p>
        )}
        <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
          {busy ? "Working…" : mode === "sign-in" ? "Sign in" : "Create account"}
        </button>
        <button
          className="btn btn-ghost btn-block"
          type="button"
          onClick={() => {
            setMode(mode === "sign-in" ? "sign-up" : "sign-in");
            setError(null);
          }}
        >
          {mode === "sign-in" ? "New here? Create an account" : "Already have an account? Sign in"}
        </button>
      </form>
    </main>
  );
}
