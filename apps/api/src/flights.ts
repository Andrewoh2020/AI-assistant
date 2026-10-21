import { BROWSER_INSTRUCTIONS } from "@ai-assistant/agent";
import {
  withUser,
  type BrowserSessionRow,
  type FileRow,
  type Sql,
  type TransactionSql,
} from "@ai-assistant/db";
import type { Booking, FlightView, PrepKey } from "@ai-assistant/api-client";
import { airport, instantToLocal, localToInstant } from "./airports.js";
import {
  advanceFlightBrowse,
  isActive,
  startFlightBrowse,
  viewOf,
  type BrowserDeps,
} from "./browser.js";
import type { BrowserUse, SecretBinding } from "./browseruse.js";
import { fileView } from "./files.js";
import type { FlightStatusSource, LiveFlight, RouteOption, RouteSource } from "./flightdata.js";
import { when } from "./gmail.js";
import { isoDate, needsFor, profileOf, type FlightFacts, type TravelProfileRow } from "./travel.js";
import { travelDocumentsForRun, type VaultKey } from "./vault.js";

/**
 * Flights: everything the assistant does for one flight, from the moment it's booked to landing.
 * Plan: /mnt/project-files/design/checkin-plan.html (Option A, chosen by Andrew 2026-10-21).
 *
 * - As soon as a flight is known, a trip card goes into the Main chat and asks once for whatever
 *   is missing (only what this flight needs and the vault doesn't have).
 * - When check-in opens it checks in by itself in a browser, with nobody watching, and sends the
 *   boarding pass. Problems end in one clear message, never "Failed".
 * - Arrival cards (Singapore, Thailand) are filed on the official site after one tap of OK.
 * - On the day, the card shows live status, and a "time to leave" message picks car or train.
 *
 * The scheduler (tick) runs every minute on a computer, and whenever the person opens the app.
 */

export interface FlightDeps {
  sql: Sql;
  browser: BrowserUse;
  secret: string;
  vaultKey: VaultKey;
  status: FlightStatusSource;
  routes: RouteSource;
  now?: () => Date;
  /** Minimum gap between checks on a browser (tests use 0). */
  checkGapMs?: number;
}

const MINUTE = 60000;
const HOUR = 60 * MINUTE;
/** When online check-in opens on most airlines. If it isn't open yet, the site says when it is. */
const CHECKIN_OPENS_H = 24;
const RETRY_MIN = 15;
const MAX_CHECKIN_TRIES = 6;
/** Stop trying this long before departure, and send the backup link instead. */
const BACKUP_BEFORE_H = 3;
const MAX_ARRIVAL_TRIES = 3;
/** Spending cap for one check-in or arrival-card run. */
const RUN_COST_USD = 0.6;
/** Lease held while one flight is being looked at, so two ticks don't act twice. */
const LEASE_MS = 2 * MINUTE;

/** Airlines' own websites (domain only), where check-in happens and hidden values may be typed. */
export const AIRLINES: Record<string, { name: string; domain: string }> = {
  AA: { name: "American", domain: "aa.com" },
  AC: { name: "Air Canada", domain: "aircanada.com" },
  AF: { name: "Air France", domain: "airfrance.com" },
  AS: { name: "Alaska", domain: "alaskaair.com" },
  B6: { name: "JetBlue", domain: "jetblue.com" },
  BA: { name: "British Airways", domain: "britishairways.com" },
  CX: { name: "Cathay Pacific", domain: "cathaypacific.com" },
  DL: { name: "Delta", domain: "delta.com" },
  EK: { name: "Emirates", domain: "emirates.com" },
  HA: { name: "Hawaiian", domain: "hawaiianairlines.com" },
  JL: { name: "JAL", domain: "jal.co.jp" },
  KE: { name: "Korean Air", domain: "koreanair.com" },
  KL: { name: "KLM", domain: "klm.com" },
  LH: { name: "Lufthansa", domain: "lufthansa.com" },
  NH: { name: "ANA", domain: "ana.co.jp" },
  QF: { name: "Qantas", domain: "qantas.com" },
  QR: { name: "Qatar Airways", domain: "qatarairways.com" },
  SQ: { name: "Singapore Airlines", domain: "singaporeair.com" },
  TG: { name: "Thai Airways", domain: "thaiairways.com" },
  UA: { name: "United", domain: "united.com" },
  VS: { name: "Virgin Atlantic", domain: "virginatlantic.com" },
  WN: { name: "Southwest", domain: "southwest.com" },
};

/** Arrival cards we file, on the government's own site only (both are free). */
export const ARRIVAL_CARDS: Record<
  string,
  { country: string; form: string; url: string; domain: string }
> = {
  SG: {
    country: "Singapore",
    form: "Singapore arrival card",
    url: "https://eservices.ica.gov.sg/sgarrivalcard/",
    domain: "ica.gov.sg",
  },
  TH: {
    country: "Thailand",
    form: "Thailand Digital Arrival Card",
    url: "https://tdac.immigration.go.th/",
    domain: "immigration.go.th",
  },
};
/** Arrival cards can be filed within 3 days before arrival, the day of arrival included. */
const ARRIVAL_WINDOW_DAYS = 3;
/** Countries that need a passport valid 6 months after arrival (checked on the official site). */
const SIX_MONTH_RULE: Record<string, string> = { SG: "Singapore" };

type FlightBooking = Extract<Booking, { kind: "flight" }>;

export interface FlightPlanRow {
  trip_item_id: string;
  user_id: string;
  created_at: Date;
  updated_at: Date;
  depart_at: Date | null;
  arrive_at: Date | null;
  card_message_id: string | null;
  no_banned_items: boolean;
  auto_checkin: boolean;
  checkin_status:
    "scheduled" | "waiting_for_you" | "running" | "done" | "airport" | "backup" | "off" | "past";
  checkin_due_at: Date | null;
  checkin_tries: number;
  checkin_question: string | null;
  checkin_note: string | null;
  checkin_result: CheckinResult | null;
  checkin_browser_id: string | null;
  boarding_pass_file_id: string | null;
  arrival_country: string | null;
  arrival_status:
    "not_needed" | "scheduled" | "ready" | "running" | "done" | "waiting_for_you" | "backup";
  arrival_due_at: Date | null;
  arrival_tries: number;
  arrival_question: string | null;
  arrival_note: string | null;
  arrival_confirmed: boolean;
  arrival_browser_id: string | null;
  arrival_file_id: string | null;
  live: LiveFlight | null;
  live_checked_at: Date | null;
  leave_by: Date | null;
  leave_plan: LeavePlan | null;
  sent: string[];
  next_due_at: Date | null;
  lease_until: Date | null;
  poked: boolean;
}

interface CheckinResult {
  seat?: string | null;
  group?: string | null;
  terminal?: string | null;
  gate?: string | null;
  skipped?: string[];
  mismatch?: string | null;
  /** The airline that actually flies it (a codeshare), when the site sent us there. */
  operator?: string | null;
  reference?: string | null;
}

interface LeavePlan {
  mode: "car" | "train" | null;
  minutes: number | null;
  other: RouteOption | null;
  from: string;
  /** When to be at the airport. */
  beAt: string;
  early: number;
  checkedAt: string;
}

interface ItemRow {
  id: string;
  trip_id: string;
  details: Booking;
  updated_at: Date;
}

// Facts about a flight ------------------------------------------------------------------------

export const airlineOf = (b: FlightBooking): string | null =>
  b.flightNumber?.split(" ")[0]?.toUpperCase() ?? null;

function airlineName(b: FlightBooking, code: string | null) {
  return (code && AIRLINES[code]?.name) || b.airline || code || "the airline";
}

const flightName = (b: FlightBooking) => b.flightNumber ?? b.airline ?? "your flight";
const placeName = (code: string | null, city: string | null) => city ?? code ?? "?";

export function factsFor(b: FlightBooking): FlightFacts {
  const from = airport(b.fromCode);
  const to = airport(b.toCode);
  const code = airlineOf(b);
  return {
    international: !!(from && to && from.country !== to.country),
    airline: code,
    airlineName: code ? (AIRLINES[code]?.name ?? b.airline) : b.airline,
    fromUs: from?.country === "US",
    sixMonthCountry: to ? (SIX_MONTH_RULE[to.country] ?? null) : null,
    arriveOn: b.arriveAt?.slice(0, 10) ?? b.departAt?.slice(0, 10) ?? null,
    departOn: b.departAt?.slice(0, 10) ?? null,
  };
}

/** "8:05 am" from "2026-10-24T08:05". */
export function clock(local: string | null): string {
  if (!local || local.length < 16) return "";
  const h = Number(local.slice(11, 13));
  const m = local.slice(14, 16);
  return `${h % 12 || 12}:${m} ${h < 12 ? "am" : "pm"}`;
}

