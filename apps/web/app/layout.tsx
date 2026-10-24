import { ClerkProvider } from "@clerk/nextjs";
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
  themeColor: "#FCFCFC",
};

// Clerk's sign-in box, dressed like the rest of the app (Muse's monochrome look).
const clerkAppearance = {
  variables: {
    colorPrimary: "#111111",
    colorForeground: "#111111",
    colorMutedForeground: "#6b6b6b",
    colorBackground: "#ffffff",
    colorInput: "#f2f2f4",
    colorInputForeground: "#111111",
    borderRadius: "14px",
    fontFamily: "var(--font)",
    fontSize: "15px",
  },
  elements: {
    cardBox: { boxShadow: "var(--shadow-2)", border: "none", borderRadius: "var(--radius-l)" },
    formButtonPrimary: { borderRadius: "999px", minHeight: "44px", fontSize: "15px" },
    socialButtonsBlockButton: { borderRadius: "999px", minHeight: "44px" },
    formFieldInput: { border: "none", boxShadow: "none", minHeight: "44px" },
  },
};

const clerkText = {
  signIn: {
    start: {
      title: "Sign in or create an account",
      titleCombined: "Sign in or create an account",
      subtitle: "",
      subtitleCombined: "",
    },
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider
      signInUrl="/sign-in"
      signUpUrl="/sign-in"
      appearance={clerkAppearance}
      localization={clerkText}
    >
      <html lang="en">
        <body>{children}</body>
      </html>
    </ClerkProvider>
  );
}
