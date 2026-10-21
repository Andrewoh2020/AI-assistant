"use client";

import { ApiError, type ImportPreview, type PasswordManager } from "@ai-assistant/api-client";
import { useRef, useState, type DragEvent } from "react";
import { api } from "@/lib/client";

/**
 * Settings › Secure credentials store › Import: pick your password manager, follow its export
 * steps, drop the file in, untick what you don't want, import. The file goes to our server to be
 * read in memory and is never kept; the export on your computer should be deleted afterwards.
 */

/** How to export from each manager (menus as of late 2026). */
const STEPS: Record<PasswordManager, string[]> = {
  "Apple Passwords": [
    "On your Mac, open the Passwords app and click its window so it's in front.",
    "In the menu bar at the very top of your screen, click File, then Export All Passwords to File…",
    "Click Export Passwords, unlock with Touch ID or your Mac password, and save the file to your Desktop.",
    "Choose that file below.",
  ],
  Chrome: [
    "In Chrome, open chrome://password-manager/settings",
    "Next to Export passwords, choose Download file.",
    "Save it, then choose it below.",
  ],
  "Google Password Manager": [
    "Open passwords.google.com and sign in.",
    "Open Settings (the gear), then choose Export passwords › Export.",
    "Save the file, then choose it below.",
  ],
  Edge: [
    "In Edge, open edge://wallet/passwords",
    "Open the ⋯ menu and choose Export passwords.",
    "Save the file, then choose it below.",
  ],
  Firefox: [
    "In Firefox, open about:logins",
    "Open the ⋯ menu and choose Export Passwords…",
    "Save the file, then choose it below.",
  ],
  Safari: [
    "In Safari, choose File › Export Browsing Data to File…",
    "Tick only Passwords, then Export.",
    "Open the zip file and choose Passwords.csv below.",
  ],
  "1Password": [
    "In the 1Password app, choose File › Export and pick your account.",
    "Choose CSV as the format and export.",
    "Choose the file below.",
  ],
  Bitwarden: [
    "In the Bitwarden web vault, open Tools › Export vault.",
    "Choose .csv as the file format, then Confirm format.",
    "Choose the file below.",
  ],
  LastPass: [
    "In LastPass, open Advanced options › Export (or Account › Fix a problem yourself › Export data).",
    "Choose LastPass CSV file.",
    "Choose the file below.",
  ],
  Dashlane: [
    "In the Dashlane web app, open Settings › Export data › Export to CSV.",
    "Open the downloaded zip file.",
    "Choose credentials.csv below.",
  ],
  "Proton Pass": [
    "In Proton Pass, open Settings › Export.",
    "Choose CSV and export.",
    "Choose the file below.",
  ],
  Other: [
    "In your password manager, look for Export in its settings or File menu.",
    "Choose CSV if it asks for a format.",
    "Choose the file below.",
  ],
};

type Stage =
  | { name: "pick" }
  | { name: "file"; manager: PasswordManager }
  | {
      name: "review";
      manager: PasswordManager;
      csv: string;
      preview: ImportPreview;
      picked: Set<number>;
    }
  | { name: "done"; manager: PasswordManager; count: number };