/** "Thu 24 Oct, 8:05 am" at the airport. */
const atAirport = (at: Date, code: string | null) => {
  const local = instantToLocal(at, code);
  return local ? `${when(local).split(",")[0]}, ${clock(local)}` : at.toISOString();
};

// Planning -------------------------------------------------------------------------------------

/**
 * Makes sure every upcoming flight has a plan and a trip card, and keeps the plan's times in step
 * with its booking (a schedule change moves check-in with it). Cheap; safe to call often.
 */
export async function planFlights(
  deps: Pick<FlightDeps, "sql" | "now">,
  userId: string,
): Promise<void> {
  const now = deps.now?.() ?? new Date();
  await withUser(deps.sql, userId, async (tx) => {
    const items = await tx<(ItemRow & { plan: FlightPlanRow | null })[]>`
      SELECT i.id, i.trip_id, i.details, i.updated_at, to_jsonb(p.*) AS plan
      FROM trip_items i LEFT JOIN flight_plans p ON p.trip_item_id = i.id
      WHERE i.kind = 'booking' AND i.details->>'kind' = 'flight'
        AND i.item_date >= current_date - 1`;
    for (const item of items) {
      const b = item.details as FlightBooking;
      const departAt = localToInstant(b.departAt, b.fromCode);
      const arriveAt = localToInstant(b.arriveAt, b.toCode);
      if (!departAt || departAt.getTime() < now.getTime() - HOUR) continue;
      const plan = item.plan;
      const arrival = arrivalFor(b);
      if (!plan) {
        const arrivalDue = arrival ? arrivalOpens(b) : null;
        await tx`
          INSERT INTO flight_plans (trip_item_id, user_id, depart_at, arrive_at, checkin_due_at,
                                    arrival_country, arrival_status, arrival_due_at, next_due_at)
          VALUES (${item.id}, ${userId}, ${departAt}, ${arriveAt},
                  ${new Date(departAt.getTime() - CHECKIN_OPENS_H * HOUR)},
                  ${arrival}, ${arrival ? "scheduled" : "not_needed"}, ${arrivalDue}, ${now})
          ON CONFLICT DO NOTHING`;
        await postCard(tx, userId, item.id, b);
        continue;
      }
      const old = plan.depart_at ? new Date(plan.depart_at) : null;
      if (old && Math.abs(old.getTime() - departAt.getTime()) >= MINUTE) {
        await tx`
          UPDATE flight_plans SET depart_at = ${departAt}, arrive_at = ${arriveAt},
            checkin_due_at = CASE WHEN checkin_status IN ('scheduled', 'waiting_for_you')
                                  THEN ${new Date(departAt.getTime() - CHECKIN_OPENS_H * HOUR)}
                                  ELSE checkin_due_at END,
            arrival_due_at = CASE WHEN arrival_status = 'scheduled' THEN ${arrival ? arrivalOpens(b) : null}
                                  ELSE arrival_due_at END,
            leave_by = NULL, leave_plan = NULL, next_due_at = ${now}, updated_at = now()
          WHERE trip_item_id = ${item.id}`;
        await say(
          tx,
          userId,
          `${airlineName(b, airlineOf(b))} moved ${flightName(b)} to ${atAirport(departAt, b.fromCode)}. ${
            ["scheduled", "waiting_for_you"].includes(plan.checkin_status)
              ? "I'll check you in at the new time."
              : "Your boarding pass may need refreshing; I'll keep an eye on it."
          }`,
        );
      }
    }
  });
}

function arrivalFor(b: FlightBooking): string | null {
  const to = airport(b.toCode);
  const from = airport(b.fromCode);
  if (!to || !ARRIVAL_CARDS[to.country] || from?.country === to.country) return null;
  return to.country;
}

/** Midnight at the arrival airport, 2 days before the arrival day (3 days, arrival included). */
function arrivalOpens(b: FlightBooking): Date | null {
  const day = (b.arriveAt ?? b.departAt)?.slice(0, 10);
  if (!day) return null;
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const open = new Date(Date.UTC(y, m - 1, d - (ARRIVAL_WINDOW_DAYS - 1)))
    .toISOString()
    .slice(0, 10);
  return localToInstant(`${open}T00:00`, b.toCode);
}

async function mainChat(tx: TransactionSql): Promise<string | null> {
  const [main] = await tx<{ id: string }[]>`SELECT id FROM chats WHERE kind = 'main'`;
  return main?.id ?? null;
}

/** A message in the Main chat (proactive: nobody asked). */
async function say(
  tx: TransactionSql,
  userId: string,
  text: string,
  card?: { tripItemId: string },
): Promise<string | null> {
  const chat = await mainChat(tx);
  if (!chat) return null;
  const parts: unknown[] = [{ type: "text", text, citations: [] }];
  if (card) parts.push({ type: "card", card: { kind: "flight", tripItemId: card.tripItemId } });
  const [m] = await tx<{ id: string }[]>`
    INSERT INTO messages (user_id, chat_id, role, parts, origin)
    VALUES (${userId}, ${chat}, 'assistant', ${tx.json(parts as never)}, 'proactive')
    RETURNING id`;
  await tx`UPDATE chats SET updated_at = now() WHERE id = ${chat}`;
  return m!.id;
}

async function postCard(tx: TransactionSql, userId: string, itemId: string, b: FlightBooking) {
  const id = await say(
    tx,
    userId,
    `${flightName(b)} to ${placeName(b.toCode, b.toCity)}${b.departAt ? ` on ${when(b.departAt).split(",")[0]}` : ""}: I'll check you in by myself when check-in opens.`,
    { tripItemId: itemId },
  );
  if (id) await tx`UPDATE flight_plans SET card_message_id = ${id} WHERE trip_item_id = ${itemId}`;
}

// The scheduler --------------------------------------------------------------------------------

/** Looks at every flight that is due, for everyone. Never throws. */
export async function tickAll(deps: FlightDeps, limit = 25): Promise<number> {
  const now = deps.now?.() ?? new Date();
  let due: { user_id: string; trip_item_id: string }[] = [];
  try {
    due = await deps.sql<{ user_id: string; trip_item_id: string }[]>`
      SELECT * FROM app_due_flights(${now}, ${limit})`;
  } catch (err) {
    console.error("flights: couldn't list due flights", (err as Error).message);
    return 0;
  }
  for (const d of due) await stepFlight(deps, d.user_id, d.trip_item_id);
  return due.length;
}

/** The person's own flights that are due (when they open the app). Never throws. */
export async function tickUser(deps: FlightDeps, userId: string): Promise<void> {
  const now = deps.now?.() ?? new Date();
  try {
    await planFlights(deps, userId);
    const due = await withUser(
      deps.sql,
      userId,
      (tx) => tx<{ trip_item_id: string }[]>`
        SELECT trip_item_id FROM flight_plans WHERE next_due_at <= ${now} ORDER BY next_due_at LIMIT 10`,
    );
    for (const d of due) await stepFlight(deps, userId, d.trip_item_id);
  } catch (err) {
    console.error("flights: check failed", (err as Error).message);
  }
}

/** Looks at one flight and does whatever is due. Never throws. */
export async function stepFlight(deps: FlightDeps, userId: string, itemId: string): Promise<void> {
  const now = deps.now?.() ?? new Date();
  const [plan] = await withUser(
    deps.sql,
    userId,
    (tx) => tx<FlightPlanRow[]>`
      UPDATE flight_plans SET lease_until = ${new Date(now.getTime() + LEASE_MS)}, poked = false
      WHERE trip_item_id = ${itemId} AND (lease_until IS NULL OR lease_until < ${now})
      RETURNING *`,
  );
  if (!plan) return;
  let next: Date | null = null;
  try {
    next = await step(deps, userId, plan, now);
  } catch (err) {
    console.error(`flight ${itemId}: step failed`, (err as Error).message);
    next = new Date(now.getTime() + 5 * MINUTE);
  } finally {
    await withUser(
      deps.sql,
      userId,
      (tx) => tx`UPDATE flight_plans
                 SET lease_until = NULL, updated_at = now(),
                     next_due_at = CASE WHEN poked THEN ${now} ELSE ${next} END, poked = false
                 WHERE trip_item_id = ${itemId}`,
    );
  }
}

interface Ctx {
  deps: FlightDeps;
  userId: string;
  plan: FlightPlanRow;
  b: FlightBooking;
  facts: FlightFacts;
  profile: TravelProfileRow;
  hotel: {
    name: string | null;
    address: string | null;
    checkOut: string | null;
    city: string | null;
  } | null;
  trip: Booking[];
  now: Date;
}

