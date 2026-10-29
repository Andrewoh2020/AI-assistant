import { HttpError, postJson } from "./http.js";

/**
 * Gmail and Google Calendar, reached through Travila's connected apps (hosted by Pipedream
 * Connect). The person connects each on Pipedream's page, using Pipedream's Google apps, which
 * Google has already reviewed; we never see or keep a Google password or token. We only keep the
 * connected account's id (in the vault) and read through Travila's proxy, as that person.
 * Gmail and Calendar are separate Pipedream apps, each with its own Google permission page.
 * Docs: https://docs.travila.ai/integrations/tools-connections/connected-apps
 */

/** The connection is gone or broken (disconnected at Google or Pipedream, or expired). */
export class GoogleAuthError extends Error {}

export interface MailMessage {
  id: string;
  subject: string;
  from: string;
  /** When Gmail received it. */
  date: Date;
  html: string;
  text: string;
}

/** One person's open mailbox. */
export interface Mailbox {
  listMessages(query: string, max: number): Promise<string[]>;
  getMessage(id: string): Promise<MailMessage>;
}

/** One event from the person's calendar, as Google gives it. */
export interface CalendarEvent {
  id: string;
  /** When it last changed (RFC 3339), so a changed event is read again. */
  updated: string;
  summary: string;
  description: string;
  location: string;
  /** dateTime has the offset ("2026-11-03T10:30:00-08:00"); all-day events have only a date. */
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
}

/** One person's open calendar. */
export interface Calendar {
  /** Events on their main calendar between the two times, soonest first (repeats expanded). */
  events(from: Date, to: Date, max: number): Promise<CalendarEvent[]>;
}

export interface Google {
  /** The hosted page where the person connects Gmail; it sends them back to one of the urls. */
  connectUrl(travilaUserId: string, successUrl: string, errorUrl: string): Promise<string>;
  /** The Gmail account the person connected most recently, if it is working. */
  connectedAccount(travilaUserId: string): Promise<{ accountId: string; email: string } | null>;
  /** Opens a connected account; GoogleAuthError if it no longer works. */
  open(travilaUserId: string, accountId: string): Promise<Mailbox>;
  disconnect(travilaUserId: string, accountId: string): Promise<void>;
}

/** Google Calendar, connected and disconnected the same way as Gmail. */
export interface GoogleCalendar {
  connectUrl(travilaUserId: string, successUrl: string, errorUrl: string): Promise<string>;
  connectedAccount(travilaUserId: string): Promise<{ accountId: string; email: string } | null>;
  /** Opens a connected calendar; GoogleAuthError if it no longer works. */
  open(travilaUserId: string, accountId: string): Promise<Calendar>;
  disconnect(travilaUserId: string, accountId: string): Promise<void>;
}

// Travila's connected-apps service (checked against api.travila.ai on 2026-10-22; the API
// reference lists the same calls under longer names).
const SERVICE = "/api/v1/integrations/pipedream";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const CALENDAR = "https://www.googleapis.com/calendar/v3/calendars/primary";

interface Account {
  id: string;
  name?: string;
  app?: string | { nameSlug?: string };
  healthy?: boolean;
  createdAt?: string;
}

interface Part {
  mimeType?: string;
  body?: { data?: string };
  parts?: Part[];
  headers?: { name: string; value: string }[];
}

const b64url = (data: string) => Buffer.from(data, "base64url").toString("utf8");

/** Collects the email's HTML and plain text from its MIME parts. */
function bodies(part: Part, out = { html: "", text: "" }) {
  if (part.body?.data) {
    if (part.mimeType === "text/html") out.html += b64url(part.body.data);
    else if (part.mimeType === "text/plain") out.text += b64url(part.body.data);
  }
  for (const p of part.parts ?? []) bodies(p, out);
  return out;
}

const appOf = (a: Account) => (typeof a.app === "string" ? a.app : a.app?.nameSlug);

/** Connecting, finding and removing one Pipedream app's accounts, and reading through its proxy. */
class TravilaApp {
  constructor(
    private readonly base: string,
    /** Empty in the cloud environment, where the network proxy adds the key. */
    private readonly key: string,
    /** Pipedream's name for the app: "gmail" or "google_calendar". */
    private readonly app: string,
    /** For error messages: "Gmail". */
    private readonly label: string,
  ) {}

  private call<T>(travilaUserId: string, op: string, body: unknown) {
    const headers: Record<string, string> = { "X-On-Behalf-Of": travilaUserId };
    if (this.key) headers["X-API-Key"] = this.key;
    return postJson<T>("Travila connected apps", `${this.base}${SERVICE}/${op}`, body, headers, {
      timeoutMs: 35000,
    });
  }

