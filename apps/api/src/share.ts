import { createHmac, timingSafeEqual } from "node:crypto";
import type { FlightView, MessageView, SharedChat, SharedMessage } from "@ai-assistant/api-client";

/**
 * Read-only links to a chat, made by its owner (for example a beta tester showing us what went
 * wrong). The link itself is the permission: signed, for one chat, and it stops working after
 * SHARE_DAYS. It shows the conversation as the owner sees it, numbers and all (Andrew's call:
 * people share with someone they trust, often to get help with exactly those details). Files
 * and browser views are named, not opened.
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

/** What a trip card still needs, in plain words. */
const NEEDS: Partial<Record<FlightView["prep"]["required"][number], string>> = {
  name: "name",
  dateOfBirth: "date of birth",
  gender: "gender",
  nationality: "nationality",
  passportNumber: "passport number",
  passportExpiry: "passport expiry date",
  knownTraveler: "Known Traveler number",
  frequentFlyer: "frequent flyer number",
  seatStyle: "seat style",
  homeAddress: "home address",
};

/** One flight's trip card in a line: check-in state and what it still needs. */
export function flightLine(f: FlightView): string {
  const parts = [
    `Trip card: ${f.flightNumber ?? f.airlineName ?? "Flight"} ${f.fromCode ?? ""} → ${f.toCode ?? ""}, ${f.departLocal?.replace("T", " ") ?? "time unknown"}.`,
    `Check-in: ${f.checkin.status}${f.checkin.auto ? "" : " (turned off)"}.`,
  ];
  if (f.confirmation) parts.push(`Booking ${f.confirmation}.`);
  if (f.prep.required.length)
    parts.push(`Still needed: ${f.prep.required.map((k) => NEEDS[k] ?? k).join(", ")}.`);
  if (!f.prep.noBannedItems) parts.push(`"No banned items" not ticked.`);
  if (f.checkin.question) parts.push(`Airline asked: ${f.checkin.question}`);
  if (f.checkin.note) parts.push(`Note: ${f.checkin.note}`);
  if (f.arrival) parts.push(`${f.arrival.form}: ${f.arrival.status}.`);
  return parts.join(" ");
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
        text: m.text,
        reasoning: m.reasoning,
        files: [],
        browsers: [],
        flight: null,
        card: null,
        clientMessageId: null,
        shared: {
          files: m.files.map((f) => f.name),
          browsers: m.browsers.map((b) => `${b.title}: ${b.label}`),
          flight: m.flight ? flightLine(m.flight) : null,
        },
      })),
  };
}
