import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Sql } from "@ai-assistant/db";
import { buildApp } from "./app.js";
import {
  cleanBooking,
  dedupeKey,
  fromSchemaOrg,
  type BookingReader,
  type FoundBooking,
} from "./bookings.js";
import { loadConfig } from "./config.js";
import { checkState, describeBooking, signState, when } from "./gmail.js";
import { GoogleAuthError, type Google, type MailMessage } from "./google.js";
import { FakeBrowserUse, FakeSearch, FakeTravila, testDatabase } from "./testkit.js";

/** Travila's connected apps and Gmail, played from memory. */
class FakeGoogle implements Google {
  available = true;
  mail: MailMessage[] = [];
  tokenWorks = true;
  /** Travila user ids that finished the connect page. */
  connected = new Set<string>();
  lastAsker = "";
  disconnected: string[] = [];
  queries: string[] = [];
  email = "traveller@gmail.com";

  async connectUrl(travilaUserId: string, successUrl: string, errorUrl: string) {
    if (!this.available) throw new Error("Pipedream Connect isn't enabled");
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
      listMessages: async (query: string, max: number) => {
        this.queries.push(query);
        // Gmail lists newest first.
        return [...this.mail]
          .sort((a, b) => b.date.getTime() - a.date.getTime())
          .slice(0, max)
          .map((m) => m.id);
      },
      getMessage: async (id: string) => this.mail.find((m) => m.id === id)!,
    };
  }
  async disconnect(travilaUserId: string, accountId: string) {
    this.disconnected.push(accountId);
    this.connected.delete(travilaUserId);
  }
}

/** Bookings keyed by message id, standing in for the model. */
class FakeReader implements BookingReader {
  byMail = new Map<string, FoundBooking[]>();
  reads = 0;
  async read(mail: MailMessage) {
    this.reads++;
    return this.byMail.get(mail.id) ?? [];
  }
}

const future = (days: number, time = "") => {
  const d = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  return time ? `${d}T${time}` : d;
};

const flight = (over: Partial<FoundBooking & { kind: "flight" }> = {}): FoundBooking => ({
  kind: "flight",
  status: "confirmed",
  airline: "ANA",
  flightNumber: "NH 7",
  fromCode: "SFO",
  fromCity: "San Francisco",
  toCode: "NRT",
  toCity: "Tokyo",
  departAt: future(20, "11:05"),
  arriveAt: future(21, "14:30"),
  confirmation: "ABC123",
  ...over,
});

const hotel: FoundBooking = {
  kind: "hotel",
  status: "confirmed",
  name: "Park Hyatt Tokyo",
  city: "Tokyo",
  address: "3-7-1-2 Nishi-Shinjuku",
  checkIn: future(21),
  checkOut: future(25),
  confirmation: "H998877",
};

const mailOf = (id: string, ageMinutes = 10): MailMessage => ({
  id,
  subject: "Your booking confirmation",
  from: "noreply@example.com",
  date: new Date(Date.now() - ageMinutes * 60000),
  html: "",
  text: "Booking confirmation",
});

let sql: Sql | null = null;
let google: FakeGoogle;
let reader: FakeReader;
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
  google = new FakeGoogle();
  reader = new FakeReader();
  pending = [];
  if (sql)
    app = buildApp({
      config,
      sql,
      travila: new FakeTravila(),
      search: new FakeSearch(),
      browser: new FakeBrowserUse(),
      google,
      bookingReader: reader,
      defer: (p) => pending.push(p),
    });
});

let seq = 0;
async function signUp(): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/auth/sign-up",
    payload: {
      email: `gmail${Date.now()}_${++seq}@example.com`,
      password: "long-enough-pw",
      inviteCode: "invite-123",
    },
  });
  expect(res.statusCode).toBe(200);
  return `aia_session=${res.cookies.find((c) => c.name === "aia_session")!.value}`;
}

const settle = async () => {
  while (pending.length) await Promise.all(pending.splice(0));
};

/** Starts connecting, finishes the connect page, and comes back (then waits for the first check). */
async function startConnect(cookie: string) {
  const start = await app.inject({
    method: "GET",
    url: "/connectors/gmail/start",
    headers: { cookie, host: "localhost:3000" },
  });
  expect(start.statusCode).toBe(302);
  const to = new URL(start.headers.location as string);
  expect(to.hostname).toBe("pipedream.com");
  return {
    success: to.searchParams.get("successUrl")!,
    error: to.searchParams.get("errorUrl")!,
  };
}

const backFrom = (url: string, cookie: string) => {
  const u = new URL(url);
  expect(u.origin + u.pathname).toBe("http://localhost:3000/api/connectors/gmail/callback");
  return app.inject({
    method: "GET",
    url: u.pathname.replace(/^\/api/, "") + u.search,
    headers: { cookie, host: "localhost:3000" },
  });
};

