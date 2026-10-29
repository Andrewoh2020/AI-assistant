import { withUser, type Sql } from "@ai-assistant/db";
import type { Booking, CalendarStatus } from "@ai-assistant/api-client";
import { airport, inZone, instantToLocal } from "./airports.js";
import { cleanBooking, type BookingReader, type FoundBooking } from "./bookings.js";
import { fileBooking, isPast, SYNC_EVERY_MS, tellMainChat } from "./gmail.js";
import { GoogleAuthError, type CalendarEvent, type GoogleCalendar } from "./google.js";
import { accountToken, deleteAccountToken, saveAccountToken, type VaultKey } from "./vault.js";

/**
 * The Google Calendar connector. Flights the person only has in their calendar (an event Gmail
 * added, or one they made) become trips with a trip card, like a booking email. It's checked at
 * the same moments as Gmail: hourly, and when the app is used and the last check is over 15
 * minutes old. Each check is one request for the coming year's events; only events that look like
 * flights are read, each once (again if it changes). Plan: docs/calendar-plan.html.
 */

export interface CalendarDeps {
  sql: Sql;
  calendar: GoogleCalendar;
  reader: BookingReader;
  vaultKey: VaultKey;
}

const PROVIDER = "google_calendar";
/** Airlines sell about 11 months ahead. */
const LOOK_AHEAD_DAYS = 330;
const MAX_EVENTS = 500;

// Connecting ---------------------------------------------------------------------------------------

/** After the connect page sends the person back: finds the calendar they connected and keeps it. */
export async function connectCalendar(
  deps: CalendarDeps,
  userId: string,
  travilaUserId: string,
): Promise<void> {
  const account = await deps.calendar.connectedAccount(travilaUserId);
  if (!account) throw new GoogleAuthError("No working Google Calendar account was connected");
  const email = account.email || null;
  await saveAccountToken(deps.sql, deps.vaultKey, userId, PROVIDER, account.accountId);
  await withUser(deps.sql, userId, async (tx) => {
    // A different Google account starts over: its events haven't been read yet.
    const [old] = await tx<{ account_email: string | null }[]>`
      SELECT account_email FROM connector_accounts WHERE provider = ${PROVIDER}`;
    if (old && old.account_email !== email) await tx`DELETE FROM calendar_scanned`;
    await tx`
      INSERT INTO connector_accounts (user_id, provider, status, account_email)
      VALUES (${userId}, ${PROVIDER}, 'connected', ${email})
      ON CONFLICT (user_id, provider) DO UPDATE
        SET status = 'connected', account_email = EXCLUDED.account_email, last_error = NULL,
            sync_started_at = NULL, last_synced_at = NULL`;
  });
}

/** Forgets the connection and removes it at Travila too. Trips already found stay. */
export async function disconnectCalendar(
  deps: CalendarDeps,
  userId: string,
  travilaUserId: string,
): Promise<void> {
  const token = await accountToken(deps.sql, deps.vaultKey, userId, PROVIDER);
  await deleteAccountToken(deps.sql, userId, PROVIDER);
  await withUser(deps.sql, userId, async (tx) => {
    await tx`DELETE FROM connector_accounts WHERE provider = ${PROVIDER}`;
    await tx`DELETE FROM calendar_scanned`;
  });
  if (token) await deps.calendar.disconnect(travilaUserId, token);
}

export async function calendarStatus(sql: Sql, userId: string): Promise<CalendarStatus> {
  const [row] = await withUser(
    sql,
    userId,
    (tx) => tx<{ status: string; account_email: string | null }[]>`
      SELECT status, account_email FROM connector_accounts WHERE provider = ${PROVIDER}`,
  );
  return {
    connected: row?.status === "connected",
    needsReconnect: row?.status === "error",
    email: row?.account_email ?? null,
  };
}

// Checking the calendar ------------------------------------------------------------------------

/** Checks the calendar if it is connected and the last check is old enough. Never throws. */
export async function syncCalendarIfDue(deps: CalendarDeps, userId: string): Promise<void> {
  try {
    const [row] = await withUser(
      deps.sql,
      userId,
      (tx) => tx<{ last_synced_at: Date | null }[]>`
        SELECT last_synced_at FROM connector_accounts
        WHERE provider = ${PROVIDER} AND status = 'connected'`,
    );
    if (!row) return;
    if (row.last_synced_at && Date.now() - row.last_synced_at.getTime() < SYNC_EVERY_MS) return;
    await syncCalendar(deps, userId);
  } catch (err) {
    console.error("Calendar check failed", (err as Error).message);
  }
}

