import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withUser, type Sql } from "@ai-assistant/db";
import { buildApp } from "./app.js";
import type { BookingReader, FoundBooking } from "./bookings.js";
import { flightFromText, flightsInEvent, looksLikeFlight } from "./calendar.js";
import { loadConfig } from "./config.js";
import { fileBooking } from "./gmail.js";
import {
  GoogleAuthError,
  type CalendarEvent,
  type GoogleCalendar,
  type MailMessage,
} from "./google.js";
import { FakeBrowserUse, FakeSearch, FakeTravila, testDatabase } from "./testkit.js";

/** Travila's connected apps and Google Calendar, played from memory. */
class FakeCalendar implements GoogleCalendar {
  events: CalendarEvent[] = [];
  tokenWorks = true;
  connected = new Set<string>();
  lastAsker = "";
  disconnected: string[] = [];
  lists = 0;
  email = "traveller@gmail.com";

  async connectUrl(travilaUserId: string, successUrl: string, errorUrl: string) {
    this.lastAsker = travilaUserId;
    return `https://pipedream.com/_static/connect.html?${new URLSearchParams({ successUrl, errorUrl })}`;
  }
  async connectedAccount(travilaUserId: string) {
    return this.connected.has(travilaUserId)
      ? { accountId: `apn_SECRET_${travilaUserId.slice(-6)}`, email: this.email }
      : null;
  }
  async open(travilaUserId: string, accountId: string) {
    if (!this.tokenWorks || !this.connected.has(travilaUserId) || !accountId.startsWith("apn_")) {
      throw new GoogleAuthError("gone");
    }
    return {
      events: async (from: Date, to: Date, max: number) => {
        this.lists++;
        return this.events
          .filter((e) => {
            const at = Date.parse(e.start.dateTime ?? e.start.date ?? "");
            return at >= from.getTime() && at <= to.getTime();
          })
          .slice(0, max);
      },
    };
  }
  async disconnect(travilaUserId: string, accountId: string) {
    this.disconnected.push(accountId);
    this.connected.delete(travilaUserId);
  }
}

/** Bookings keyed by event, standing in for the model. */
class FakeReader implements BookingReader {
  byMail = new Map<string, FoundBooking[]>();
  reads: string[] = [];
  async read(mail: MailMessage) {
    this.reads.push(mail.id);
    return this.byMail.get(mail.id) ?? [];
  }
}

/** A day this many days ahead, "2026-11-03". */
const day = (days: number) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

const event = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: "ev1",
  updated: "2026-10-01T00:00:00.000Z",
  summary: "UA 123 SFO → EWR",
  description: "Confirmation: XYZ789",
  location: "San Francisco International Airport",
  // In winter, San Francisco is 8 hours behind UTC and Newark 5.
  start: { dateTime: `${day(40)}T16:15:00Z`, timeZone: "America/Los_Angeles" },
  end: { dateTime: `${day(40)}T21:50:00Z`, timeZone: "America/New_York" },
  ...over,
});

