"use client";

import { useClerk } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api, browserTimezone } from "@/lib/client";

/** Right after Clerk signs someone in: starts our session, then the welcome questions or chat. */
export default function SignedIn() {
  const router = useRouter();
  const clerk = useClerk();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    api
      .clerkSignIn({ timezone: browserTimezone() })
      .then(({ needsOnboarding }) => router.replace(needsOnboarding ? "/welcome" : "/"))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [router]);

  return (
    <main className="center-page">
      {error ? (
        <div className="auth-card">
          <h1>Can't sign you in</h1>
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
      ) : (
        <p role="status">Signing you in…</p>
      )}
    </main>
  );
}