async function connect(cookie: string) {
  const links = await startConnect(cookie);
  google.connected.add(google.lastAsker);
  const back = await backFrom(links.success, cookie);
  expect(back.statusCode).toBe(302);
  expect(back.headers.location).toMatch(/\?settings=connections&gmail=connected$/);
  await settle();
}

const status = async (cookie: string) =>
  (await app.inject({ method: "GET", url: "/connectors/gmail", headers: { cookie } })).json();

async function mainMessages(cookie: string) {
  const chats = (await app.inject({ method: "GET", url: "/chats", headers: { cookie } })).json();
  const main = chats.chats.find((c: { kind: string }) => c.kind === "main");
  await settle();
  const chat = await app.inject({ method: "GET", url: `/chats/${main.id}`, headers: { cookie } });
  return chat.json().messages as {
    role: string;
    text: string;
    flight: { flightNumber: string | null } | null;
  }[];
}

describe("booking emails", () => {
  it("reads schema.org flight and hotel bookings", () => {
    const html = `<html><script type="application/ld+json">${JSON.stringify([
      {
        "@context": "http://schema.org",
        "@type": "FlightReservation",
        reservationNumber: "XYZ789",
        reservationFor: {
          "@type": "Flight",
          flightNumber: "123",
          airline: { "@type": "Airline", name: "United", iataCode: "UA" },
          departureAirport: { "@type": "Airport", name: "San Francisco", iataCode: "SFO" },
          arrivalAirport: { "@type": "Airport", name: "Newark", iataCode: "EWR" },
          departureTime: "2026-11-03T08:15:00-08:00",
          arrivalTime: "2026-11-03T16:50:00-05:00",
        },
      },
      {
        "@type": "LodgingReservation",
        reservationNumber: "H1",
        reservationStatus: "http://schema.org/ReservationCancelled",
        reservationFor: { name: "Hotel One", address: { addressLocality: "Newark" } },
        checkinDate: "2026-11-03",
        checkoutDate: "2026-11-05",
      },
    ])}</script></html>`;
    const [f, h] = fromSchemaOrg(html);
    expect(f).toMatchObject({
      kind: "flight",
      flightNumber: "UA 123",
      fromCode: "SFO",
      toCode: "EWR",
      departAt: "2026-11-03T08:15",
      confirmation: "XYZ789",
      status: "confirmed",
    });
    expect(h).toMatchObject({ kind: "hotel", name: "Hotel One", status: "cancelled" });
  });

  it("drops what the model returns when it isn't a usable booking", () => {
    expect(cleanBooking({ kind: "flight", flightNumber: "NH7" })).toBeNull(); // no time
    expect(cleanBooking({ kind: "hotel", checkIn: "soon", name: "X" })).toBeNull();
    expect(cleanBooking({ kind: "car" })).toBeNull();
    const b = cleanBooking({
      kind: "flight",
      flightNumber: "nh 7",
      departAt: "2026-11-03T11:05",
      fromCode: "not-a-code",
      toCity: "x".repeat(500),
    })!;
    expect(b).toMatchObject({ flightNumber: "NH 7", fromCode: null });
    expect((b as { toCity: string }).toCity.length).toBe(60);
    expect(dedupeKey(b)).toBe("flight:nh7:2026-11-03");
  });

  it("describes bookings in plain words, keeping the airport's local time", () => {
    expect(when("2026-11-03T11:05")).toBe("Tue 3 Nov, 11:05");
    expect(describeBooking(flight({ departAt: "2026-11-03T11:05" }))).toBe(
      "Flight NH 7 (ANA), San Francisco to Tokyo, departs Tue 3 Nov, 11:05, booking ABC123",
    );
  });

  it("only accepts a sign-in state made for the same person, before it expires", () => {
    const a = "11111111-1111-4111-8111-111111111111";
    const b = "22222222-2222-4222-8222-222222222222";
    const state = signState(a, "secret");
    expect(checkState(state, a, "secret")).toBe(true);
    expect(checkState(state, b, "secret")).toBe(false);
    expect(checkState(state, a, "other-secret")).toBe(false);
    expect(checkState(state, a, "secret", Date.now() + 16 * 60000)).toBe(false);
    expect(checkState(state.replace(a, b), b, "secret")).toBe(false);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("Gmail connector", () => {
  it("connects, keeps the token only in the vault, and files bookings into one trip", async () => {
    const cookie = await signUp();
    expect((await status(cookie)).connected).toBe(false);
    google.mail = [mailOf("m1", 30), mailOf("m2", 20), mailOf("ad", 10)];
    reader.byMail.set("m1", [flight()]);
    reader.byMail.set("m2", [hotel]);
    await connect(cookie);

    const s = await status(cookie);
    expect(s).toMatchObject({ connected: true, email: "traveller@gmail.com" });
    expect(s.lastCheckedAt).toBeTruthy();
    expect(JSON.stringify(s)).not.toContain("SECRET");
    expect(s.trips).toHaveLength(1);
    expect(s.trips[0].title).toBe("Trip to Tokyo");
    expect(s.trips[0].bookings.map((b: { kind: string }) => b.kind)).toEqual(["flight", "hotel"]);
    expect(google.queries[0]).toContain("newer_than:180d");

    // The token is sealed in the vault: nothing in the app's own tables holds it.
    const [plain] = await sql!`
      SELECT count(*)::int AS n FROM connector_accounts WHERE row_to_json(connector_accounts)::text LIKE '%SECRET%'`;
    expect(plain!.n).toBe(0);
    const [sealed] = await sql!`
      SELECT count(*)::int AS n FROM vault.connected_accounts WHERE position('SECRET'::bytea IN sealed) > 0`;
    expect(sealed!.n).toBe(0);
    await expect(
      sql!.begin(async (tx) => {
        await tx`SET LOCAL ROLE app_user`;
        await tx`SELECT * FROM vault.connected_accounts`;
      }),
    ).rejects.toThrow(/permission denied/);

    // The Main chat gets one note about what was found, then the flight's trip card.
    const said = (await mainMessages(cookie)).filter((m) => m.role === "assistant");
    const notes = said.filter((m) => !m.flight);
    expect(notes).toHaveLength(1);
    expect(said.filter((m) => m.flight?.flightNumber === "NH 7")).toHaveLength(1);
    expect(notes[0]!.text).toContain("found 2 upcoming bookings");
    expect(notes[0]!.text).toContain("Park Hyatt Tokyo");
  });

  it("reads each email once, updates changed bookings and removes cancelled ones", async () => {
    const cookie = await signUp();
    google.mail = [mailOf("a1", 60)];
    reader.byMail.set("a1", [flight(), hotel]);
    await connect(cookie);
    expect(reader.reads).toBe(1);

    // Not due again yet: opening the app doesn't re-check.
    await mainMessages(cookie);
    expect(google.queries).toHaveLength(1);

    // Later: a time change for the flight and a hotel cancellation arrive.
    await sql!`UPDATE connector_accounts SET last_synced_at = now() - interval '1 hour'
               WHERE account_email = 'traveller@gmail.com'`;
    google.mail.push(mailOf("a2", 5));
    reader.byMail.set("a2", [
      flight({ departAt: future(20, "13:40") }),
      { ...hotel, status: "cancelled" },
    ]);
    const before = (await mainMessages(cookie)).length;
    await settle();
    expect(reader.reads).toBe(2); // a1 isn't read again
    expect(google.queries[1]).toMatch(/after:\d+/);
    const s = await status(cookie);
    expect(s.trips).toHaveLength(1);
    expect(s.trips[0].bookings).toHaveLength(1);
    expect(s.trips[0].bookings[0].departAt).toBe(future(20, "13:40"));
    expect(s.trips[0].title).toBe("Trip to Tokyo");
    // Changes aren't announced as new bookings.
    expect((await mainMessages(cookie)).length).toBe(before);
  });

  it("asks to reconnect when the connection stops working, and disconnecting removes it", async () => {
    const cookie = await signUp();
    await connect(cookie);
    google.tokenWorks = false;
    await sql!`UPDATE connector_accounts SET last_synced_at = now() - interval '1 hour'
               WHERE account_email = 'traveller@gmail.com' AND status = 'connected'`;
    await mainMessages(cookie);
    await settle();
    const s = await status(cookie);
    expect(s).toMatchObject({ connected: false, needsReconnect: true });

    const res = await app.inject({
      method: "DELETE",
      url: "/connectors/gmail",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(google.disconnected).toHaveLength(1);
    expect(await status(cookie)).toMatchObject({ connected: false, needsReconnect: false });
  });

  it("refuses a connection meant for someone else, and keeps trips private", async () => {
    const alice = await signUp();
    const bob = await signUp();
    google.mail = [mailOf("b1")];
    reader.byMail.set("b1", [flight()]);
    await connect(alice);

    // Bob's browser lands on Alice's way back from the connect page: refused.
    const links = await startConnect(alice);
    const back = await backFrom(links.success, bob);
    expect(back.headers.location).toMatch(/gmail=failed$/);
    const b = await status(bob);
    expect(b.connected).toBe(false);
    expect(b.trips).toHaveLength(0);
    expect((await status(alice)).trips).toHaveLength(1);
  });

  it("says when connecting was cancelled, didn't connect, or isn't available", async () => {
    const cookie = await signUp();
    const links = await startConnect(cookie);
    expect((await backFrom(links.error, cookie)).headers.location).toMatch(/gmail=cancelled$/);
    // Sent back as if it worked, but no account was connected.
    expect((await backFrom(links.success, cookie)).headers.location).toMatch(/gmail=cancelled$/);
    expect((await status(cookie)).connected).toBe(false);
    google.available = false;
    const start = await app.inject({
      method: "GET",
      url: "/connectors/gmail/start",
      headers: { cookie },
    });
    expect(start.headers.location).toMatch(/gmail=unavailable$/);
    const signedOut = await app.inject({ method: "GET", url: "/connectors/gmail/start" });
    expect(signedOut.headers.location).toBe("/sign-in");
  });
});
