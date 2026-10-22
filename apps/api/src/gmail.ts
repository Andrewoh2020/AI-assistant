import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { withUser, type Sql, type TransactionSql } from "@ai-assistant/db";
import type { Booking, GmailStatus, TripView } from "@ai-assistant/api-client";
import { dedupeKey, type BookingReader, type FoundBooking } from "./bookings.js";
import { GoogleAuthError, type Google } from "./google.js";
import { accountToken, deleteAccountToken, saveAccountToken, type VaultKey } from "./vault.js";

/**
 * The Gmail connector. Once Gmail is connected the app checks it now and then (right after
 * connecting, then whenever the person uses the app and the last check is over 15 minutes old),
 * finds flight and hotel bookings, files them into trips, and says so in the Main chat. The
 * check-in flow that will use these trips is in /mnt/project-files/design/checkin-plan.html.
 */

export interface GmailDeps {
  sql: Sql;
  google: Google;
  reader: BookingReader;
  vaultKey: VaultKey;
  secret: string;
}

export const SYNC_EVERY_MS = 15 * 60 * 1000;
/** How far back the first check looks: bookings are often made months ahead. */
const FIRST_LOOK_BACK = "180d";
const FIRST_MAX = 60;
const LATER_MAX = 25;
// Subject words that booking emails use. Gmail's own search does this filtering, so other mail is
// never downloaded.
const QUERY =
  'subject:(confirmation OR confirmed OR itinerary OR booking OR reservation OR "e-ticket" OR ' +
  'eticket OR receipt OR flight OR hotel OR trip OR "check-in" OR stay OR cancelled OR change) ' +
  "-in:chats -in:spam -in:trash";

// Connecting ---------------------------------------------------------------------------------------

const STATE_MINUTES = 15;

/** The `state` sent through Google's sign-in, so the answer can only land on the account that asked. */
export function signState(userId: string, secret: string, now = Date.now()): string {
  const body = `${userId}.${randomBytes(9).toString("base64url")}.${now + STATE_MINUTES * 60000}`;
  const mac = createHmac("sha256", secret).update(`gmail-state:${body}`).digest("base64url");
  return `${body}.${mac}`;
}

export function checkState(state: string, userId: string, secret: string, now = Date.now()) {
  const parts = state.split(".");
  if (parts.length !== 4) return false;
  const [uid, nonce, exp, mac] = parts as [string, string, string, string];
  const want = createHmac("sha256", secret).update(`gmail-state:${uid}.${nonce}.${exp}`).digest();
  const got = Buffer.from(mac, "base64url");
  return (
    got.length === want.length && timingSafeEqual(got, want) && uid === userId && Number(exp) > now
  );
}

export async function connectGmail(
  deps: GmailDeps,
  userId: string,
  code: string,
  redirectUri: string,
): Promise<void> {
  const { refreshToken, email, scopes } = await deps.google.exchangeCode(code, redirectUri);
  await saveAccountToken(deps.sql, deps.vaultKey, userId, "gmail", refreshToken);
  await withUser(deps.sql, userId, async (tx) => {
    // A different Gmail address starts over: its mail hasn't been read yet.
    const [old] = await tx<{ account_email: string | null }[]>`
      SELECT account_email FROM connector_accounts WHERE provider = 'gmail'`;
    if (old && old.account_email !== email) await tx`DELETE FROM gmail_scanned`;
    await tx`
      INSERT INTO connector_accounts (user_id, provider, status, account_email, scopes)
      VALUES (${userId}, 'gmail', 'connected', ${email}, ${scopes})
      ON CONFLICT (user_id, provider) DO UPDATE
        SET status = 'connected', account_email = EXCLUDED.account_email,
            scopes = EXCLUDED.scopes, last_error = NULL, sync_started_at = NULL,
            last_synced_at = CASE WHEN connector_accounts.account_email = EXCLUDED.account_email
                                  THEN connector_accounts.last_synced_at END`;
  });
}

/** Forgets the connection and tells Google to cancel the token. Trips already found stay. */
export async function disconnectGmail(deps: GmailDeps, userId: string): Promise<void> {
  const token = await accountToken(deps.sql, deps.vaultKey, userId, "gmail");
  await deleteAccountToken(deps.sql, userId, "gmail");
  await withUser(deps.sql, userId, async (tx) => {
    await tx`DELETE FROM connector_accounts WHERE provider = 'gmail'`;
    await tx`DELETE FROM gmail_scanned`;
  });
  if (token) await deps.google.revoke(token);
}

interface ConnectorRow {
  status: "connected" | "not_connected" | "error";
  account_email: string | null;
  last_synced_at: Date | null;
  sync_started_at: Date | null;
}