describe("calendar events", () => {
  it("only looks at timed events with a flight number and a route or the word flight", () => {
    expect(looksLikeFlight(event())).toBe(true);
    expect(looksLikeFlight(event({ summary: "Flight to Paris (AF 1234)", description: "" }))).toBe(
      true,
    );
    expect(looksLikeFlight(event({ summary: "Dinner with Sam", description: "" }))).toBe(false);
    expect(looksLikeFlight(event({ summary: "Flight lesson", description: "" }))).toBe(false);
    // All day: no departure time to check in by.
    expect(looksLikeFlight(event({ start: { date: day(40) }, end: { date: day(41) } }))).toBe(
      false,
    );
  });

  it("reads a plain flight event directly, in each airport's local time", () => {
    expect(flightFromText(event())).toMatchObject({
      kind: "flight",
      flightNumber: "UA 123",
      fromCode: "SFO",
      toCode: "EWR",
      departAt: `${day(40)}T08:15`,
      arriveAt: `${day(40)}T16:50`,
      confirmation: "XYZ789",
    });
    // A number in the notes isn't taken for the flight; a made-up airport isn't a route.
    expect(flightFromText(event({ summary: "Trip SFO-EWR", description: "Gate B12" }))).toBeNull();
    expect(flightFromText(event({ summary: "UA 123 ABC-XYZ" }))).toBeNull();
    // Without a booking reference it's still a flight; the trip card asks for it.
    expect(flightFromText(event({ description: "" }))).toMatchObject({ confirmation: null });
  });

  it("asks the model about other events, keeping only a flight that's in the event", async () => {
    const reader = new FakeReader();
    const gmailMade = event({
      id: "ev2",
      summary: "Flight to Paris (AF 1234)",
      location: "",
      description: "Air France flight 1234 from New York",
    });
    reader.byMail.set("calendar:ev2", [
      {
        kind: "flight",
        status: "confirmed",
        airline: "Air France",
        flightNumber: "AF 1234",
        fromCode: "JFK",
        fromCity: "New York",
        toCode: "CDG",
        toCity: "Paris",
        departAt: `${day(40)}T00:00`,
        arriveAt: null,
        confirmation: null,
      },
    ]);
    const [f] = await flightsInEvent(gmailMade, reader);
    // The event's own times, at each airport (16:15 UTC is 11:15 in New York, 17:15 in Paris).
    expect(f).toMatchObject({
      flightNumber: "AF 1234",
      departAt: `${day(40)}T11:15`,
      arriveAt: `${day(40)}T22:50`,
    });

    reader.byMail.set("calendar:ev3", [{ ...f!, flightNumber: "DL 8" }]);
    expect(await flightsInEvent({ ...gmailMade, id: "ev3" }, reader)).toEqual([]);
  });
});

let sql: Sql | null = null;
let calendar: FakeCalendar;
let reader: FakeReader;
let travila: FakeTravila;
let pending: Promise<unknown>[] = [];
let app: ReturnType<typeof buildApp>;
const config = { ...loadConfig({}), signupCode: "invite-123" };

beforeAll(async () => {
  sql = await testDatabase();
});
afterAll(async () => {
  await sql?.end();
});
beforeEach(() => {
  calendar = new FakeCalendar();
  reader = new FakeReader();
  travila = new FakeTravila();
  pending = [];
  if (sql)
    app = buildApp({
      config,
      sql,
      travila,
      search: new FakeSearch(),
      browser: new FakeBrowserUse(),
      calendar,
      bookingReader: reader,
      defer: (p) => pending.push(p),
    });
});

let seq = 0;
async function signUp(): Promise<{ cookie: string; userId: string }> {
  const email = `calendar${Date.now()}_${++seq}@example.com`;
  const res = await app.inject({
    method: "POST",
    url: "/auth/sign-up",
    payload: { email, password: "long-enough-pw", inviteCode: "invite-123" },
  });
  expect(res.statusCode).toBe(200);
  const [u] = await sql!<{ id: string }[]>`SELECT id FROM users WHERE email = ${email}`;
  return {
    cookie: `aia_session=${res.cookies.find((c) => c.name === "aia_session")!.value}`,
    userId: u!.id,
  };
}

const settle = async () => {
  while (pending.length) await Promise.all(pending.splice(0));
};

/** Connects Google Calendar the way the Settings button does, then waits for the first check. */
async function connect(cookie: string) {
  const start = await app.inject({
    method: "GET",
    url: "/connectors/calendar/start",
    headers: { cookie, host: "localhost:3000" },
  });
  expect(start.statusCode).toBe(302);
  const to = new URL(start.headers.location as string);
  expect(to.hostname).toBe("pipedream.com");
  calendar.connected.add(calendar.lastAsker);
  const back = new URL(to.searchParams.get("successUrl")!);
  expect(back.pathname).toBe("/api/connectors/calendar/callback");
  const res = await app.inject({
    method: "GET",
    url: back.pathname.replace(/^\/api/, "") + back.search,
    headers: { cookie, host: "localhost:3000" },
  });
  expect(res.headers.location).toMatch(/\?settings=connections&calendar=connected$/);
  await settle();
}

const status = async (cookie: string) =>
  (await app.inject({ method: "GET", url: "/connectors/gmail", headers: { cookie } })).json();