async function step(deps: FlightDeps, userId: string, plan: FlightPlanRow, now: Date) {
  const loaded = await withUser(deps.sql, userId, async (tx) => {
    const [item] = await tx<ItemRow[]>`SELECT * FROM trip_items WHERE id = ${plan.trip_item_id}`;
    if (!item) return null;
    const trip = (
      await tx<{ details: Booking }[]>`
        SELECT details FROM trip_items WHERE trip_id = ${item.trip_id} AND kind = 'booking'
        ORDER BY item_date, created_at`
    ).map((r) => r.details);
    return { item, trip, profile: await profileOf(tx, userId) };
  });
  if (!loaded) return null;
  const b = loaded.item.details as FlightBooking;
  const c: Ctx = {
    deps,
    userId,
    plan,
    b,
    facts: factsFor(b),
    profile: loaded.profile,
    hotel: hotelFor(b, loaded.trip),
    trip: loaded.trip,
    now,
  };
  const depart = plan.depart_at ? new Date(plan.depart_at) : null;
  const arrive = plan.arrive_at ? new Date(plan.arrive_at) : null;
  const over = (arrive ?? (depart ? new Date(depart.getTime() + 18 * HOUR) : null))?.getTime();
  if (!depart || (over && now.getTime() > over + 6 * HOUR)) {
    await patch(c, {
      checkin_status: plan.checkin_status === "done" ? "done" : "past",
      arrival_status: plan.arrival_status === "done" ? "done" : "not_needed",
    });
    return null;
  }
  const times = [
    await stepCheckin(c, depart),
    await stepArrival(c),
    await stepStatus(c, depart, arrive),
    await stepLeave(c, depart),
  ].filter((t): t is Date => !!t);
  return times.length ? new Date(Math.min(...times.map((t) => t.getTime()))) : null;
}

async function patch(c: Ctx, fields: Record<string, unknown>) {
  const row = await withUser(c.deps.sql, c.userId, async (tx) => {
    const [r] = await tx<FlightPlanRow[]>`
      UPDATE flight_plans SET ${tx(fields)}, updated_at = now()
      WHERE trip_item_id = ${c.plan.trip_item_id} RETURNING *`;
    return r;
  });
  if (row) c.plan = row;
}

async function tell(c: Ctx, key: string | null, text: string) {
  if (key && c.plan.sent.includes(key)) return;
  await withUser(c.deps.sql, c.userId, async (tx) => {
    await say(tx, c.userId, text);
    if (key) {
      await tx`UPDATE flight_plans SET sent = array_append(sent, ${key})
               WHERE trip_item_id = ${c.plan.trip_item_id}`;
    }
  });
  if (key) c.plan = { ...c.plan, sent: [...c.plan.sent, key] };
}

function hotelFor(b: FlightBooking, trip: Booking[]): Ctx["hotel"] {
  const day = (b.arriveAt ?? b.departAt)?.slice(0, 10) ?? "";
  const hotels = trip.filter((t): t is Extract<Booking, { kind: "hotel" }> => t.kind === "hotel");
  // The stay that starts when this flight lands (or the first one, for an arrival card).
  const h = hotels.find((x) => x.checkIn && x.checkIn >= day.slice(0, 10)) ?? hotels[0];
  return h ? { name: h.name, address: h.address, checkOut: h.checkOut, city: h.city } : null;
}

/** What is still missing before check-in can run, in plain words ("your passport number"). */
function missingWords(c: Ctx): string[] {
  const needs = needsFor(c.profile, c.facts);
  const words: Record<PrepKey, string> = {
    name: "your name as on your ID",
    dateOfBirth: "your date of birth",
    gender: "your gender as on your ID",
    nationality: "your nationality",
    passportNumber: "your passport number",
    passportExpiry: "your passport's expiry date",
    knownTraveler: "",
    frequentFlyer: "",
    seatStyle: "",
    homeAddress: "",
  };
  const out = needs.required.map((k) => words[k]).filter(Boolean);
  if (c.plan.checkin_question) out.push(`an answer to "${c.plan.checkin_question}"`);
  if (!c.plan.no_banned_items) out.push('a tick on "no banned items"');
  return out;
}

const list = (xs: string[]) =>
  xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;

// Check-in ---------------------------------------------------------------------------------------

async function stepCheckin(c: Ctx, depart: Date): Promise<Date | null> {
  const { plan, now, b } = c;
  if (
    !plan.auto_checkin ||
    ["done", "airport", "backup", "off", "past"].includes(plan.checkin_status)
  ) {
    return null;
  }
  const due = plan.checkin_due_at
    ? new Date(plan.checkin_due_at)
    : new Date(depart.getTime() - CHECKIN_OPENS_H * HOUR);
  const lastCall = new Date(depart.getTime() - BACKUP_BEFORE_H * HOUR);
  const missing = missingWords(c);
  const air = airlineName(b, operatorOf(c));

  if (plan.checkin_status === "running") return followCheckin(c, depart);

  if (plan.checkin_status === "scheduled" && now < due) {
    // One reminder the day before check-in opens, only if something is missing.
    const remindAt = new Date(due.getTime() - 24 * HOUR);
    if (missing.length && now >= remindAt) {
      await tell(
        c,
        "prep_reminder",
        `I still need ${list(missing)} to check you in for ${flightName(b)} when check-in opens (${atAirport(due, b.fromCode)}). Add it on the trip card; it takes a few seconds.`,
      );
    }
    return missing.length && now < remindAt ? remindAt : due;
  }

  if (missing.length) {
    if (plan.checkin_status !== "waiting_for_you")
      await patch(c, { checkin_status: "waiting_for_you" });
    if (now < lastCall) {
      await tell(
        c,
        "checkin_missing",
        `Check-in for ${flightName(b)} is open. I'll check you in as soon as you add ${list(missing)} on the trip card.`,
      );
      return lastCall;
    }
    await tell(
      c,
      "last_nudge",
      `${flightName(b)} leaves at ${atAirport(depart, b.fromCode)} and I still can't check you in without ${list(missing)}. Add it on the trip card, or check in yourself on ${checkinSite(c)}${b.confirmation ? ` with booking ${b.confirmation}` : ""}.`,
    );
    return null;
  }
  if (now >= new Date(depart.getTime() - HOUR)) {
    await backup(c, "It's too close to departure to check in online now.");
    return null;
  }
  return startCheckin(c);
}

function operatorOf(c: Ctx): string | null {
  const op = c.plan.checkin_result?.operator;
  if (op) {
    const code = Object.entries(AIRLINES).find(
      ([k, v]) => k === op.toUpperCase() || v.name.toLowerCase() === op.toLowerCase(),
    )?.[0];
    if (code) return code;
  }
  return airlineOf(c.b);
}

function checkinSite(c: Ctx): string {
  const code = operatorOf(c);
  return code && AIRLINES[code] ? AIRLINES[code].domain : `${airlineName(c.b, code)}'s website`;
}

async function startCheckin(c: Ctx): Promise<Date> {
  const code = operatorOf(c);
  const site = code ? AIRLINES[code]?.domain : undefined;
  const docs = await travelDocumentsForRun(c.deps.sql, c.deps.vaultKey, c.userId, null);
  const secrets = site ? documentSecrets(docs, code, [site]) : [];
  const chatId = await withUser(c.deps.sql, c.userId, mainChat);
  const session = await startFlightBrowse(browserDeps(c.deps), c.userId, {
    purpose: "checkin",
    tripItemId: c.plan.trip_item_id,
    chatId,
    title: `Check in ${flightName(c.b)}`,
    task: checkinTask(
      c,
      secrets.map((s) => s.alias),
      site ?? null,
    ),
    startUrl: site ? `https://www.${site}/` : null,
    secrets,
    maxCostUsd: RUN_COST_USD,
  });
  await patch(c, {
    checkin_status: "running",
    checkin_browser_id: session.id,
    checkin_tries: c.plan.checkin_tries + 1,
  });
  return new Date(c.now.getTime() + 30000);
}

export function documentSecrets(
  docs: Awaited<ReturnType<typeof travelDocumentsForRun>>,
  airline: string | null,
  domains: string[],
): SecretBinding[] {
  const out: SecretBinding[] = [];
  if (docs.passportNumber)
    out.push({ alias: "passport_number", value: docs.passportNumber, allowedDomains: domains });
  if (docs.knownTravelerNumber) {
    out.push({
      alias: "known_traveler_number",
      value: docs.knownTravelerNumber,
      allowedDomains: domains,
    });
  }
  const ff = airline ? docs.frequentFlyer?.[airline] : undefined;
  if (ff) out.push({ alias: "frequent_flyer_number", value: ff, allowedDomains: domains });
  return out;
}

const SECRET_RULE =
  "You can't see the hidden values: ask for one by its name to have it typed into the field that has focus. Focus the field with element.focus() first (find it by its label, not by screen position). Never read back what was typed, and never write a hidden value in your reply.";