export async function gmailStatus(deps: GmailDeps, userId: string): Promise<GmailStatus> {
  const [row] = await withUser(
    deps.sql,
    userId,
    (tx) => tx<ConnectorRow[]>`SELECT * FROM connector_accounts WHERE provider = 'gmail'`,
  );
  return {
    available: deps.google.available,
    connected: row?.status === "connected",
    needsReconnect: row?.status === "error",
    email: row?.account_email ?? null,
    lastCheckedAt: row?.last_synced_at?.toISOString() ?? null,
    trips: await upcomingTrips(deps.sql, userId),
  };
}

// Checking the mail ----------------------------------------------------------------------------

/** Checks Gmail if it is connected and the last check is old enough. Never throws. */
export async function syncIfDue(deps: GmailDeps, userId: string): Promise<void> {
  try {
    const [row] = await withUser(
      deps.sql,
      userId,
      (tx) => tx<ConnectorRow[]>`
        SELECT * FROM connector_accounts WHERE provider = 'gmail' AND status = 'connected'`,
    );
    if (!row) return;
    if (row.last_synced_at && Date.now() - row.last_synced_at.getTime() < SYNC_EVERY_MS) return;
    await syncGmail(deps, userId);
  } catch (err) {
    console.error("Gmail check failed", (err as Error).message);
  }
}

/**
 * Reads new booking emails and files what it finds. Returns the bookings that are new (not
 * updates). Only one check runs at a time per person (a 2-minute lease).
 */
export async function syncGmail(
  deps: GmailDeps,
  userId: string,
  budgetMs = 40000,
): Promise<Booking[]> {
  const [lease] = await withUser(
    deps.sql,
    userId,
    (tx) => tx<{ last_synced_at: Date | null }[]>`
      UPDATE connector_accounts SET sync_started_at = now()
      WHERE provider = 'gmail' AND status = 'connected'
        AND (sync_started_at IS NULL OR sync_started_at < now() - interval '2 minutes')
      RETURNING last_synced_at`,
  );
  if (!lease) return [];
  const first = !lease.last_synced_at;
  const added: Booking[] = [];
  let failure: string | null = null;
  let incomplete = false;
  try {
    const refresh = await accountToken(deps.sql, deps.vaultKey, userId, "gmail");
    if (!refresh) throw new GoogleAuthError("no saved token");
    const access = await deps.google.accessToken(refresh);
    const since = first
      ? `newer_than:${FIRST_LOOK_BACK}`
      : // A day of overlap, so mail that arrived during the last check isn't missed.
        `after:${Math.floor(lease.last_synced_at!.getTime() / 1000) - 86400}`;
    const ids = await deps.google.listMessages(
      access,
      `${QUERY} ${since}`,
      first ? FIRST_MAX : LATER_MAX,
    );
    const seen = new Set(
      (
        await withUser(
          deps.sql,
          userId,
          (tx) => tx<{ message_id: string }[]>`
            SELECT message_id FROM gmail_scanned WHERE message_id = ANY(${ids})`,
        )
      ).map((r) => r.message_id),
    );
    // Oldest first, so a change or cancellation lands after the booking it changes. A few emails
    // are read at once; each batch is saved as it finishes, so a check cut short (the hosted site
    // stops work after a minute) carries on from there next time.
    const todo = ids.filter((i) => !seen.has(i)).reverse();
    const started = Date.now();
    for (let i = 0; i < todo.length; i += 4) {
      if (Date.now() - started > budgetMs) {
        incomplete = true;
        break;
      }
      const batch = await Promise.all(
        todo.slice(i, i + 4).map(async (id) => {
          const mail = await deps.google.getMessage(access, id);
          try {
            return { id: mail.id, found: await deps.reader.read(mail) };
          } catch (err) {
            // Try this email again next time.
            console.error("Couldn't read a booking email", (err as Error).message);
            return null;
          }
        }),
      );
      await withUser(deps.sql, userId, async (tx) => {
        for (const r of batch) {
          if (!r) continue;
          for (const b of r.found) {
            if (await fileBooking(tx, userId, b, r.id)) added.push(b);
          }
          await tx`INSERT INTO gmail_scanned (user_id, message_id, bookings)
                   VALUES (${userId}, ${r.id}, ${r.found.length}) ON CONFLICT DO NOTHING`;
        }
      });
    }
  } catch (err) {
    failure = err instanceof GoogleAuthError ? "reconnect" : "check_failed";
    if (failure === "check_failed") console.error("Gmail check failed", (err as Error).message);
  }
  await withUser(deps.sql, userId, async (tx) => {
    if (failure === "reconnect") {
      await tx`UPDATE connector_accounts SET status = 'error', last_error = 'reconnect',
                 sync_started_at = NULL WHERE provider = 'gmail'`;
    } else {
      await tx`UPDATE connector_accounts SET sync_started_at = NULL, last_error = ${failure},
                 last_synced_at = CASE WHEN ${failure}::text IS NULL AND NOT ${incomplete}
                                       THEN now() ELSE last_synced_at END
               WHERE provider = 'gmail'`;
    }
    const upcoming = added.filter((b) => !isPast(b));
    if (upcoming.length) await tellMainChat(tx, userId, upcoming, first);
  });
  return added;
}