/** Checks the calendar now, for a question about trips (after a check already running). Never throws. */
export async function checkCalendarNow(
  deps: CalendarDeps,
  userId: string,
  waitMs = 30000,
): Promise<void> {
  const started = Date.now();
  try {
    for (;;) {
      const [row] = await withUser(
        deps.sql,
        userId,
        (tx) => tx<{ busy: boolean }[]>`
          SELECT coalesce(sync_started_at > now() - interval '2 minutes', false) AS busy
          FROM connector_accounts WHERE provider = ${PROVIDER} AND status = 'connected'`,
      );
      if (!row) return;
      if (!row.busy) break;
      if (Date.now() - started > waitMs) return;
      await new Promise((r) => setTimeout(r, 1000));
    }
    await syncCalendar(deps, userId, Math.max(5000, waitMs - (Date.now() - started)));
  } catch (err) {
    console.error("Calendar check failed", (err as Error).message);
  }
}

/**
 * Reads the coming year's events and files the flights among them. Returns the bookings that are
 * new. Only one check runs at a time per person (a 2-minute lease).
 */
export async function syncCalendar(
  deps: CalendarDeps,
  userId: string,
  budgetMs = 25000,
): Promise<Booking[]> {
  const [lease] = await withUser(
    deps.sql,
    userId,
    (tx) => tx<{ last_synced_at: Date | null }[]>`
      UPDATE connector_accounts SET sync_started_at = now()
      WHERE provider = ${PROVIDER} AND status = 'connected'
        AND (sync_started_at IS NULL OR sync_started_at < now() - interval '2 minutes')
      RETURNING last_synced_at`,
  );
  if (!lease) return [];
  const added: Booking[] = [];
  let failure: string | null = null;
  let incomplete = false;
  try {
    const accountId = await accountToken(deps.sql, deps.vaultKey, userId, PROVIDER);
    if (!accountId) throw new GoogleAuthError("no saved account");
    const [me] = await withUser(
      deps.sql,
      userId,
      (tx) => tx<{ travila_user_id: string }[]>`
        SELECT travila_user_id FROM users WHERE id = ${userId}`,
    );
    const calendar = await deps.calendar.open(me!.travila_user_id, accountId);
    const now = Date.now();
    const events = (
      await calendar.events(
        new Date(now - 86400000),
        new Date(now + LOOK_AHEAD_DAYS * 86400000),
        MAX_EVENTS,
      )
    ).filter(looksLikeFlight);
    const seen = new Map(
      (
        await withUser(
          deps.sql,
          userId,
          (tx) => tx<{ event_id: string; event_updated: string }[]>`
            SELECT event_id, event_updated FROM calendar_scanned
            WHERE event_id = ANY(${events.map((e) => e.id)})`,
        )
      ).map((r) => [r.event_id, r.event_updated]),
    );
    const todo = events.filter((e) => seen.get(e.id) !== e.updated);
    const started = Date.now();
    for (let i = 0; i < todo.length; i += 4) {
      if (Date.now() - started > budgetMs) {
        incomplete = true;
        break;
      }
      const batch = await Promise.all(
        todo.slice(i, i + 4).map(async (e) => {
          try {
            return { e, found: await flightsInEvent(e, deps.reader) };
          } catch (err) {
            // Try this event again next time.
            console.error("Couldn't read a calendar event", (err as Error).message);
            return null;
          }
        }),
      );
      await withUser(deps.sql, userId, async (tx) => {
        for (const r of batch) {
          if (!r) continue;
          for (const b of r.found) {
            if (await fileBooking(tx, userId, b, r.e.id, "calendar")) added.push(b);
          }
          await tx`INSERT INTO calendar_scanned (user_id, event_id, event_updated, bookings)
                   VALUES (${userId}, ${r.e.id}, ${r.e.updated}, ${r.found.length})
                   ON CONFLICT (user_id, event_id) DO UPDATE
                     SET event_updated = EXCLUDED.event_updated, bookings = EXCLUDED.bookings,
                         scanned_at = now()`;
        }
      });
    }
  } catch (err) {
    failure = err instanceof GoogleAuthError ? "reconnect" : "check_failed";
    if (failure === "check_failed") console.error("Calendar check failed", (err as Error).message);
  }
  await withUser(deps.sql, userId, async (tx) => {
    if (failure === "reconnect") {
      await tx`UPDATE connector_accounts SET status = 'error', last_error = 'reconnect',
                 sync_started_at = NULL WHERE provider = ${PROVIDER}`;
    } else {
      await tx`UPDATE connector_accounts SET sync_started_at = NULL, last_error = ${failure},
                 last_synced_at = CASE WHEN ${failure}::text IS NULL AND NOT ${incomplete}
                                       THEN now() ELSE last_synced_at END
               WHERE provider = ${PROVIDER}`;
    }
    const upcoming = added.filter((b) => !isPast(b));
    if (upcoming.length)
      await tellMainChat(tx, userId, upcoming, !lease.last_synced_at, "calendar");
  });
  return added;
}

// Reading an event -----------------------------------------------------------------------------

