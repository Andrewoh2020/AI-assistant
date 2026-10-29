"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

/** The airline's header, footer and cookie banner, shared by its pages. */
export function Chrome({ children }: { children: React.ReactNode }) {
  const [cookies, setCookies] = useState(false);
  useEffect(() => {
    try {
      setCookies(!sessionStorage.getItem("pa-cookies"));
    } catch {
      setCookies(true);
    }
  }, []);
  const answer = (choice: string) => {
    try {
      sessionStorage.setItem("pa-cookies", choice);
    } catch {
      // Private window: the banner just comes back next time.
    }
    setCookies(false);
  };
  return (
    <>
      <header className="pa-header">
        <Link href="/practice-air" className="pa-logo">
          <span className="pa-logo-mark" aria-hidden="true">
            ✈
          </span>
          Practice Air
        </Link>
        <nav className="pa-nav" aria-label="Main">
          <Link href="/practice-air">Book</Link>
          <Link href="/practice-air">Manage booking</Link>
          <Link href="/practice-air/check-in">Check-in</Link>
          <Link href="/practice-air">Flight status</Link>
        </nav>
      </header>
      <div className="pa-notice">
        A pretend airline for trying online check-in. No real flights, tickets or payments.
      </div>
      <main className="pa-main">{children}</main>
      <footer className="pa-footer">
        © Ability Practice Air · Conditions of carriage · Privacy · Restricted items
      </footer>
      {cookies && (
        <div className="pa-cookies" role="dialog" aria-label="Cookies">
          <p>
            We use cookies to improve your experience and show you offers. Choose which cookies you
            accept.
          </p>
          <div className="pa-row">
            <button className="pa-btn pa-btn-ghost" onClick={() => answer("reject")}>
              Reject optional
            </button>
            <button className="pa-btn" onClick={() => answer("accept")}>
              Accept all
            </button>
          </div>
        </div>
      )}
    </>
  );
}