// Trips -----------------------------------------------------------------------------------------

const startOf = (b: Booking) =>
  b.kind === "flight" ? (b.departAt?.slice(0, 10) ?? null) : b.checkIn;
const endOf = (b: Booking) =>
  b.kind === "flight" ? (b.arriveAt?.slice(0, 10) ?? startOf(b)) : (b.checkOut ?? b.checkIn);

function isPast(b: Booking, now = new Date()) {
  const end = endOf(b);
  return !end || end < new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
}

/**
 * Files one booking into a trip: bookings within two days of an existing trip join it; others
 * start a new one. A cancelled booking is removed. Returns true when the booking is new.
 */
export async function fileBooking(
  tx: TransactionSql,
  userId: string,
  b: FoundBooking,
  messageId: string | null,
): Promise<boolean> {
  const key = dedupeKey(b);
  const { status, ...details } = b;
  // The same booking saved twice at once (parallel tool calls) would otherwise both insert.
  await tx`SELECT pg_advisory_xact_lock(hashtext(${userId + ":" + key}))`;
  const [existing] = await tx<
    { id: string; trip_id: string; details: Record<string, unknown> | null }[]
  >`SELECT id, trip_id, details FROM trip_items WHERE dedupe_key = ${key}`;
  if (status === "cancelled") {
    if (existing) {
      await tx`DELETE FROM trip_items WHERE id = ${existing.id}`;
      await refreshTrip(tx, existing.trip_id);
    }
    return false;
  }
  const start = startOf(b)!;
  const end = endOf(b) ?? start;
  if (existing) {
    // Saved again from chat (the model sometimes saves a flight twice, once with fewer details):
    // keep what was already known, like the booking reference, instead of blanking it.
    const merged = messageId
      ? details
      : {
          ...existing.details,
          ...Object.fromEntries(Object.entries(details).filter(([, v]) => v != null)),
        };
    await tx`UPDATE trip_items SET details = ${tx.json(merged as never)}, item_date = ${start},
               confirmation_ref = ${(merged as { confirmation?: string | null }).confirmation ?? null},
               source_message_id = ${messageId},
               updated_at = now()
             WHERE id = ${existing.id}`;
    await refreshTrip(tx, existing.trip_id);
    return false;
  }
  const [near] = await tx<{ id: string }[]>`
    SELECT id FROM trips
    WHERE starts_on IS NOT NULL
      AND starts_on - 2 <= ${end}::date AND ends_on + 2 >= ${start}::date
    ORDER BY starts_on LIMIT 1`;
  const tripId =
    near?.id ??
    (
      await tx<{ id: string }[]>`
        INSERT INTO trips (user_id, status, starts_on, ends_on)
        VALUES (${userId}, 'booked', ${start}, ${end}) RETURNING id`
    )[0]!.id;
  await tx`
    INSERT INTO trip_items (user_id, trip_id, kind, item_date, details, confirmation_ref,
                            dedupe_key, source, source_message_id)
    VALUES (${userId}, ${tripId}, 'booking', ${start}, ${tx.json(details as never)},
            ${b.confirmation}, ${key}, ${messageId ? "gmail" : "chat"}, ${messageId})`;
  await refreshTrip(tx, tripId);
  return true;
}

/** Recomputes a trip's dates and destination from its bookings (or removes it when empty). */
async function refreshTrip(tx: TransactionSql, tripId: string) {
  const items = await tx<{ details: Booking }[]>`
    SELECT details FROM trip_items WHERE trip_id = ${tripId} AND kind = 'booking'
    ORDER BY item_date, created_at`;
  if (!items.length) {
    await tx`DELETE FROM trips WHERE id = ${tripId}`;
    return;
  }
  const bookings = items.map((i) => i.details);
  const starts = bookings.map(startOf).filter(Boolean) as string[];
  const ends = bookings.map(endOf).filter(Boolean) as string[];
  const destination = destinationOf(bookings);
  await tx`UPDATE trips SET starts_on = ${starts.sort()[0]!}, ends_on = ${ends.sort().at(-1)!},
             destination = ${destination},
             title = ${destination ? `Trip to ${destination}` : "Trip"}
           WHERE id = ${tripId}`;
}