/** "UA 123", "UA123", "B6 915" (airline codes are two letters or a letter and a digit). */
const FLIGHT_NO = /\b([A-Z]{2}|[A-Z]\d|\d[A-Z]) ?(\d{1,4})\b/;
/** "SFO-JFK", "SFO → JFK", "SFO to JFK". */
const ROUTE = /\b([A-Z]{3}) ?(?:-|–|—|→|✈|>|to) ?([A-Z]{3})\b/;
const BOOKING_REF =
  /(?:[Bb]ooking|[Cc]onfirmation|[Rr]eservation|[Rr]ecord [Ll]ocator|PNR|[Cc]onf\.?)(?: (?:[Rr]ef(?:erence)?|[Cc]ode|[Nn]umber|[Nn]o\.?|#))? ?[:#]? ?([A-Z0-9]{5,8})\b/;

const textOf = (e: CalendarEvent) => `${e.summary}\n${e.location}\n${e.description}`;

/**
 * Whether an event might be a flight: a timed event with a flight number, and the word flight
 * (or a plane) or a route of airport codes. Only these are read.
 */
export function looksLikeFlight(e: CalendarEvent): boolean {
  if (!e.start.dateTime) return false;
  const text = textOf(e);
  return FLIGHT_NO.test(text) && (/\bflight\b|✈|🛫/i.test(text) || ROUTE.test(text));
}

/** The event's start or end as local time at the airport ("2026-11-03T10:30"). */
function localAt(t: CalendarEvent["start"], code: string | null): string | null {
  if (!t.dateTime) return null;
  const at = new Date(t.dateTime);
  if (Number.isNaN(at.getTime())) return null;
  return (
    instantToLocal(at, code) ?? (t.timeZone ? inZone(at, t.timeZone) : t.dateTime.slice(0, 16))
  );
}

/**
 * The flights in one calendar event. A plain event ("UA 123 SFO-EWR") is read directly; others
 * (like "Flight to Paris (AF 1234)", whose airports are only in the notes) go to the model, whose
 * answer must name a flight number that is in the event. The event's own times are used, turned
 * into local time at each airport.
 */
export async function flightsInEvent(
  e: CalendarEvent,
  reader: BookingReader,
): Promise<FoundBooking[]> {
  const direct = flightFromText(e);
  if (direct) return [direct];
  const found = (
    await reader.read({
      id: `calendar:${e.id}`,
      subject: e.summary,
      from: "Google Calendar",
      date: new Date(),
      html: "",
      text: [
        "A calendar event (not an email).",
        `Title: ${e.summary}`,
        `Starts: ${e.start.dateTime}${e.start.timeZone ? ` (${e.start.timeZone})` : ""}`,
        `Ends: ${e.end.dateTime ?? e.end.date ?? ""}${e.end.timeZone ? ` (${e.end.timeZone})` : ""}`,
        e.location && `Where: ${e.location}`,
        e.description && `Notes: ${e.description.slice(0, 4000)}`,
      ]
        .filter(Boolean)
        .join("\n"),
    })
  ).filter((b): b is Extract<FoundBooking, { kind: "flight" }> => b.kind === "flight");
  const compact = textOf(e).replace(/\s+/g, "").toUpperCase();
  const flights = found.filter(
    (b) =>
      b.status === "confirmed" &&
      b.flightNumber &&
      compact.includes(b.flightNumber.replace(" ", "")),
  );
  if (flights.length !== 1) return flights;
  // One flight: it is the event, so the event's times are the flight's.
  const [f] = flights as [Extract<FoundBooking, { kind: "flight" }>];
  return [
    {
      ...f,
      departAt: localAt(e.start, f.fromCode) ?? f.departAt,
      arriveAt: localAt(e.end, f.toCode) ?? f.arriveAt,
      confirmation: f.confirmation ?? bookingRef(e),
    },
  ];
}

const bookingRef = (e: CalendarEvent) => textOf(e).match(BOOKING_REF)?.[1] ?? null;

/** A flight from an event that names its flight number and route outright, without the model. */
export function flightFromText(e: CalendarEvent): FoundBooking | null {
  // Only from the title: notes can hold other numbers ("Gate B12"), so those go to the model.
  const no = e.summary.match(FLIGHT_NO);
  let route: [string, string] | null = null;
  for (const m of textOf(e).matchAll(new RegExp(ROUTE, "g"))) {
    if (airport(m[1]) && airport(m[2])) {
      route = [m[1]!, m[2]!];
      break;
    }
  }
  if (!no || !route) return null;
  const [from, to] = route;
  return cleanBooking({
    kind: "flight",
    status: "confirmed",
    airline: null,
    flightNumber: `${no[1]}${no[2]}`,
    fromCode: from,
    fromCity: airport(from)?.city ?? null,
    toCode: to,
    toCity: airport(to)?.city ?? null,
    departAt: localAt(e.start, from),
    arriveAt: localAt(e.end, to),
    confirmation: bookingRef(e),
  });
}