function seatWishes(p: TravelProfileRow): string {
  const bits: string[] = [];
  if (p.seat_side && p.seat_side !== "any") bits.push(`a ${p.seat_side} seat`);
  if (p.seat_zone && p.seat_zone !== "any") bits.push(`near the ${p.seat_zone} of the plane`);
  if (p.seat_empty_nearby) bits.push("with empty seats next to them if possible");
  if (p.seat_avoid_washroom) bits.push("away from the washrooms (lavatories)");
  return bits.length ? `They prefer ${bits.join(", ")}.` : "They have no seat preference.";
}

function personLines(p: TravelProfileRow, international: boolean): string[] {
  const lines = [
    `First name: ${p.first_name ?? "?"}${p.middle_name ? ` (middle name: ${p.middle_name})` : ""}`,
    `Last name: ${p.last_name ?? "?"}`,
    `Date of birth: ${isoDate(p.date_of_birth) ?? "?"} (YYYY-MM-DD)`,
    `Gender: ${p.gender === "x" ? "X / unspecified" : (p.gender ?? "?")}`,
  ];
  if (international || p.nationality) {
    lines.push(`Nationality: ${p.nationality ?? "?"} (ISO country code)`);
    if (p.passport_expiry) {
      lines.push(
        `Passport: issued by ${p.passport_country ?? p.nationality ?? "?"}, expires ${isoDate(p.passport_expiry)}`,
      );
    }
  }
  const answers = Object.entries(p.answers);
  if (answers.length) {
    lines.push("Answers they gave to questions sites asked before:");
    for (const [q, a] of answers) lines.push(`- ${q}: ${a}`);
  }
  return lines;
}

export function checkinTask(c: Ctx, aliases: string[], site: string | null): string {
  const { b, profile } = c;
  const code = operatorOf(c);
  return [
    BROWSER_INSTRUCTIONS,
    "",
    "Task: online check-in",
    `Check this person in for their flight on ${site ? `the airline's own website (${site})` : `${airlineName(b, code)}'s own official website`}, then get their boarding pass. Nobody is watching: work through it yourself and stop only for the reasons listed below.`,
    "",
    "The flight",
    `- ${flightName(b)}${b.airline ? ` (${b.airline})` : ""}, ${placeName(b.fromCode, b.fromCity)} (${b.fromCode ?? "?"}) to ${placeName(b.toCode, b.toCity)} (${b.toCode ?? "?"})`,
    `- Departs ${b.departAt?.replace("T", " ") ?? "?"} local time`,
    `- Booking reference: ${b.confirmation ?? "not known (try the frequent flyer number or the e-ticket search, else stop with NEEDS_INFO)"}`,
    "",
    "The passenger",
    ...personLines(profile, c.facts.international).map((l) =>
      l.startsWith("-") ? `  ${l}` : `- ${l}`,
    ),
    aliases.length
      ? `- Hidden values you may use, typed only into ${site}: ${aliases.join(", ")}. ${SECRET_RULE}`
      : "- No passport, Known Traveler or frequent flyer number is saved.",
    "",
    "Seat",
    `- ${seatWishes(profile)} Only ever choose a seat that costs nothing. Change their current seat only if a free one is clearly better for these wishes. If their fare doesn't allow choosing a seat for free, keep the one the airline gives.`,
    "",
    "Safety statement",
    "- The person has told us themselves that they are not carrying any banned or dangerous items. You may confirm the airline's standard dangerous goods / restricted items statement for them. Don't confirm any other statement on their behalf: if the site asks for one, stop with NEEDS_INFO.",
    "",
    "Steps",
    "1. Find the check-in page and look up the booking with the booking reference and last name (and first name if asked). Don't sign in unless the site requires it.",
    "2. Decline every paid extra: upgrades, extra bags, priority boarding, insurance, paid seats, hotels, cars. Never enter payment details or buy anything.",
    "3. Fill in any details the site asks for from the passenger details above. If the person is already checked in, go straight to the boarding pass.",
    '4. Complete check-in, then get the boarding pass: download it (PDF, or the airline\'s mobile pass file) into outputs/. If there is no download, save the boarding pass page as a PDF into outputs/ named "boarding-pass.pdf".',
    "",
    "Your final reply must start with exactly one of these:",
    '- CHECKED_IN {"flight":"UA123","date":"YYYY-MM-DD","lastName":"...","seat":"14A","group":"3","terminal":null,"gate":null,"skipped":["the paid extras you declined, with prices"],"boardingPass":true} (fill in what the boarding pass shows; null for anything not shown)',
    "- NOT_OPEN: when check-in opens, as the site says it",
    "- AIRPORT_ONLY: the site's reason, in one sentence, when it says the passenger must check in at the airport (for example to check a passport or visa in person)",
    "- OPERATED_BY: the name of the airline that operates the flight, when the site says to check in with them instead",
    "- NEEDS_INFO: the exact question, in one sentence, when the site asks for something not given above (for example an emergency contact or an address)",
    "- NOT_FOUND: what the site said, when it can't find the booking",
    "- or NEEDS_SIGN_IN:, NEEDS_CODE:, BLOCKED: as in the rules above.",
  ].join("\n");
}

/** Hidden values every run in a flight's session gets (passport and similar), on its own site. */
export function flightSecrets(deps: Pick<FlightDeps, "sql" | "vaultKey">) {
  return async (userId: string, s: BrowserSessionRow): Promise<SecretBinding[]> => {
    if (!s.trip_item_id) return [];
    const start = s.task ? /^Start at: (\S+)$/m.exec(s.task)?.[1] : null;
    let host: string | null = null;
    try {
      host = start ? new URL(start).hostname.replace(/^www\./, "") : null;
    } catch {
      host = null;
    }
    if (!host) return [];
    const [item] = await withUser(
      deps.sql,
      userId,
      (tx) =>
        tx<{ details: Booking }[]>`SELECT details FROM trip_items WHERE id = ${s.trip_item_id}`,
    );
    const b = item?.details;
    const docs = await travelDocumentsForRun(deps.sql, deps.vaultKey, userId, s.id);
    const airline = b?.kind === "flight" ? airlineOf(b) : null;
    return documentSecrets(docs, s.purpose === "checkin" ? airline : null, [host]);
  };
}

export function browserDeps(deps: FlightDeps): BrowserDeps {
  return {
    sql: deps.sql,
    browser: deps.browser,
    secret: deps.secret,
    vaultKey: deps.vaultKey,
    now: deps.now,
    checkGapMs: deps.checkGapMs,
    extraSecrets: flightSecrets(deps),
  };
}

async function loadSession(c: Ctx, id: string | null): Promise<BrowserSessionRow | null> {
  if (!id) return null;
  const [s] = await withUser(
    c.deps.sql,
    c.userId,
    (tx) => tx<BrowserSessionRow[]>`SELECT * FROM browser_sessions WHERE id = ${id}`,
  );
  return s ?? null;
}

/** The final report of a finished session, unwrapped, or null if it didn't finish well. */
function reportOf(s: BrowserSessionRow): string | null {
  if (s.status !== "done" || !s.result) return null;
  try {
    const report = String((JSON.parse(s.result) as { report?: string }).report ?? "");
    return report
      .replace(/^BEGIN EXTERNAL CONTENT[^\n]*\n/, "")
      .replace(/\nEND EXTERNAL CONTENT$/, "")
      .trim();
  } catch {
    return null;
  }
}

/** "CHECKED_IN {...}" and friends: the marker and what follows it. */
export function readMarker(report: string): { marker: string; rest: string } | null {
  // At the start of a line: the agent's own answer, not words quoted from a page.
  const m =
    /(?:^|\n)\s*(CHECKED_IN|SUBMITTED|NOT_OPEN|AIRPORT_ONLY|OPERATED_BY|NEEDS_INFO|NOT_FOUND)\s*:?\s*([\s\S]*)/.exec(
      report,
    );
  return m ? { marker: m[1]!, rest: m[2]!.trim() } : null;
}