const flights = async (cookie: string) =>
  (await app.inject({ method: "GET", url: "/flights", headers: { cookie } })).json().flights as {
    id: string;
    flightNumber: string | null;
    confirmation: string | null;
    departLocal: string | null;
    prep: { required: string[] };
  }[];

async function mainNotes(cookie: string) {
  const chats = (await app.inject({ method: "GET", url: "/chats", headers: { cookie } })).json();
  const main = chats.chats.find((c: { kind: string }) => c.kind === "main");
  await settle();
  const chat = await app.inject({ method: "GET", url: `/chats/${main.id}`, headers: { cookie } });
  return (chat.json().messages as { role: string; text: string; flight: unknown }[]).filter(
    (m) => m.role === "assistant" && !m.flight,
  );
}

describe.skipIf(!process.env.DATABASE_URL)("Google Calendar connector", () => {
  it("connects, keeps the token in the vault, and turns a flight event into a trip card", async () => {
    const { cookie } = await signUp();
    expect((await status(cookie)).calendar).toMatchObject({ connected: false });
    calendar.events = [event(), event({ id: "lunch", summary: "Lunch with Sam", description: "" })];
    await connect(cookie);

    expect((await status(cookie)).calendar).toEqual({
      connected: true,
      needsReconnect: false,
      email: "traveller@gmail.com",
    });
    const [plain] = await sql!`
      SELECT count(*)::int AS n FROM connector_accounts
      WHERE row_to_json(connector_accounts)::text LIKE '%SECRET%'`;
    expect(plain!.n).toBe(0);

    const [f, ...more] = await flights(cookie);
    expect(more).toHaveLength(0);
    expect(f).toMatchObject({
      flightNumber: "UA 123",
      confirmation: "XYZ789",
      departLocal: `${day(40)}T08:15`,
    });
    expect(f!.prep.required).not.toContain("bookingRef");
    // Read directly: nothing went to the model, and lunch wasn't looked at.
    expect(reader.reads).toEqual([]);
    const notes = await mainNotes(cookie);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.text).toContain("I found a flight in your Google Calendar");
  });

  it("matches a flight already saved by route and time, filling gaps without moving it", async () => {
    const { cookie, userId } = await signUp();
    // From an email: the airline's own time and booking reference.
    await withUser(sql!, userId, (tx) =>
      fileBooking(
        tx,
        userId,
        {
          kind: "flight",
          status: "confirmed",
          airline: "United",
          flightNumber: "UA 123",
          fromCode: "SFO",
          fromCity: "San Francisco",
          toCode: "EWR",
          toCity: "Newark",
          departAt: `${day(40)}T08:15`,
          arriveAt: null,
          confirmation: "ABC123",
        },
        "m1",
      ),
    );
    calendar.events = [
      // Gmail's own event for it: same route and time, with the arrival time the email lacked.
      event({ description: "" }),
      // One they typed themselves, ten minutes off, under a codeshare number.
      event({
        id: "typed",
        summary: "LH 7601 SFO-EWR",
        description: "",
        start: { dateTime: `${day(40)}T16:25:00Z` },
      }),
    ];
    await connect(cookie);

    const all = await flights(cookie);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      flightNumber: "UA 123",
      confirmation: "ABC123",
      departLocal: `${day(40)}T08:15`,
    });
    const [item] = await sql!<{ source: string; details: { arriveAt: string } }[]>`
      SELECT source, details FROM trip_items WHERE user_id = ${userId}`;
    expect(item).toMatchObject({ source: "gmail", details: { arriveAt: `${day(40)}T16:50` } });
    // Nothing new, so no note about it.
    expect(await mainNotes(cookie)).toHaveLength(0);
  });

  it("asks for a missing booking reference once, on the trip card", async () => {
    const { cookie } = await signUp();
    calendar.events = [event({ description: "" })];
    await connect(cookie);
    const [f] = await flights(cookie);
    expect(f!.confirmation).toBeNull();
    expect(f!.prep.required[0]).toBe("bookingRef");

    const prep = (payload: Record<string, unknown>) =>
      app.inject({ method: "POST", url: `/flights/${f!.id}/prep`, headers: { cookie }, payload });
    expect((await prep({ bookingRef: "no!" })).statusCode).toBe(400);
    const saved = await prep({ bookingRef: "xyz 789" });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().flight).toMatchObject({ confirmation: "XYZ789" });
    expect(saved.json().flight.prep.required).not.toContain("bookingRef");

    // Reading the calendar again doesn't blank it.
    calendar.events = [event({ description: "", updated: "2026-10-02T00:00:00.000Z" })];
    await sql!`UPDATE connector_accounts SET last_synced_at = now() - interval '1 hour'
               WHERE provider = 'google_calendar'`;
    await app.inject({ method: "GET", url: "/chats", headers: { cookie } });
    await settle();
    expect((await flights(cookie))[0]).toMatchObject({ confirmation: "XYZ789" });
  });

  it("reads each event once, and again when it changes", async () => {
    const { cookie } = await signUp();
    const gmailMade = event({
      id: "ev2",
      summary: "Flight to Tokyo (NH 7)",
      location: "",
      description: "",
    });
    reader.byMail.set("calendar:ev2", [
      {
        kind: "flight",
        status: "confirmed",
        airline: "ANA",
        flightNumber: "NH 7",
        fromCode: "SFO",
        fromCity: "San Francisco",
        toCode: "NRT",
        toCity: "Tokyo",
        departAt: null,
        arriveAt: null,
        confirmation: null,
      },
    ]);
    calendar.events = [gmailMade];
    await connect(cookie);
    expect(reader.reads).toEqual(["calendar:ev2"]);

    const recheck = async () => {
      await sql!`UPDATE connector_accounts SET last_synced_at = now() - interval '1 hour'
                 WHERE provider = 'google_calendar'`;
      await app.inject({ method: "GET", url: "/chats", headers: { cookie } });
      await settle();
    };
    await recheck();
    expect(reader.reads).toHaveLength(1);
    expect(calendar.lists).toBe(2);

    // Moved an hour later in the calendar: read again, and the flight moves with it.
    calendar.events = [
      {
        ...gmailMade,
        updated: "2026-10-05T00:00:00.000Z",
        start: { dateTime: `${day(40)}T17:15:00Z` },
      },
    ];
    await recheck();
    expect(reader.reads).toHaveLength(2);
    const all = await flights(cookie);
    expect(all).toHaveLength(1);
    expect(all[0]!.departLocal).toBe(`${day(40)}T09:15`);
  });

  it("checks the calendar before listing trips", async () => {
    const { cookie } = await signUp();
    await connect(cookie);
    calendar.events = [event()];
    const chats = (await app.inject({ method: "GET", url: "/chats", headers: { cookie } })).json();
    const main = chats.chats.find((c: { kind: string }) => c.kind === "main").id;
    await settle();

    travila.scripts.push([
      { tools: [{ name: "list_trips", args: {} }] },
      { answer: "Your flight to Newark is booked." },
    ]);
    const sent = await app.inject({
      method: "POST",
      url: `/chats/${main}/messages`,
      headers: { cookie },
      payload: { text: "Check me in for my flight", clientMessageId: crypto.randomUUID() },
    });
    for (let i = 0; i < 20; i++) {
      const run = (
        await app.inject({ method: "GET", url: `/runs/${sent.json().run.id}`, headers: { cookie } })
      ).json().run;
      await settle();
      if (["completed", "failed", "cancelled"].includes(run.status)) break;
    }
    expect(JSON.stringify(travila.submitted.at(-1)!.results)).toContain("UA 123");
  });

  it("asks to reconnect when it stops working, and disconnecting removes it", async () => {
    const { cookie } = await signUp();
    await connect(cookie);
    calendar.tokenWorks = false;
    await sql!`UPDATE connector_accounts SET last_synced_at = NULL
               WHERE provider = 'google_calendar'`;
    await app.inject({ method: "GET", url: "/chats", headers: { cookie } });
    await settle();
    expect((await status(cookie)).calendar).toMatchObject({
      connected: false,
      needsReconnect: true,
    });

    const res = await app.inject({
      method: "DELETE",
      url: "/connectors/calendar",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(calendar.disconnected).toHaveLength(1);
    expect((await status(cookie)).calendar).toMatchObject({
      connected: false,
      needsReconnect: false,
    });
  });
});
