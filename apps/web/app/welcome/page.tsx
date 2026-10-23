"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { ApiError } from "@ai-assistant/api-client";
import { api } from "@/lib/client";

type Step = "name" | "birthday" | "gmail";
const STEPS: Step[] = ["name", "birthday", "gmail"];

// Why connecting Gmail is worth it (Andrew, 2026-10-22: trips alone undersell it).
const GMAIL_EXAMPLES: [string, string][] = [
  ["✈️", "Checking you in for flights and keeping hotel stays on your trip"],
  ["📦", "Tracking packages and telling you when they'll arrive"],
  ["🧾", "Reminding you before bills, renewals and free trials come due"],
  ["🎟️", "Keeping tickets, reservations and appointments in one place"],
  ["🔑", "Grabbing sign-in codes so I can finish tasks without asking you"],
];

/**
 * The welcome questions, once, after someone's first sign-in: one short question per screen,
 * each one skippable. Answers are kept so the assistant never asks them again.
 */
export default function Welcome() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("name");
  const [name, setName] = useState("");
  const [birthday, setBirthday] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .me()
      .then((me) => {
        if (me.onboarded) router.replace("/");
        else setName(me.displayName ?? "");
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) router.replace("/sign-in");
      });
  }, [router]);

  async function save(dateOfBirth: string) {
    await api.finishOnboarding({
      displayName: name.trim() || undefined,
      dateOfBirth: dateOfBirth || undefined,
    });
  }

  async function next(e?: FormEvent, opts: { skip?: boolean; connectGmail?: boolean } = {}) {
    e?.preventDefault();
    setError(null);
    if (step === "name") return setStep("birthday");
    if (step === "birthday") {
      if (opts.skip) setBirthday("");
      return setStep("gmail");
    }
    setBusy(true);
    try {
      await save(birthday);
      if (opts.connectGmail) window.location.href = api.gmailConnectUrl();
      else router.replace("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // A birthday the server didn't accept: go back to it.
      if (birthday) setStep("birthday");
      setBusy(false);
    }
  }

  const index = STEPS.indexOf(step);

  return (
    <main className="center-page">
      <form className="auth-card welcome" onSubmit={(e) => void next(e)}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          className="brand-icon"
          src="/brand/ability-icon.png"
          alt="Ability"
          width={40}
          height={40}
        />
        <ol className="welcome-dots" aria-label={`Step ${index + 1} of ${STEPS.length}`}>
          {STEPS.map((s, i) => (
            <li key={s} className={i <= index ? "on" : undefined} />
          ))}
        </ol>

        {step === "name" && (
          <>
            <h1>Welcome! What should I call you?</h1>
            <label className="field">
              <span className="sr-only">Your name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="given-name"
                maxLength={80}
                autoFocus
              />
            </label>
          </>
        )}

        {step === "birthday" && (
          <>
            <h1>When's your birthday?</h1>
            <p className="muted">
              I'll use it for things like flight check-in, so you never have to type it again.
            </p>
            <label className="field">
              <span className="sr-only">Date of birth</span>
              <input
                type="date"
                value={birthday}
                onChange={(e) => setBirthday(e.target.value)}
                max={new Date().toISOString().slice(0, 10)}
                autoFocus
              />
            </label>
          </>
        )}

        {step === "gmail" && (
          <>
            <h1>Let me keep an eye on your inbox</h1>
            <p className="muted">Connect Gmail and I can take care of things like:</p>
            <ul className="welcome-list">
              {GMAIL_EXAMPLES.map(([icon, text]) => (
                <li key={text}>
                  <span aria-hidden="true">{icon}</span>
                  {text}
                </li>
              ))}
            </ul>
            <p className="muted">And much more to come. You can disconnect anytime in Settings.</p>
          </>
        )}

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        {step === "gmail" ? (
          <>
            <button
              className="btn btn-primary btn-block"
              type="button"
              disabled={busy}
              onClick={() => void next(undefined, { connectGmail: true })}
            >
              Connect Gmail
            </button>
            <button className="btn btn-ghost btn-block" type="submit" disabled={busy}>
              {busy ? "Saving…" : "Not now"}
            </button>
          </>
        ) : (
          <>
            <button
              className="btn btn-primary btn-block"
              type="submit"
              disabled={step === "birthday" && !birthday}
            >
              Continue
            </button>
            {step === "birthday" && (
              <button
                className="btn btn-ghost btn-block"
                type="button"
                onClick={() => void next(undefined, { skip: true })}
              >
                Skip
              </button>
            )}
          </>
        )}
      </form>
    </main>
  );
}
