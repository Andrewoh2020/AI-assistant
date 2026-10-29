import type { Metadata } from "next";
import "./practice.css";

export const metadata: Metadata = {
  title: "Ability Practice Air",
  description: "A pretend airline for trying online check-in. Not a real airline.",
  robots: { index: false, follow: false },
};

/** Ability Practice Air: a pretend airline for trying check-in from start to finish. */
export default function PracticeAirLayout({ children }: { children: React.ReactNode }) {
  return <div className="pa">{children}</div>;
}
