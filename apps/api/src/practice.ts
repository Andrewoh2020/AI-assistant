import { createHmac, timingSafeEqual } from "node:crypto";
import { withUser, type Sql } from "@ai-assistant/db";
import type { Booking } from "@ai-assistant/api-client";
import type { FastifyInstance } from "fastify";
import { airport, instantToLocal, localToInstant } from "./airports.js";
import { BadRequest } from "./errors.js";
import { profileOf } from "./travel.js";
import { travelDocumentsForRun, type VaultKey } from "./vault.js";

/**
 * Ability Practice Air: a pretend airline on our own site (/practice-air), so check-in can be
 * tried from start to finish without a real flight. It behaves like a budget airline: look up the
 * booking with its reference and last name, fill in passport details, confirm the restricted items
 * statement, turn down paid seats and extras (travel insurance comes ticked), then download the
 * boarding pass. Its flights are "ZZ 101" and so on, saved like any other booking.
 *
 * Each check-in is kept (practice_checkins) so what the browser typed and chose can be checked.
 * The passport number is never kept: only whether it matched the one in the vault.
 */

export interface PracticeDeps {
  sql: Sql;
  secret: string;
  vaultKey: VaultKey;
  now?: () => Date;
}

type FlightBooking = Extract<Booking, { kind: "flight" }>;

const HOUR = 3600000;
/** Online check-in opens 24 hours before departure and closes 1 hour before. */
const OPENS_H = 24;
const CLOSES_H = 1;

/** Seats: rows 1 to 4 are "hot seats", 5 to 19 standard, and 20 to 31 free to choose. */
export const ROWS = 31;
export const LETTERS = ["A", "B", "C", "D", "E", "F"];
export function seatPrice(seat: string): number | null {
  const m = /^(\d{1,2})([A-F])$/.exec(seat);
  const row = m ? Number(m[1]) : 0;
  if (!m || row < 1 || row > ROWS) return null;
  return row <= 4 ? 28 : row <= 19 ? 11 : 0;
}

/** Paid extras on offer; travel insurance comes ticked, as on many budget airlines. */
export const EXTRAS: Record<string, { name: string; price: number }> = {
  bag20: { name: "20 kg checked bag", price: 32 },
  insurance: { name: "Travel insurance", price: 9 },
  priority: { name: "Priority boarding", price: 8 },
  meal: { name: "Hot meal", price: 7 },
};

/** Seats other passengers already have: the same for a flight every time it is looked at. */
export function takenSeats(itemId: string): string[] {
  const out: string[] = [];
  const h = createHmac("sha256", "practice-seats").update(itemId).digest();
  for (let row = 1; row <= ROWS; row++) {
    LETTERS.forEach((l, i) => {
      if (h[(row * 6 + i) % h.length]! % 5 < 2) out.push(`${row}${l}`);
    });
  }
  return out;
}

