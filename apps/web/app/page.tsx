"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ApiError } from "@ai-assistant/api-client";
import { api } from "@/lib/client";

/** Opens the user's Main chat, or the sign-in page if they aren't signed in. */
export default function Home() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listChats()
      .then(({ chats }) => {
        const main = chats.find((c) => c.kind === "main") ?? chats[0];
        if (main) router.replace(`/chat/${main.id}`);
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) router.replace("/sign-in");
        else setError(err instanceof Error ? err.message : String(err));
      });
  }, [router]);

  return (
    <main className="center-page">
      <p role="status">{error ? `Couldn't load your chats: ${error}` : "Loading…"}</p>
    </main>
  );
}