function readJson(rest: string): Record<string, unknown> {
  const m = /\{[\s\S]*?\}/.exec(rest);
  if (!m) return {};
  try {
    return JSON.parse(m[0]) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const oneLine = (s: string, max = 200) => {
  const t = s.split("\n")[0]!.replace(/[`*_]/g, "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 3) + "..." : t;
};

async function followCheckin(c: Ctx, depart: Date): Promise<Date | null> {
  const { b } = c;
  let s = await loadSession(c, c.plan.checkin_browser_id);
  if (!s) return retryCheckin(c, depart, "the browser session went missing");
  if (isActive(s)) {
    await advanceFlightBrowse(browserDeps(c.deps), c.userId, s);
    s = (await loadSession(c, s.id)) ?? s;
  }
  if (isActive(s)) {
    if (s.status === "needs_user" && s.ask_kind) {
      await tell(
        c,
        `ask:${s.id}`,
        s.ask_kind === "code"
          ? `${airlineName(b, operatorOf(c))} sent you a code to finish check-in for ${flightName(b)}. Type it in the secure box on the trip card.`
          : `${airlineName(b, operatorOf(c))} wants you to sign in to check in for ${flightName(b)}. Use the secure box on the trip card; I'll finish the rest. Your login is typed only into ${s.ask_site}.`,
      );
    }
    return new Date(c.now.getTime() + 20000);
  }
  const report = reportOf(s);
  if (!report) {
    return retryCheckin(
      c,
      depart,
      s.blocked
        ? `${checkinSite(c)} kept blocking my browser`
        : "the airline's site didn't work for my browser",
    );
  }
  const found = readMarker(report);
  switch (found?.marker) {
    case "CHECKED_IN":
      return checkedIn(c, s, readJson(found.rest));
    case "NOT_OPEN": {
      const at = new Date(c.now.getTime() + HOUR);
      if (at.getTime() > depart.getTime() - BACKUP_BEFORE_H * HOUR) {
        return retryCheckin(c, depart, `check-in on ${checkinSite(c)} still wasn't open`);
      }
      await patch(c, { checkin_status: "scheduled", checkin_due_at: at });
      return at;
    }
    case "AIRPORT_ONLY": {
      const why = oneLine(found.rest) || "The airline needs to see you at the desk.";
      await patch(c, { checkin_status: "airport", checkin_note: why });
      const desk = new Date(depart.getTime() - (c.facts.international ? 3 : 2) * HOUR);
      await tell(
        c,
        "airport",
        `Please check in at the ${airlineName(b, operatorOf(c))} desk for ${flightName(b)}: online check-in isn't possible. The site said: "${why}" Aim to be at the airport by ${atAirport(desk, b.fromCode)}.`,
      );
      return null;
    }
    case "OPERATED_BY": {
      const op = oneLine(found.rest, 60);
      if (c.plan.checkin_result?.operator) {
        return retryCheckin(c, depart, `the airlines sent my browser back and forth (${op})`);
      }
      await patch(c, {
        checkin_status: "scheduled",
        checkin_due_at: c.now,
        checkin_result: c.deps.sql.json({
          ...(c.plan.checkin_result ?? {}),
          operator: op,
        } as never),
      });
      return c.now;
    }
    case "NEEDS_INFO": {
      const q = oneLine(found.rest, 160) || "One more detail";
      await patch(c, { checkin_status: "waiting_for_you", checkin_question: q });
      await tell(
        c,
        `question:${q}`,
        `${airlineName(b, operatorOf(c))} is asking: "${q}" Answer it on the trip card and I'll finish checking you in for ${flightName(b)}. I'll remember the answer for next time.`,
      );
      return new Date(depart.getTime() - BACKUP_BEFORE_H * HOUR);
    }
    case "NOT_FOUND":
      return retryCheckin(
        c,
        depart,
        `${checkinSite(c)} couldn't find booking ${b.confirmation ?? ""}`.trim(),
        true,
      );
    default:
      return retryCheckin(c, depart, "the airline's site didn't finish check-in for my browser");
  }
}

async function checkedIn(c: Ctx, s: BrowserSessionRow, r: Record<string, unknown>): Promise<null> {
  const { b } = c;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 40) : null);
  const skipped = Array.isArray(r.skipped)
    ? r.skipped.filter((x) => typeof x === "string").slice(0, 6)
    : [];
  // Check the boarding pass against the trip: the flight, the date and the name.
  const problems: string[] = [];
  const norm = (x: string | null | undefined) => (x ?? "").replace(/\s+/g, "").toUpperCase();
  const flight = str(r.flight);
  if (
    flight &&
    b.flightNumber &&
    norm(flight) !== norm(b.flightNumber) &&
    !c.plan.checkin_result?.operator
  ) {
    problems.push(`flight ${flight} instead of ${b.flightNumber}`);
  }
  const date = str(r.date);
  if (date && b.departAt && date !== b.departAt.slice(0, 10))
    problems.push(`the date ${date} instead of ${b.departAt.slice(0, 10)}`);
  const last = str(r.lastName);
  if (last && c.profile.last_name && norm(last) !== norm(c.profile.last_name)) {
    problems.push(`the name ${last} instead of ${c.profile.last_name}`);
  }
  const pass = await boardingPass(c, s);
  const result: CheckinResult = {
    ...(c.plan.checkin_result ?? {}),
    seat: str(r.seat),
    group: str(r.group),
    terminal: str(r.terminal),
    gate: str(r.gate),
    skipped: skipped as string[],
    mismatch: problems.length ? list(problems) : null,
  };
  await patch(c, {
    checkin_status: "done",
    checkin_question: null,
    checkin_result: c.deps.sql.json(result as never),
    boarding_pass_file_id: pass?.id ?? null,
  });
  const bits = [
    `You're checked in for ${flightName(b)}${result.seat ? `, seat ${result.seat}` : ""}${result.group ? `, boarding group ${result.group}` : ""}.`,
    pass
      ? "Your boarding pass is on the trip card."
      : "The airline didn't give a boarding pass to download, so show the one in the airline's app or get it at the airport.",
  ];
  if (result.mismatch) {
    bits.push(
      `But the boarding pass shows ${result.mismatch}. Please call ${airlineName(b, operatorOf(c))} to fix it.`,
    );
  }
  if (skipped.length) bits.push(`I said no to the paid extras (${skipped.join(", ")}).`);
  await tell(c, "checked_in", bits.join(" "));
  return null;
}

async function boardingPass(c: Ctx, s: BrowserSessionRow): Promise<FileRow | null> {
  const files = await withUser(
    c.deps.sql,
    c.userId,
    (tx) => tx<FileRow[]>`
      SELECT * FROM files
      WHERE kind = 'browser_download' AND run_id IS NULL AND created_at >= ${s.created_at}
        AND chat_id IS NOT DISTINCT FROM ${s.chat_id}
      ORDER BY created_at DESC`,
  );
  const score = (f: FileRow) =>
    (/board|pass/i.test(f.name ?? "") ? 2 : 0) + (/pdf|pkpass|image/.test(f.mime ?? "") ? 1 : 0);
  return files.sort((a, z) => score(z) - score(a))[0] ?? null;
}

async function retryCheckin(
  c: Ctx,
  depart: Date,
  why: string,
  notFound = false,
): Promise<Date | null> {
  const at = new Date(c.now.getTime() + RETRY_MIN * MINUTE);
  const lastCall = depart.getTime() - BACKUP_BEFORE_H * HOUR;
  if (c.plan.checkin_tries < (notFound ? 2 : MAX_CHECKIN_TRIES) && at.getTime() < lastCall) {
    await patch(c, { checkin_status: "scheduled", checkin_due_at: at });
    return at;
  }
  await backup(c, `I couldn't check you in: ${why}.`);
  return null;
}

async function backup(c: Ctx, why: string) {
  const { b } = c;
  const site = checkinSite(c);
  await patch(c, { checkin_status: "backup", checkin_note: why });
  await tell(
    c,
    "backup",
    `${why} It takes about a minute yourself on ${site} or the airline's app${b.confirmation ? `: booking ${b.confirmation}` : ""}${c.profile.last_name ? `, last name ${c.profile.last_name.toUpperCase()}` : ""}.${c.plan.arrival_status === "done" ? " Your arrival card is already done." : ""}`,
  );
}

// Arrival cards ----------------------------------------------------------------------------------

async function stepArrival(c: Ctx): Promise<Date | null> {
  const { plan, now, b } = c;
  const form = plan.arrival_country ? ARRIVAL_CARDS[plan.arrival_country] : undefined;
  if (!form || ["not_needed", "done", "backup"].includes(plan.arrival_status)) return null;
  const opens = plan.arrival_due_at ? new Date(plan.arrival_due_at) : now;
  const arrive = plan.arrive_at ? new Date(plan.arrive_at) : null;
  if (arrive && now > arrive) {
    await patch(c, { arrival_status: "backup", arrival_note: "Not filed before you landed." });
    return null;
  }
  // Citizens don't file their own country's arrival card.
  if (c.profile.nationality === plan.arrival_country) {
    await patch(c, { arrival_status: "not_needed" });
    return null;
  }
  if (plan.arrival_status === "running") return followArrival(c, form);
  if (now < opens) return opens;

  const missing = arrivalMissing(c);
  if (missing.length) {
    if (plan.arrival_status !== "waiting_for_you") {
      await patch(c, {
        arrival_status: "waiting_for_you",
        arrival_question:
          !c.hotel?.address && !c.hotel?.name
            ? `Where are you staying in ${form.country}?`
            : plan.arrival_question,
      });
    }
    await tell(
      c,
      "arrival_missing",
      `Your ${form.form} can be filed now. I need ${list(missing)}; add it on the trip card and I'll do the rest.`,
    );
    return null;
  }
  if (plan.arrival_status === "waiting_for_you" || plan.arrival_status === "scheduled") {
    await patch(c, { arrival_status: "ready" });
    c.plan.arrival_status = "ready";
  }
  if (!plan.arrival_confirmed) {
    await tell(
      c,
      "arrival_ready",
      `Your ${form.form} is ready to file for ${flightName(b)}. The health and customs answers are your own statement, so check them on the trip card and tap "Looks right, submit".`,
    );
    // One reminder the day before landing.
    const remind = arrive ? new Date(arrive.getTime() - 24 * HOUR) : null;
    if (remind && now >= remind) {
      await tell(
        c,
        "arrival_reminder",
        `Your ${form.form} is still waiting for your OK on the trip card. You land tomorrow.`,
      );
      return null;
    }
    return remind;
  }
  return startArrival(c, form);
}

