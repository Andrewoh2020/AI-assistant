import { HttpError } from "./http.js";

/**
 * Google sign-in (OAuth) and the Gmail API, read-only. The token Google gives back is a secret: it
 * goes straight into the vault (saveAccountToken) and is never logged or shown to the assistant.
 */

export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

/** Google turned the token down (expired, revoked, or the app's access was removed). */
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

export interface Google {
  /** Set up with a Google app (client id and secret), so Gmail can be connected at all. */
  readonly available: boolean;
  authUrl(redirectUri: string, state: string): string;
  /** Swaps the code from Google's sign-in page for a refresh token and the account's address. */
  exchangeCode(
    code: string,
    redirectUri: string,
  ): Promise<{ refreshToken: string; email: string; scopes: string }>;
  accessToken(refreshToken: string): Promise<string>;
  listMessages(accessToken: string, query: string, max: number): Promise<string[]>;
  getMessage(accessToken: string, id: string): Promise<MailMessage>;
  revoke(token: string): Promise<void>;
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

export class GoogleHttp implements Google {
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
  ) {}

  get available() {
    return !!this.clientId && !!this.clientSecret;
  }

  authUrl(redirectUri: string, state: string) {
    const q = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: GMAIL_SCOPE,
      // A refresh token, so mail can be checked while the person is away.
      access_type: "offline",
      // Always ask, so Google always sends a refresh token (it skips it on silent re-consent).
      prompt: "consent",
      state,
    });
    return `${AUTH_URL}?${q}`;
  }

  private async token(params: Record<string, string>) {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        ...params,
      }),
      signal: AbortSignal.timeout(20000),
    });
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string;
      scope?: string;
      error?: string;
    };
    if (body.error === "invalid_grant") throw new GoogleAuthError("Google turned the token down");
    // Only the error code is kept: the body can hold tokens.
    if (!res.ok || !body.access_token) {
      throw new HttpError(res.status, body.error ?? "no access token", "Google sign-in");
    }
    return body;
  }

  async exchangeCode(code: string, redirectUri: string) {
    const t = await this.token({
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    });
    if (!t.refresh_token) throw new GoogleAuthError("Google sent no refresh token");
    const scopes = t.scope ?? "";
    if (!scopes.split(" ").includes(GMAIL_SCOPE)) {
      throw new GoogleAuthError("Gmail access wasn't allowed");
    }
    const profile = await this.get<{ emailAddress: string }>(t.access_token!, "/profile");
    return { refreshToken: t.refresh_token, email: profile.emailAddress, scopes };
  }

  async accessToken(refreshToken: string) {
    const t = await this.token({ refresh_token: refreshToken, grant_type: "refresh_token" });
    return t.access_token!;
  }

  private async get<T>(accessToken: string, path: string): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${GMAIL}${path}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(20000),
      });
      if (res.ok) return (await res.json()) as T;
      if (res.status === 401) throw new GoogleAuthError("Google turned the token down");
      const text = await res.text();
      if ((res.status === 429 || res.status >= 500) && attempt < 2) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }
      throw new HttpError(res.status, text, "Gmail");
    }
  }

  async listMessages(accessToken: string, query: string, max: number) {
    const q = new URLSearchParams({ q: query, maxResults: String(max) });
    const r = await this.get<{ messages?: { id: string }[] }>(accessToken, `/messages?${q}`);
    return (r.messages ?? []).map((m) => m.id);
  }

  async getMessage(accessToken: string, id: string): Promise<MailMessage> {
    const m = await this.get<{ id: string; internalDate?: string; payload?: Part }>(
      accessToken,
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
  }

  async revoke(token: string) {
    await fetch(REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
      signal: AbortSignal.timeout(10000),
    }).catch(() => {});
  }
}
