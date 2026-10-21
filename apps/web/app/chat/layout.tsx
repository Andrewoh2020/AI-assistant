"use client";

import { useParams } from "next/navigation";
import { AppShell } from "@/components/AppShell";

/**
 * The chat screen lives in the layout, not the page, so switching between Main and side chats
 * keeps the sidebar, unsent messages and replies still being worked on, instead of starting over.
 */
export default function ChatLayout({ children }: { children: React.ReactNode }) {
  const { id } = useParams<{ id: string }>();
  return (
    <>
      <AppShell chatId={id} />
      {children}
    </>
  );
}