function sign(itemId: string, userId: string, secret: string): string {
  const body = Buffer.from(`${itemId}.${userId}`).toString("base64url");
  const sig = createHmac("sha256", `practice:${secret}`).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verify(token: unknown, secret: string): { itemId: string; userId: string } | null {
  if (typeof token !== "string") return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const want = Buffer.from(
    createHmac("sha256", `practice:${secret}`).update(body).digest("base64url"),
  );
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  const [itemId, userId] = Buffer.from(body, "base64url").toString().split(".");
  return itemId && userId ? { itemId, userId } : null;
}

const norm = (s: unknown) => (typeof s === "string" ? s.replace(/[\s-]+/g, "").toUpperCase() : "");

interface Kept {
  seat: string;
  created_at: Date;
  details: Record<string, unknown>;
}

interface Loaded {
  b: FlightBooking;
  profile: Awaited<ReturnType<typeof profileOf>>;
  last: Kept | null;
}

async function load(deps: PracticeDeps, userId: string, itemId: string): Promise<Loaded | null> {
  return withUser(deps.sql, userId, async (tx) => {
    const [item] = await tx<{ details: Booking }[]>`
      SELECT details FROM trip_items WHERE id = ${itemId}`;
    if (!item || item.details.kind !== "flight") return null;
    const [last] = await tx<Kept[]>`
      SELECT seat, created_at, details FROM practice_checkins
      WHERE trip_item_id = ${itemId} ORDER BY created_at DESC LIMIT 1`;
    return { b: item.details, profile: await profileOf(tx, userId), last: last ?? null };
  });
}

function windowOf(b: FlightBooking, now: Date) {
  const depart = localToInstant(b.departAt, b.fromCode);
  if (!depart) return { state: "closed" as const, opensLocal: null };
  const opens = new Date(depart.getTime() - OPENS_H * HOUR);
  const state =
    now < opens
      ? ("not_open" as const)
      : now.getTime() > depart.getTime() - CLOSES_H * HOUR
        ? ("closed" as const)
        : ("open" as const);
  return { state, opensLocal: instantToLocal(opens, b.fromCode) };
}

function flightOf(b: FlightBooking) {
  return {
    number: b.flightNumber,
    fromCode: b.fromCode,
    fromCity: b.fromCity ?? airport(b.fromCode)?.city ?? null,
    toCode: b.toCode,
    toCity: b.toCity ?? airport(b.toCode)?.city ?? null,
    departLocal: b.departAt,
    arriveLocal: b.arriveAt,
  };
}

const passUrl = (token: string) => `/api/practice-air/boarding-pass?t=${token}`;

export function registerPractice(app: FastifyInstance, deps: PracticeDeps) {
  const now = () => deps.now?.() ?? new Date();

  app.post("/practice-air/lookup", async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const reference = typeof body.reference === "string" ? body.reference.slice(0, 20) : "";
    const lastName = typeof body.lastName === "string" ? body.lastName.slice(0, 60) : "";
    const [found] = await deps.sql<{ user_id: string; trip_item_id: string }[]>`
      SELECT * FROM app_practice_booking(${reference}, ${lastName})`;
    const loaded = found ? await load(deps, found.user_id, found.trip_item_id) : null;
    if (!found || !loaded) {
      throw new BadRequest(
        "We couldn't find a booking with that booking number and last name. Check them and try again.",
      );
    }
    const { b, profile, last } = loaded;
    const token = sign(found.trip_item_id, found.user_id, deps.secret);
    const win = windowOf(b, now());
    return {
      token,
      reference: b.confirmation,
      flight: flightOf(b),
      passenger: { firstName: profile.first_name, lastName: profile.last_name },
      checkin: win.state,
      opensLocal: win.opensLocal,
      checkedIn: last ? { seat: last.seat, boardingPass: passUrl(token) } : null,
      taken: takenSeats(found.trip_item_id),
    };
  });

  app.post("/practice-air/check-in", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const who = verify(body.token, deps.secret);
    const loaded = who ? await load(deps, who.userId, who.itemId) : null;
    if (!who || !loaded)
      throw new BadRequest("Your session has expired. Look up your booking again.");
    const { b } = loaded;
    if (windowOf(b, now()).state !== "open") {
      throw new BadRequest("Online check-in isn't open for this flight.");
    }
    const text = (k: string, max = 60) =>
      typeof body[k] === "string" ? (body[k] as string).trim().slice(0, max) : "";
    const missing = [
      ["firstName", "first name"],
      ["lastName", "last name"],
      ["dateOfBirth", "date of birth"],
      ["gender", "gender"],
      ["nationality", "nationality"],
      ["passportNumber", "passport number"],
      ["passportExpiry", "passport expiry date"],
      ["passportCountry", "passport issuing country"],
    ].filter(([k]) => !text(k!));
    if (missing.length) {
      throw new BadRequest(`Please fill in: ${missing.map(([, w]) => w).join(", ")}.`);
    }
    if (body.restrictedItems !== true) {
      throw new BadRequest("Please confirm the restricted items declaration to continue.");
    }
    const expiry = text("passportExpiry", 10);
    const lands = (b.arriveAt ?? b.departAt ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry) || expiry <= lands) {
      throw new BadRequest("Your passport must be valid on the day you travel.");
    }
    // Anything that costs money goes to payment, which this airline never takes.
    const extras = Array.isArray(body.extras)
      ? body.extras.filter((x): x is string => typeof x === "string" && x in EXTRAS)
      : [];
    const chosen = typeof body.seat === "string" && body.seat ? body.seat.toUpperCase() : null;
    const taken = new Set(takenSeats(who.itemId));
    if (chosen && (seatPrice(chosen) === null || taken.has(chosen))) {
      throw new BadRequest("That seat isn't available. Please choose another.");
    }
    const cost =
      extras.reduce((sum, x) => sum + EXTRAS[x]!.price, 0) + (chosen ? seatPrice(chosen)! : 0);
    if (cost > 0) {
      return reply.code(402).send({
        error: `Payment of USD ${cost}.00 is needed for your seat and extras.`,
        cost,
      });
    }
    // No seat chosen: one is given for free, like a real budget airline (often a middle seat).
    const seat =
      chosen ??
      Array.from({ length: ROWS - 19 }, (_, i) => `${ROWS - i}E`).find((s) => !taken.has(s)) ??
      "31B";
    const docs = await travelDocumentsForRun(deps.sql, deps.vaultKey, who.userId, null);
    const details = {
      firstName: text("firstName"),
      lastName: text("lastName"),
      dateOfBirth: text("dateOfBirth", 10),
      gender: text("gender", 10),
      nationality: text("nationality", 40),
      passportMatched:
        !!docs.passportNumber && norm(docs.passportNumber) === norm(body.passportNumber),
      passportExpiry: expiry,
      passportCountry: text("passportCountry", 40),
      restrictedItems: true,
    };
    await withUser(
      deps.sql,
      who.userId,
      (tx) => tx`
        INSERT INTO practice_checkins (user_id, trip_item_id, seat, details)
        VALUES (${who.userId}, ${who.itemId}, ${seat}, ${tx.json(details)})`,
    );
    return { seat, boardingPass: passUrl(body.token as string) };
  });

  app.get<{ Querystring: { t?: string } }>("/practice-air/boarding-pass", async (req, reply) => {
    const who = verify(req.query.t, deps.secret);
    const loaded = who ? await load(deps, who.userId, who.itemId) : null;
    if (!loaded?.last) return reply.code(404).send({ error: "No boarding pass yet." });
    const { b, last } = loaded;
    const d = last.details as { firstName?: string; lastName?: string };
    const name = `${(d.lastName ?? "").toUpperCase()}/${(d.firstName ?? "").toUpperCase()}`;
    const depart = b.departAt ?? "";
    const boards = localToInstant(b.departAt, b.fromCode);
    const boardLocal = boards
      ? instantToLocal(new Date(boards.getTime() - 40 * 60000), b.fromCode)
      : null;
    const pdf = boardingPassPdf([
      { text: "ABILITY PRACTICE AIR", size: 20, y: 790 },
      { text: "BOARDING PASS  (practice only, not valid for travel)", size: 10, y: 770 },
      { text: `Passenger: ${name}`, size: 14, y: 730 },
      { text: `Flight: ${b.flightNumber ?? ""}`, size: 14, y: 705 },
      { text: `Date: ${depart.slice(0, 10)}`, size: 14, y: 680 },
      { text: `From: ${b.fromCode ?? ""}  To: ${b.toCode ?? ""}`, size: 14, y: 655 },
      { text: `Departs: ${depart.slice(11, 16)}`, size: 14, y: 630 },
      {
        text: `Boarding: ${boardLocal?.slice(11, 16) ?? ""}  Gate closes 20 min before`,
        size: 14,
        y: 605,
      },
      { text: `Seat: ${last.seat}   Group: 3`, size: 14, y: 580 },
      { text: `Booking: ${b.confirmation ?? ""}`, size: 14, y: 555 },
    ]);
    reply
      .header("Content-Type", "application/pdf")
      .header("Content-Disposition", 'attachment; filename="boarding-pass.pdf"')
      .header("Cache-Control", "no-store");
    return reply.send(pdf);
  });
}

/** A one-page PDF of plain text lines (Helvetica), enough for a boarding pass. */
export function boardingPassPdf(lines: { text: string; size: number; y: number }[]): Buffer {
  const esc = (s: string) => s.replace(/[^\x20-\x7e]/g, "?").replace(/([\\()])/g, "\\$1");
  const stream = lines
    .map((l) => `BT /F1 ${l.size} Tf 56 ${l.y} Td (${esc(l.text)}) Tj ET`)
    .join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