function arrivalMissing(c: Ctx): string[] {
  const p = c.profile;
  const out: string[] = [];
  if (!p.first_name || !p.last_name) out.push("your name as on your passport");
  if (!p.date_of_birth) out.push("your date of birth");
  if (!p.gender) out.push("your gender");
  if (!p.nationality) out.push("your nationality");
  if (!p.saved_documents.includes("passport") || !p.passport_expiry)
    out.push("your passport details");
  const q = c.plan.arrival_question;
  if (q && !p.answers[q.slice(0, 200)]) out.push(`an answer to "${q}"`);
  return out;
}

async function startArrival(c: Ctx, form: (typeof ARRIVAL_CARDS)[string]): Promise<Date> {
  const docs = await travelDocumentsForRun(c.deps.sql, c.deps.vaultKey, c.userId, null);
  const secrets = documentSecrets(docs, null, [form.domain]).filter(
    (s) => s.alias === "passport_number",
  );
  const [me] = await withUser(
    c.deps.sql,
    c.userId,
    (tx) => tx<{ email: string | null }[]>`SELECT email FROM users`,
  );
  const chatId = await withUser(c.deps.sql, c.userId, mainChat);
  const session = await startFlightBrowse(browserDeps(c.deps), c.userId, {
    purpose: "arrival_card",
    tripItemId: c.plan.trip_item_id,
    chatId,
    title: form.form,
    task: arrivalTask(c, form, me?.email ?? null),
    startUrl: form.url,
    secrets,
    maxCostUsd: RUN_COST_USD,
  });
  await patch(c, {
    arrival_status: "running",
    arrival_browser_id: session.id,
    arrival_tries: c.plan.arrival_tries + 1,
  });
  return new Date(c.now.getTime() + 30000);
}

function arrivalTask(c: Ctx, form: (typeof ARRIVAL_CARDS)[string], email: string | null): string {
  const { b, profile } = c;
  const stay = c.hotel
    ? `${c.hotel.name ?? "Hotel"}${c.hotel.address ? `, ${c.hotel.address}` : ""}${c.hotel.city ? `, ${c.hotel.city}` : ""}`
    : (profile.answers[(c.plan.arrival_question ?? "").slice(0, 200)] ?? "?");
  return [
    BROWSER_INSTRUCTIONS,
    "",
    `Task: file the ${form.form}`,
    `File this person's ${form.form} on the government's official site (${form.domain}) and save the confirmation. Use only ${form.url} and pages on ${form.domain}; never a look-alike site, and never pay anything (the official form is free).`,
    "",
    "The trip",
    `- Arriving on ${flightName(b)} from ${placeName(b.fromCode, b.fromCity)} (${b.fromCode ?? "?"}), landing ${b.arriveAt?.replace("T", " ") ?? "?"} local time`,
    `- Staying at: ${stay}`,
    "- Purpose of the trip: holiday / leisure",
    email
      ? `- Email for the confirmation: ${email}`
      : "- No email address is known: stop with NEEDS_INFO if one is required.",
    "",
    "The traveller",
    ...personLines(profile, true).map((l) => (l.startsWith("-") ? `  ${l}` : `- ${l}`)),
    `- Their passport number is the hidden value "passport_number", typed only into ${form.domain}. ${SECRET_RULE}`,
    "",
    "Their own statement (they confirmed it to us)",
    "- They have no fever or symptoms of an infectious disease, and nothing to declare at customs. Answer the health and customs questions that way. If the form asks anything else you can't answer from these details (for example places visited recently, or an address detail you don't have), stop with NEEDS_INFO.",
    "",
    "Your final reply must start with exactly one of these:",
    `- SUBMITTED {"reference":"the confirmation or reference number, or null"} after the form is submitted. Save the confirmation page as a PDF into outputs/ named "arrival-card.pdf" first.`,
    "- NEEDS_INFO: the exact question, in one sentence",
    "- or NEEDS_CODE:, BLOCKED: as in the rules above.",
  ].join("\n");
}

async function followArrival(c: Ctx, form: (typeof ARRIVAL_CARDS)[string]): Promise<Date | null> {
  let s = await loadSession(c, c.plan.arrival_browser_id);
  if (s && isActive(s)) {
    await advanceFlightBrowse(browserDeps(c.deps), c.userId, s);
    s = (await loadSession(c, s.id)) ?? s;
  }
  if (s && isActive(s)) {
    if (s.status === "needs_user" && s.ask_kind === "code") {
      await tell(
        c,
        `ask:${s.id}`,
        `The ${form.form} site sent you a code. Type it in the secure box on the trip card.`,
      );
    }
    return new Date(c.now.getTime() + 20000);
  }
  const report = s ? reportOf(s) : null;
  const found = report ? readMarker(report) : null;
  if (found?.marker === "SUBMITTED") {
    const r = readJson(found.rest);
    const file = s ? await boardingPass(c, s) : null;
    await patch(c, {
      arrival_status: "done",
      arrival_file_id: file?.id ?? null,
      arrival_note:
        typeof r.reference === "string" ? `Reference ${r.reference.slice(0, 40)}` : null,
      arrival_question: null,
    });
    await tell(
      c,
      "arrival_done",
      `Your ${form.form} is filed${typeof r.reference === "string" ? ` (reference ${r.reference.slice(0, 40)})` : ""}. ${file ? "The confirmation is on the trip card; show it at immigration if asked." : "Keep the confirmation email it sent you."}`,
    );
    return null;
  }
  if (found?.marker === "NEEDS_INFO") {
    const q = oneLine(found.rest, 160);
    await patch(c, { arrival_status: "waiting_for_you", arrival_question: q });
    await tell(
      c,
      `aquestion:${q}`,
      `The ${form.form} asks: "${q}" Answer it on the trip card and I'll finish filing it.`,
    );
    return null;
  }
  if (c.plan.arrival_tries < MAX_ARRIVAL_TRIES) {
    await patch(c, { arrival_status: "ready" });
    return new Date(c.now.getTime() + RETRY_MIN * MINUTE);
  }
  await patch(c, {
    arrival_status: "backup",
    arrival_note: "The official site didn't work for my browser.",
  });
  await tell(
    c,
    "arrival_backup",
    `I couldn't file your ${form.form}: the official site didn't work for my browser. It's free and takes a few minutes yourself at ${form.url} (the official site; avoid look-alike sites that charge).`,
  );
  return null;
}

// Live status ------------------------------------------------------------------------------------

async function stepStatus(c: Ctx, depart: Date, arrive: Date | null): Promise<Date | null> {
  const { deps, now, b, plan } = c;
  if (!deps.status.available || !b.flightNumber || !b.fromCode) return null;
  if (plan.live?.landed) return null;
  const until = depart.getTime() - now.getTime();
  // Muse's cadence: daily until 2 days out, hourly until 6 hours out, then every 10 minutes.
  const gap = until > 48 * HOUR ? 24 * HOUR : until > 6 * HOUR ? HOUR : 10 * MINUTE;
  const last = plan.live_checked_at ? new Date(plan.live_checked_at).getTime() : 0;
  const nextAt = new Date(Math.max(last + gap, now.getTime()));
  // Only worth asking within a week of the flight (FlightAware only has schedules that far out).
  if (until > 7 * 24 * HOUR) return new Date(depart.getTime() - 7 * 24 * HOUR);
  if (now.getTime() < last + gap) return nextAt;
  let live: LiveFlight | null = null;
  try {
    live = await deps.status.find(b.flightNumber, b.fromCode, depart);
  } catch (err) {
    console.error(`flight ${plan.trip_item_id}: status check failed`, (err as Error).message);
  }
  await patch(c, { live: live ? deps.sql.json(live as never) : plan.live, live_checked_at: now });
  if (live) await statusNews(c, live, depart);
  const end = (arrive?.getTime() ?? depart.getTime() + 18 * HOUR) + HOUR;
  return live?.landed || now.getTime() > end ? null : new Date(now.getTime() + gap);
}