/** Where the trip goes: the first hotel's city, else where the first flight lands. */
export function destinationOf(bookings: Booking[]): string | null {
  for (const b of bookings) if (b.kind === "hotel" && b.city) return b.city;
  for (const b of bookings) if (b.kind === "flight") return b.toCity ?? b.toCode;
  return null;
}

export async function upcomingTrips(sql: Sql, userId: string): Promise<TripView[]> {
  return withUser(sql, userId, async (tx) => {
    const trips = await tx<
      { id: string; title: string | null; starts_on: Date | null; ends_on: Date | null }[]
    >`
      SELECT id, title, starts_on, ends_on FROM trips
      WHERE ends_on >= current_date - 1 ORDER BY starts_on LIMIT 20`;
    if (!trips.length) return [];
    const items = await tx<{ id: string; trip_id: string; details: Booking }[]>`
      SELECT id, trip_id, details FROM trip_items
      WHERE trip_id = ANY(${trips.map((t) => t.id)}) AND kind = 'booking'
      ORDER BY item_date, (details->>'departAt'), created_at`;
    return trips.map((t) => ({
      id: t.id,
      title: t.title ?? "Trip",
      startsOn: t.starts_on ? isoDay(t.starts_on) : null,
      endsOn: t.ends_on ? isoDay(t.ends_on) : null,
      bookings: items.filter((i) => i.trip_id === t.id).map((i) => ({ ...i.details, id: i.id })),
    }));
  });
}

// Postgres dates arrive as local-midnight Dates; read them back the same way.
const isoDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// Telling the person ----------------------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Tue 3 Nov, 10:30" from "2026-11-03T10:30" (the time stays local to the airport). */
export function when(local: string): string {
  const [y, m, d] = local.slice(0, 10).split("-").map(Number) as [number, number, number];
  const day = DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  const time = local.length >= 16 ? `, ${local.slice(11, 16)}` : "";
  return `${day} ${d} ${MONTHS[m - 1]}${time}`;
}

export function describeBooking(b: Booking): string {
  if (b.kind === "flight") {
    const route = [b.fromCity ?? b.fromCode, b.toCity ?? b.toCode].filter(Boolean).join(" to ");
    const name = b.flightNumber
      ? `${b.flightNumber}${b.airline ? ` (${b.airline})` : ""}`
      : (b.airline ?? "Flight");
    return [
      `Flight ${name}`,
      route,
      b.departAt ? `departs ${when(b.departAt)}` : null,
      b.confirmation ? `booking ${b.confirmation}` : null,
    ]
      .filter(Boolean)
      .join(", ");
  }
  return [
    b.name ?? "Hotel",
    b.city,
    b.checkIn ? `${when(b.checkIn)}${b.checkOut ? ` to ${when(b.checkOut)}` : ""}` : null,
    b.confirmation ? `confirmation ${b.confirmation}` : null,
  ]
    .filter(Boolean)
    .join(", ");
}

/** Posts a short note in the Main chat about bookings it just found. */
async function tellMainChat(tx: TransactionSql, userId: string, found: Booking[], first: boolean) {
  const [main] = await tx<{ id: string }[]>`SELECT id FROM chats WHERE kind = 'main'`;
  if (!main) return;
  const sorted = [...found].sort((a, b) => (startOf(a) ?? "").localeCompare(startOf(b) ?? ""));
  const lines = sorted.slice(0, 8).map((b) => `- ${describeBooking(b)}`);
  if (sorted.length > 8) lines.push(`- and ${sorted.length - 8} more`);
  const lead = first
    ? found.length === 1
      ? "I checked your Gmail and found an upcoming booking:"
      : `I checked your Gmail and found ${found.length} upcoming bookings:`
    : found.length === 1
      ? "A new booking just arrived in your Gmail:"
      : `${found.length} new bookings just arrived in your Gmail:`;
  const text = `${lead}\n\n${lines.join("\n")}\n\nI've added ${found.length === 1 ? "it" : "them"} to your trips. You can see them in Settings › Connected accounts.`;
  await tx`INSERT INTO messages (user_id, chat_id, role, parts, origin)
           VALUES (${userId}, ${main.id}, 'assistant',
                   ${tx.json([{ type: "text", text, citations: [] }] as never)}, 'proactive')`;
  await tx`UPDATE chats SET updated_at = now() WHERE id = ${main.id}`;
}

/** The trips as plain text, for the assistant's list_trips tool. */
export function tripsText(trips: TripView[]): string {
  if (!trips.length) return "No upcoming trips found.";
  return trips
    .map((t) =>
      [
        `${t.title} (${t.startsOn ? when(t.startsOn) : "?"} to ${t.endsOn ? when(t.endsOn) : "?"})`,
        ...t.bookings.map((b) => `- ${describeBooking(b)}`),
      ].join("\n"),
    )
    .join("\n\n");
}