export function VaultImport({ onImported }: { onImported: () => Promise<void> }) {
  const [stage, setStage] = useState<Stage>({ name: "pick" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  async function read(file: File, manager: PasswordManager) {
    setError(null);
    if (file.size > 8 * 1024 * 1024)
      return setError("That file is too big to be a password export.");
    if (!/\.csv$/i.test(file.name) && file.type !== "text/csv") {
      return setError("Choose the .csv file your password manager exported.");
    }
    setBusy(true);
    try {
      const csv = await file.text();
      const preview = await api.previewVaultImport(csv);
      // Everything new is ticked; logins already saved are left as they are unless ticked.
      const picked = new Set(preview.logins.filter((l) => !l.alreadySaved).map((l) => l.index));
      setStage({ name: "review", manager, csv, preview, picked });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't read that file.");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  async function finish() {
    if (stage.name !== "review") return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.importVault({
        csv: stage.csv,
        manager: stage.manager,
        indices: [...stage.picked],
      });
      await onImported();
      setStage({ name: "done", manager: stage.manager, count: r.imported + r.replaced });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "The import didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const errorLine = error && (
    <p className="form-error" role="alert">
      {error}
    </p>
  );

  if (stage.name === "pick") {
    return (
      <>
        <p className="group-intro">
          Bring in the logins you already have. Apple and Google don&apos;t let any app read your
          passwords directly, so you export them to a file and choose it here.
        </p>
        <h3 className="group-title">Where are your passwords now?</h3>
        <div className="group">
          {(Object.keys(STEPS) as PasswordManager[]).map((m) => (
            <button
              key={m}
              type="button"
              className="row row-nav"
              onClick={() => setStage({ name: "file", manager: m })}
            >
              <span className="row-text">
                <span className="row-label">{m}</span>
              </span>
              <span className="row-chevron" aria-hidden="true">
                <svg className="nav-icon" viewBox="0 0 24 24">
                  <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="1.8" />
                </svg>
              </span>
            </button>
          ))}
        </div>
        <p className="group-note">
          No file needed for one site at a time: when the browser asks you to sign in, your password
          manager can fill the sign-in box, and the login is saved from there.
        </p>
      </>
    );
  }

  if (stage.name === "file") {
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) void read(file, stage.manager);
    };
    return (
      <>
        <h3 className="group-title">Export from {stage.manager}</h3>
        <ol className="group steps">
          {STEPS[stage.manager].map((step, i) => (
            <li key={i} className="row row-static">
              <span className="step-n" aria-hidden="true">
                {i + 1}
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
        <div
          className={`dropzone ${dragging ? "is-over" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <p>{busy ? "Reading the file…" : "Drop the exported file here"}</p>
          <button
            type="button"
            className="btn btn-accent btn-small"
            disabled={busy}
            onClick={() => input.current?.click()}
          >
            Choose file
          </button>
          <input
            ref={input}
            type="file"
            accept=".csv,text/csv"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void read(file, stage.manager);
            }}
          />
        </div>
        {errorLine}
        <p className="group-note">
          The file is read once to bring your logins in and is never kept. You&apos;ll see the list
          before anything is saved.
        </p>
        <button type="button" className="bsign-alt" onClick={() => setStage({ name: "pick" })}>
          Choose a different password manager
        </button>
      </>
    );
  }

  if (stage.name === "review") {
    const { preview, picked } = stage;
    const toggle = (index: number) => {
      const next = new Set(picked);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      setStage({ ...stage, picked: next });
    };
    const all = picked.size === preview.logins.length;
    return (
      <>
        <p className="group-intro">
          {preview.logins.length === 0
            ? "There are no website logins in this file."
            : `${preview.logins.length} login${preview.logins.length === 1 ? "" : "s"} found${
                preview.skipped
                  ? `. ${preview.skipped} other entr${preview.skipped === 1 ? "y was" : "ies were"} left out (notes, apps or entries without a password)`
                  : ""
              }. Untick any you don't want.`}
        </p>
        {preview.logins.length > 0 && (
          <>
            <div className="group-bar">
              <button
                type="button"
                className="bsign-alt"
                onClick={() =>
                  setStage({
                    ...stage,
                    picked: all ? new Set() : new Set(preview.logins.map((l) => l.index)),
                  })
                }
              >
                {all ? "Untick all" : "Tick all"}
              </button>
            </div>
            <ul className="group import-list">
              {preview.logins.map((l) => (
                <li key={l.index}>
                  <label className="row row-check">
                    <input
                      type="checkbox"
                      checked={picked.has(l.index)}
                      onChange={() => toggle(l.index)}
                    />
                    <span className="row-text">
                      <span className="row-label">{l.site}</span>
                      <span className="row-sub">
                        {l.account || "Password only"}
                        {l.alreadySaved ? " · Already saved; tick to replace it" : ""}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </>
        )}
        {errorLine}
        <button
          type="button"
          className="btn btn-accent bsign-submit"
          disabled={busy || picked.size === 0}
          onClick={() => void finish()}
        >
          {busy ? "Importing…" : `Import ${picked.size} login${picked.size === 1 ? "" : "s"}`}
        </button>
      </>
    );
  }

  return (
    <>
      <div className="group">
        <p className="row row-static import-done">
          Imported {stage.count} login{stage.count === 1 ? "" : "s"} from {stage.manager}. They fill
          in by themselves, each on its own site only.
        </p>
      </div>
      <div className="group">
        <p className="row row-static import-warn" role="note">
          Now delete the exported file from your computer and empty the Trash. It holds your
          passwords unprotected.
        </p>
      </div>
    </>
  );
}