async function statusNews(c: Ctx, live: LiveFlight, depart: Date) {
  const { b, now } = c;
  if (live.cancelled) {
    await tell(
      c,
      "cancelled",
      `${airlineName(b, airlineOf(b))} shows ${flightName(b)} as cancelled. Check the airline's app or ${checkinSite(c)} for your new flight; once the new booking email arrives I'll set everything up again.`,
    );
    if (["scheduled", "waiting_for_you"].includes(c.plan.checkin_status))
      await patch(c, { checkin_status: "off" });
    return;
  }
  if (live.departed || depart.getTime() - now.getTime() > 48 * HOUR) return;
  const bucket = Math.round(live.delayMinutes / 15) * 15;
  const told = c.plan.sent.filter((k) => k.startsWith("delay:")).map((k) => Number(k.slice(6)));
  const lastTold = told.length ? told.at(-1)! : 0;
  if (bucket >= 30 && Math.abs(bucket - lastTold) >= 30) {
    const leaves = live.departAt ? atAirport(new Date(live.departAt), b.fromCode) : null;
    await tell(
      c,
      `delay:${bucket}`,
      `${flightName(b)} is now about ${bucket} minutes late${leaves ? `, leaving ${leaves}` : ""}.`,
    );
  } else if (lastTold >= 30 && bucket < 15) {
    await tell(c, "delay:0", `${flightName(b)} is back on time.`);
  }
}

// Time to leave ----------------------------------------------------------------------------------

/** When to be at the airport: about 3 hours before an international flight, 2 before others. */
const earlyMinutes = (international: boolean) => (international ? 180 : 120);

async function stepLeave(c: Ctx, depart: Date): Promise<Date | null> {
  const { deps, now, b, plan } = c;
  const start = new Date(depart.getTime() - 6 * HOUR);
  if (plan.sent.includes("leave") || plan.live?.departed || plan.live?.cancelled)
    return leaveWatch(c, depart);
  if (now < start) return start;
  const from = leaveFrom(c);
  if (!from) return null;
  // Big delays (an hour or more) move the plan later; early departures always move it earlier.
  let planned = depart;
  const liveAt = plan.live?.departAt ? new Date(plan.live.departAt) : null;
  if (liveAt && (liveAt < depart || liveAt.getTime() - depart.getTime() >= HOUR)) planned = liveAt;
  const early = earlyMinutes(c.facts.international);
  const beAt = new Date(planned.getTime() - early * MINUTE);
  const to = airport(b.fromCode);
  let car: RouteOption | null = null;
  let train: RouteOption | null = null;
  const checked = plan.leave_plan?.checkedAt ? new Date(plan.leave_plan.checkedAt).getTime() : 0;
  const fresh = now.getTime() - checked < 30 * MINUTE;
  if (fresh && plan.leave_plan) {
    car =
      plan.leave_plan.mode === "car"
        ? { mode: "car", minutes: plan.leave_plan.minutes! }
        : plan.leave_plan.other;
    train =
      plan.leave_plan.mode === "train"
        ? { mode: "train", minutes: plan.leave_plan.minutes! }
        : plan.leave_plan.other;
  } else if (deps.routes.available && to) {
    const guess = new Date(beAt.getTime() - HOUR);
    const route = (m: "car" | "train") =>
      deps.routes.travel(m, from, { lat: to.lat, lon: to.lon }, guess).catch((err) => {
        console.error(`flight ${plan.trip_item_id}: route failed`, (err as Error).message);
        return null;
      });
    [car, train] = await Promise.all([route("car"), route("train")]);
  }
  const pick = pickMode(car, train);
  const minutes = pick?.minutes ?? null;
  // Without live traffic, allow an hour to get there.
  const leaveBy = new Date(beAt.getTime() - ((minutes ?? 60) + 15) * MINUTE);
  const leavePlan: LeavePlan = {
    mode: pick?.mode ?? null,
    minutes,
    other: pick ? (pick.mode === "car" ? train : car) : null,
    from,
    beAt: beAt.toISOString(),
    early,
    checkedAt: fresh ? plan.leave_plan!.checkedAt : now.toISOString(),
  };
  await patch(c, { leave_by: leaveBy, leave_plan: deps.sql.json(leavePlan as never) });
  const sendAt = new Date(leaveBy.getTime() - 30 * MINUTE);
  if (now < sendAt) return new Date(Math.min(sendAt.getTime(), now.getTime() + 30 * MINUTE));
  await tell(c, "leave", leaveText(c, leaveBy, leavePlan, now));
  return new Date(Math.min(leaveBy.getTime() - 10 * MINUTE, now.getTime() + 15 * MINUTE));
}

export function pickMode(car: RouteOption | null, train: RouteOption | null): RouteOption | null {
  if (car && train) return train.minutes <= car.minutes + 10 ? train : car;
  return car ?? train;
}

function leaveFrom(c: Ctx): string | null {
  // The flight home leaves from the hotel; any other flight from home.
  const day = c.b.departAt?.slice(0, 10);
  const hotels = c.trip.filter((t): t is Extract<Booking, { kind: "hotel" }> => t.kind === "hotel");
  const stay = hotels.find(
    (h) => h.checkOut && day && h.checkOut <= day && (!h.checkIn || h.checkIn < day),
  );
  if (stay) return [stay.name, stay.address, stay.city].filter(Boolean).join(", ") || null;
  return c.profile.home_address;
}

function leaveText(c: Ctx, leaveBy: Date, p: LeavePlan, now: Date): string {
  const { b } = c;
  const place = b.fromCode ?? "the airport";
  const lead =
    now >= leaveBy
      ? `Time to leave now for ${flightName(b)}.`
      : `Time to leave in ${Math.max(5, Math.round((leaveBy.getTime() - now.getTime()) / MINUTE / 5) * 5)} min for ${flightName(b)}: leave by ${atAirport(leaveBy, b.fromCode).split(", ")[1]}.`;
  const how = !p.mode
    ? "I can't see traffic, so I've allowed about an hour to get there."
    : p.mode === "train"
      ? `Take the train: about ${p.minutes} min door to door${p.other ? `, vs ${p.other.minutes} min by car in current traffic` : ""}.`
      : `Take the car: about ${p.minutes} min to ${place} in current traffic${p.other ? `, vs ${p.other.minutes} min by train` : ""}.`;
  const be = `Aim to be at ${place}${c.plan.checkin_result?.terminal ? ` terminal ${c.plan.checkin_result.terminal}` : ""} by ${atAirport(new Date(p.beAt), b.fromCode).split(", ")[1]}, about ${p.early / 60} hours before the flight.`;
  const late =
    c.plan.live && c.plan.live.delayMinutes >= 30 && c.plan.live.delayMinutes < 60
      ? ` Your flight is about ${c.plan.live.delayMinutes} min late, but I've kept your leave time in case it catches up.`
      : "";
  return `${lead} ${how} ${be}${late}`;
}

/** After the reminder: one heads-up if traffic gets much worse before you leave. */
async function leaveWatch(c: Ctx, depart: Date): Promise<Date | null> {
  const { plan, now, deps, b } = c;
  const p = plan.leave_plan;
  const leaveBy = plan.leave_by ? new Date(plan.leave_by) : null;
  if (!p || !leaveBy || p.mode !== "car" || !p.minutes || plan.sent.includes("leave_worse"))
    return null;
  if (now >= leaveBy || !deps.routes.available) return null;
  const to = airport(b.fromCode);
  if (!to) return null;
  const car = await deps.routes
    .travel("car", p.from, { lat: to.lat, lon: to.lon }, now)
    .catch(() => null);
  if (car && car.minutes >= p.minutes + 15) {
    await tell(
      c,
      "leave_worse",
      `Traffic just got worse: it's now about ${car.minutes} min to ${b.fromCode}. Leave now if you can.`,
    );
    return null;
  }
  void depart;
  return new Date(Math.min(leaveBy.getTime(), now.getTime() + 10 * MINUTE));
}

// What the person does on the card ---------------------------------------------------------------

