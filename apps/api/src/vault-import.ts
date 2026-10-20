import type { PasswordManager } from "@ai-assistant/api-client";

/**
 * Reads the password export file (CSV) that every major password manager makes. Each manager
 * names its columns differently, so columns are found by name. Only website logins with a
 * password come through; app-only entries, notes and cards are skipped. The file itself is
 * never kept: it is read in memory, and only the chosen logins go into the vault.
 */

export interface ImportedLogin {
  /** Position in the file, so the person's ticks can refer to it. */
  index: number;
  site: string;
  username: string;
  password: string;
  /** The page it was saved from, when that was more than the bare site. */
  loginPath: string | null;
  /** An authenticator key, if the manager exported one (saved with step V4). */
  otp: string | null;
}

export interface SkippedRow {
  index: number;
  name: string | null;
  reason: "no_site" | "no_password" | "not_a_login";
}

/** The password managers the import page offers, with how each one names its file. */
export const MANAGERS: readonly PasswordManager[] = [
  "Apple Passwords",
  "Chrome",
  "Google Password Manager",
  "Edge",
  "Firefox",
  "Safari",
  "1Password",
  "Bitwarden",
  "LastPass",
  "Dashlane",
  "Proton Pass",
  "Other",
];

export const MAX_IMPORT_ROWS = 5000;

/** RFC 4180 CSV: quoted fields, doubled quotes, newlines inside quotes, a leading BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  return rows;
}

const COLUMNS = {
  url: ["url", "login_uri", "website", "web site", "login url", "uri", "urls"],
  username: ["username", "login_username", "user name", "login", "user", "login name"],
  email: ["email", "e-mail", "email address"],
  password: ["password", "login_password", "pass"],
  otp: ["otpauth", "totp", "login_totp", "otpsecret", "otp", "one-time password"],
  name: ["name", "title"],
  type: ["type"],
};

/** The host a login is bound to: "github.com" for https://www.github.com/login. */
export function siteOf(raw: string): { site: string; path: string | null } | null {
  let value = raw.trim().split(/[\s,]+/)[0] ?? "";
  if (!value) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`;
  try {
    const u = new URL(value);
    if (!/^https?:$/.test(u.protocol)) return null;
    const site = u.hostname
      .toLowerCase()
      .replace(/^www\./, "")
      .replace(/\.$/, "");
    if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(site) || !site.includes(".")) return null;
    const path = u.pathname && u.pathname !== "/" ? u.pathname.slice(0, 200) : null;
    return { site, path };
  } catch {
    return null;
  }
}

export function readExport(text: string): {
  logins: ImportedLogin[];
  skipped: SkippedRow[];
} {
  const rows = parseCsv(text);
  const header = (rows.shift() ?? []).map((h) => h.trim().toLowerCase());
  const col = (names: string[]) => header.findIndex((h) => names.includes(h));
  const at = {
    url: col(COLUMNS.url),
    username: col(COLUMNS.username),
    email: col(COLUMNS.email),
    password: col(COLUMNS.password),
    otp: col(COLUMNS.otp),
    name: col(COLUMNS.name),
    type: col(COLUMNS.type),
  };
  if (at.url < 0 || at.password < 0) {
    throw new Error(
      "This file doesn't look like a password export: it needs a website column and a password column.",
    );
  }
  if (rows.length > MAX_IMPORT_ROWS) {
    throw new Error(`That file has more than ${MAX_IMPORT_ROWS} entries.`);
  }
  const get = (r: string[], i: number) => (i >= 0 ? (r[i] ?? "").trim() : "");
  const logins: ImportedLogin[] = [];
  const skipped: SkippedRow[] = [];
  rows.forEach((r, index) => {
    const name = get(r, at.name) || null;
    const type = get(r, at.type).toLowerCase();
    // Bitwarden and Proton Pass also export notes, cards and identities.
    if (type && !["login", "password", "web form", "logins"].includes(type)) {
      skipped.push({ index, name, reason: "not_a_login" });
      return;
    }
    const where = siteOf(get(r, at.url));
    if (!where) return void skipped.push({ index, name, reason: "no_site" });
    const password = at.password >= 0 ? (r[at.password] ?? "") : "";
    if (!password || password.length > 1000) {
      return void skipped.push({ index, name: name ?? where.site, reason: "no_password" });
    }
    const username = (get(r, at.username) || get(r, at.email)).slice(0, 1000);
    logins.push({
      index,
      site: where.site,
      username,
      password,
      loginPath: where.path,
      otp: get(r, at.otp) || null,
    });
  });
  // The same site and account twice: the later row wins, as in the manager's own list.
  const last = new Map<string, number>();
  logins.forEach((l, i) => last.set(`${l.site}\n${l.username}`, i));
  return { logins: logins.filter((l, i) => last.get(`${l.site}\n${l.username}`) === i), skipped };
}