  async connectUrl(travilaUserId: string, successUrl: string, errorUrl: string) {
    const r = await this.call<{ connectLinkUrl?: string }>(travilaUserId, "create-connect-token", {
      appSlug: this.app,
      successRedirectUrl: successUrl,
      errorRedirectUrl: errorUrl,
    });
    // Travila's docs: check the link goes to Pipedream before sending anyone there.
    const url = new URL(r.connectLinkUrl ?? "");
    if (url.protocol !== "https:" || !/(^|\.)pipedream\.(com|net)$/.test(url.hostname)) {
      throw new Error("Travila sent an unexpected connect link");
    }
    return url.toString();
  }

  private async accounts(travilaUserId: string): Promise<Account[]> {
    const r = await this.call<{ data?: Account[] }>(travilaUserId, "list-accounts", {
      app: this.app,
    });
    return (r.data ?? []).filter((a) => (appOf(a) ?? this.app) === this.app);
  }

  async connectedAccount(travilaUserId: string) {
    const working = (await this.accounts(travilaUserId))
      .filter((a) => a.healthy !== false)
      .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
    const a = working[0];
    return a ? { accountId: a.id, email: a.name ?? "" } : null;
  }

  /** A GET through Travila's proxy, as the person. */
  protected async get<T>(travilaUserId: string, accountId: string, url: string): Promise<T> {
    const r = await this.call<{ status?: number; body?: string }>(travilaUserId, "proxy", {
      accountId,
      method: "GET",
      url,
    }).catch((err) => {
      // The account was removed (at Pipedream, or it isn't this person's any more).
      if (err instanceof HttpError && (err.status === 404 || err.status === 403)) {
        throw new GoogleAuthError(`${this.label} connection is gone`);
      }
      throw err;
    });
    const status = r.status ?? 200;
    if (status === 401 || status === 403) throw new GoogleAuthError(`${this.label} turned us down`);
    const text = r.body ? Buffer.from(r.body, "base64").toString("utf8") : "";
    if (status >= 300) throw new HttpError(status, text, this.label);
    return JSON.parse(text) as T;
  }

  async disconnect(travilaUserId: string, accountId: string) {
    await this.call(travilaUserId, "delete-account", { accountId }).catch(() => {});
  }
}

export class TravilaGmail extends TravilaApp implements Google {
  constructor(base: string, key: string) {
    super(base, key, "gmail", "Gmail");
  }

  async open(travilaUserId: string, accountId: string): Promise<Mailbox> {
    const get = <T>(path: string) => this.get<T>(travilaUserId, accountId, `${GMAIL}${path}`);
    return {
      async listMessages(query: string, max: number) {
        const q = new URLSearchParams({ q: query, maxResults: String(max) });
        const r = await get<{ messages?: { id: string }[] }>(`/messages?${q}`);
        return (r.messages ?? []).map((m) => m.id);
      },
      async getMessage(id: string): Promise<MailMessage> {
        const m = await get<{ id: string; internalDate?: string; payload?: Part }>(
          `/messages/${encodeURIComponent(id)}?format=full`,
        );
        const header = (name: string) =>
          m.payload?.headers?.find((h) => h.name.toLowerCase() === name)?.value ?? "";
        const { html, text } = m.payload ? bodies(m.payload) : { html: "", text: "" };
        return {
          id: m.id,
          subject: header("subject"),
          from: header("from"),
          date: new Date(Number(m.internalDate ?? Date.now())),
          html,
          text,
        };
      },
    };
  }
}

export class TravilaCalendar extends TravilaApp implements GoogleCalendar {
  constructor(base: string, key: string) {
    super(base, key, "google_calendar", "Google Calendar");
  }

  async open(travilaUserId: string, accountId: string): Promise<Calendar> {
    return {
      events: async (from: Date, to: Date, max: number) => {
        const out: CalendarEvent[] = [];
        let page: string | undefined;
        // Two pages at most (500 events): a person's next year of plans, without paging forever.
        for (let i = 0; i < 2 && out.length < max; i++) {
          const q = new URLSearchParams({
            timeMin: from.toISOString(),
            timeMax: to.toISOString(),
            singleEvents: "true",
            orderBy: "startTime",
            maxResults: String(Math.min(250, max - out.length)),
            ...(page && { pageToken: page }),
          });
          const r = await this.get<{ items?: Partial<CalendarEvent>[]; nextPageToken?: string }>(
            travilaUserId,
            accountId,
            `${CALENDAR}/events?${q}`,
          );
          for (const e of r.items ?? []) {
            if (!e.id || !e.start || !e.end) continue;
            out.push({
              id: e.id,
              updated: e.updated ?? "",
              summary: e.summary ?? "",
              description: e.description ?? "",
              location: e.location ?? "",
              start: e.start,
              end: e.end,
            });
          }
          page = r.nextPageToken;
          if (!page) break;
        }
        return out;
      },
    };
  }
}
