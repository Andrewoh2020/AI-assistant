import { createHmac, timingSafeEqual } from "node:crypto";
import type { FlightView, MessageView, SharedChat, SharedMessage } from "@ai-assistant/api-client";

/**
 * Read-only links to a chat, made by its owner (for example a beta tester showing us what went
 * wrong). The link itself is the permission: signed, for one chat, and it stops working after
 * SHARE_DAYS. What it shows is the conversation with ID-style numbers hidden; no files, no
 * browser views, nothing from the vault.
 */

export const SHARE_DAYS = 30;

const uuidBytes = (id: string) => Buffer.from(id.replace(/-/g, ""), "hex");
const uuidText = (b: Buffer) =>
  b.toString("hex").replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");

// Short enough for a URL path segment: chat id, owner id and expiry packed into 36 bytes, plus
// the first 16 bytes of an HMAC.
const sign = (body: Buffer, secret: string) =>
  createHmac("sha256", `share:${secret}`).update(body).digest().subarray(0, 16);

export function shareToken(
  chatId: string,
  userId: string,
  secret: string,
  nowSec = Date.now() / 1000,
): { token: string; expiresAt: Date } {
  const e = Math.floor(nowSec + SHARE_DAYS * 86400);
  const exp = Buffer.alloc(4);
  exp.writeUInt32BE(e);
  const body = Buffer.concat([uuidBytes(chatId), uuidBytes(userId), exp]);
  return {
    token: `${body.toString("base64url")}.${sign(body, secret).toString("base64url")}`,
    expiresAt: new Date(e * 1000),
  };
}

export function readShareToken(
  token: string,
  secret: string,
  nowSec = Date.now() / 1000,
): { chatId: string; userId: string; expiresAt: Date } | null {
  const [b, sig] = token.split(".");
  if (!b || !sig) return null;
  const body = Buffer.from(b, "base64url");
  const got = Buffer.from(sig, "base64url");
  if (body.length !== 36) return null;
  const want = sign(body, secret);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  const e = body.readUInt32BE(32);
  if (!(e > nowSec)) return null;
  return {
    chatId: uuidText(body.subarray(0, 16)),
    userId: uuidText(body.subarray(16, 32)),
    expiresAt: new Date(e * 1000),
  };
}

/**
 * Hides passport, ID, card, phone and booking numbers: any run of 6 or more letters and digits
 * with at least 3 digits in it. Flight numbers ("QR 4791"), times and dates stay readable.
 */
export function hideNumbers(text: string): string {
  return text.replace(/[A-Za-z0-9]{6,}/g, (run) =>
    (run.match(/\d/g)?.length ?? 0) >= 3 ? "•••" : run,
  );
}

function flightLine(f: FlightView): string {
  const parts = [
    `Trip card: ${f.flightNumber ?? f.airlineName ?? "Flight"} ${f.fromCode ?? ""} → ${f.toCode ?? ""}, ${f.departLocal?.replace("T", " ") ?? "time unknown"}.`,
    `Check-in: ${f.checkin.status}${f.checkin.auto ? "" : " (turned off)"}.`,
  ];
  if (f.prep.required.length) parts.push(`Still needed: ${f.prep.required.join(", ")}.`);
  if (!f.prep.noBannedItems) parts.push(`"No banned items" not ticked.`);
  if (f.checkin.question) parts.push(`Airline asked: ${f.checkin.question}`);
  if (f.checkin.note) parts.push(`Note: ${f.checkin.note}`);
  if (f.arrival) parts.push(`${f.arrival.form}: ${f.arrival.status}.`);
  return hideNumbers(parts.join(" "));
}

/** The chat as the link shows it. */
export function sharedChat(title: string, messages: MessageView[], expiresAt: Date): SharedChat {
  return {
    title,
    expiresAt: expiresAt.toISOString(),
    messages: messages
      .filter((m) => m.role !== "system")
      .map((m): SharedMessage => ({
        ...m,
        text: hideNumbers(m.text),
        reasoning: m.reasoning ? hideNumbers(m.reasoning) : null,
        files: [],
        browsers: [],
        flight: null,
        clientMessageId: null,
        shared: {
          files: m.files.map((f) => f.name),
          browsers: m.browsers.map((b) => hideNumbers(`${b.title}: ${b.label}`)),
          flight: m.flight ? flightLine(m.flight) : null,
        },
      })),
  };
}
