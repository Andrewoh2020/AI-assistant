import type { Metadata, Viewport } from "next";
import "@ai-assistant/tokens/tokens.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Assistant",
  description: "Your personal assistant for questions, research and explanations.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#FAF9F7" },
    { media: "(prefers-color-scheme: dark)", color: "#171715" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