/** After the prep card is saved: questions answered go away, and the flight is looked at again. */
export async function afterPrep(
  deps: FlightDeps,
  userId: string,
  itemId: string,
  input: {
    noBannedItems?: boolean;
    arrivalConfirmed?: boolean;
    autoCheckin?: boolean;
    answered?: boolean;
  },
): Promise<void> {
  const now = deps.now?.() ?? new Date();
  await withUser(deps.sql, userId, async (tx) => {
    const [plan] = await tx<
      FlightPlanRow[]
    >`SELECT * FROM flight_plans WHERE trip_item_id = ${itemId}`;
    if (!plan) return;
    const fields: Record<string, unknown> = { next_due_at: now, poked: true, updated_at: now };
    if (input.noBannedItems !== undefined) fields.no_banned_items = input.noBannedItems;
    if (input.arrivalConfirmed !== undefined) fields.arrival_confirmed = input.arrivalConfirmed;
    if (input.autoCheckin !== undefined) {
      fields.auto_checkin = input.autoCheckin;
      if (!input.autoCheckin && ["scheduled", "waiting_for_you"].includes(plan.checkin_status)) {
        fields.checkin_status = "off";
      }
      if (input.autoCheckin && plan.checkin_status === "off") fields.checkin_status = "scheduled";
    }
    if (input.answered) {
      if (plan.checkin_question) fields.checkin_question = null;
    }
    // A check-in or arrival card waiting on the person gets another go now.
    if (
      plan.checkin_status === "waiting_for_you" ||
      (plan.checkin_status === "backup" && input.answered)
    ) {
      fields.checkin_status = "scheduled";
      fields.checkin_due_at = now;
    }
    if (plan.arrival_status === "waiting_for_you") fields.arrival_status = "scheduled";
    await tx`UPDATE flight_plans SET ${tx(fields)} WHERE trip_item_id = ${itemId}`;
  });
}

/** The flight's plan, or null when it isn't one of this person's flights. */
export async function planOf(sql: Sql, userId: string, itemId: string) {
  const [row] = await withUser(
    sql,
    userId,
    (tx) => tx<(FlightPlanRow & { details: Booking })[]>`
      SELECT p.*, i.details FROM flight_plans p JOIN trip_items i ON i.id = p.trip_item_id
      WHERE p.trip_item_id = ${itemId}`,
  );
  return row ?? null;
}

// The card ---------------------------------------------------------------------------------------

/** The live trip cards for these flights (by trip item id). Only ever sent to their owner. */
export async function flightViews(
  sql: Sql,
  userId: string,
  itemIds: string[],
  secret: string,
  opts: { liveAvailable?: boolean; now?: Date },
): Promise<Map<string, FlightView>> {
  const out = new Map<string, FlightView>();
  if (!itemIds.length) return out;
  const now = opts.now ?? new Date();
  const data = await withUser(sql, userId, async (tx) => {
    const plans = await tx<(FlightPlanRow & { details: Booking; trip_id: string })[]>`
      SELECT p.*, i.details, i.trip_id FROM flight_plans p JOIN trip_items i ON i.id = p.trip_item_id
      WHERE p.trip_item_id = ANY(${itemIds})`;
    const tripIds = [...new Set(plans.map((p) => p.trip_id))];
    const trips = tripIds.length
      ? await tx<{ trip_id: string; details: Booking }[]>`
          SELECT trip_id, details FROM trip_items WHERE trip_id = ANY(${tripIds}) AND kind = 'booking'
          ORDER BY item_date, created_at`
      : [];
    const browserIds = plans
      .flatMap((p) => [p.checkin_browser_id, p.arrival_browser_id])
      .filter((x): x is string => !!x);
    const browsers = browserIds.length
      ? await tx<BrowserSessionRow[]>`SELECT * FROM browser_sessions WHERE id = ANY(${browserIds})`
      : [];
    const fileIds = plans
      .flatMap((p) => [p.boarding_pass_file_id, p.arrival_file_id])
      .filter((x): x is string => !!x);
    const files = fileIds.length
      ? await tx<FileRow[]>`SELECT * FROM files WHERE id = ANY(${fileIds})`
      : [];
    return { plans, trips, browsers, files, profile: await profileOf(tx, userId) };
  });
  for (const p of data.plans) {
    const b = p.details as FlightBooking;
    const facts = factsFor(b);
    const trip = data.trips.filter((t) => t.trip_id === p.trip_id).map((t) => t.details);
    const needs = needsFor(data.profile, facts);
    const browser = (id: string | null) => {
      const s = id ? data.browsers.find((x) => x.id === id) : undefined;
      return s ? viewOf(s, secret) : null;
    };
    const file = (id: string | null) => {
      const f = id ? data.files.find((x) => x.id === id) : undefined;
      return f ? fileView(f) : null;
    };
    const depart = p.depart_at ? new Date(p.depart_at) : null;
    const form = p.arrival_country ? ARRIVAL_CARDS[p.arrival_country] : undefined;
    const hotel = hotelFor(b, trip);
    const code = airlineOf(b);
    const live = p.live;
    out.set(p.trip_item_id, {
      id: p.trip_item_id,
      airline: b.airline,
      airlineName: airlineName(b, code),
      flightNumber: b.flightNumber,
      fromCode: b.fromCode,
      fromCity: b.fromCity,
      toCode: b.toCode,
      toCity: b.toCity,
      departLocal: b.departAt,
      arriveLocal: b.arriveAt,
      departAt: depart?.toISOString() ?? null,
      confirmation: b.confirmation,
      international: facts.international,
      today:
        !!depart &&
        depart.getTime() - now.getTime() <= 6 * HOUR &&
        now.getTime() <
          (p.arrive_at ? new Date(p.arrive_at).getTime() : depart.getTime() + 12 * HOUR),
      past: p.checkin_status === "past",
      liveAvailable: opts.liveAvailable ?? !!process.env.FLIGHTAWARE_API_KEY,
      live: live
        ? {
            status: live.cancelled
              ? "cancelled"
              : live.landed
                ? "landed"
                : live.departed
                  ? "departed"
                  : live.delayMinutes >= 15
                    ? "delayed"
                    : "on_time",
            delayMinutes: live.delayMinutes,
            departLocal: live.departAt ? instantToLocal(new Date(live.departAt), b.fromCode) : null,
            arriveLocal: live.arriveAt ? instantToLocal(new Date(live.arriveAt), b.toCode) : null,
            terminal: live.terminal,
            gate: live.gate,
            arrivalTerminal: live.arrivalTerminal,
            baggageClaim: live.baggageClaim,
            checkedAt: p.live_checked_at ? new Date(p.live_checked_at).toISOString() : null,
          }
        : null,
      checkin: {
        status: p.checkin_status,
        opensAt: p.checkin_due_at ? new Date(p.checkin_due_at).toISOString() : null,
        auto: p.auto_checkin,
        question: p.checkin_question,
        note: p.checkin_note,
        seat: p.checkin_result?.seat ?? null,
        group: p.checkin_result?.group ?? null,
        terminal: p.checkin_result?.terminal ?? null,
        mismatch: p.checkin_result?.mismatch ?? null,
        skipped: p.checkin_result?.skipped ?? [],
        site: code && AIRLINES[code] ? AIRLINES[code].domain : null,
        boardingPass: file(p.boarding_pass_file_id),
        browser: browser(p.checkin_browser_id),
      },
      prep: {
        required: needs.required,
        optional: needs.optional,
        have: needs.have,
        warnings: needs.warnings,
        noBannedItems: p.no_banned_items,
        airlineCode: code,
      },
      arrival: form
        ? {
            form: form.form,
            country: form.country,
            site: form.url,
            status: p.arrival_status,
            opensAt: p.arrival_due_at ? new Date(p.arrival_due_at).toISOString() : null,
            confirmed: p.arrival_confirmed,
            question: p.arrival_question,
            note: p.arrival_note,
            stay: hotel ? [hotel.name, hotel.address].filter(Boolean).join(", ") || null : null,
            file: file(p.arrival_file_id),
            browser: browser(p.arrival_browser_id),
          }
        : null,
      leave: p.leave_by
        ? {
            leaveBy: new Date(p.leave_by).toISOString(),
            leaveLocal: instantToLocal(new Date(p.leave_by), b.fromCode),
            mode: p.leave_plan?.mode ?? null,
            minutes: p.leave_plan?.minutes ?? null,
            otherMode: p.leave_plan?.other?.mode ?? null,
            otherMinutes: p.leave_plan?.other?.minutes ?? null,
            beAtLocal: p.leave_plan?.beAt
              ? instantToLocal(new Date(p.leave_plan.beAt), b.fromCode)
              : null,
          }
        : null,
      needsHomeAddress: !data.profile.home_address,
    });
  }
  return out;
}

/** The person's upcoming flights, soonest first (for the "Today" card and the card refresh). */
export async function upcomingFlightIds(sql: Sql, userId: string): Promise<string[]> {
  const rows = await withUser(
    sql,
    userId,
    (tx) => tx<{ trip_item_id: string }[]>`
      SELECT trip_item_id FROM flight_plans
      WHERE checkin_status <> 'past' AND depart_at > now() - interval '12 hours'
      ORDER BY depart_at LIMIT 10`,
  );
  return rows.map((r) => r.trip_item_id);
}
