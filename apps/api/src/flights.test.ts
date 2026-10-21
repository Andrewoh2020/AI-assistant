import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withUser, type Sql } from "@ai-assistant/db";
import type { FlightView } from "@ai-assistant/api-client";
import { airport, instantToLocal, localToInstant } from "./airports.js";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import type { FlightStatusSource, LiveFlight, RouteSource } from "./flightdata.js";
import { factsFor, pickMode, planFlights, readMarker, tickAll } from "./flights.js";
import { fileBooking } from "./gmail.js";
import { FakeBrowserUse, FakeSearch, FakeTravila, testDatabase } from "./testkit.js";
import { bookingFrom } from "./tools.js";
import { checkPrep, EMPTY_PROFILE, needsFor } from "./travel.js";
import { toLive } from "./flightdata.js";

describe("airport times", () => {
  it("turns airport-local times into real moments and back", () => {
    // San Francisco is UTC-7 in summer and UTC-8 in winter; Singapore is always UTC+8.
    expect(localToInstant("2026-07-01T08:00", "SFO")!.toISOString()).toBe(
      "2026-07-01T15:00:00.000Z",
    );
    expect(localToInstant("2026-12-01T08:00", "SFO")!.toISOString()).toBe(
      "2026-12-01T16:00:00.000Z",
    );
    expect(localToInstant("2026-12-01T08:00", "SIN")!.toISOString()).toBe(
      "2026-12-01T00:00:00.000Z",
    );
    expect(instantToLocal(new Date("2026-12-01T00:00:00Z"), "SIN")).toBe("2026-12-01T08:00");
    expect(localToInstant("2026-12-01T08:00", "ZZZ")).toBeNull();
    expect(airport("sin")).toMatchObject({ country: "SG", tz: "Asia/Singapore" });
  });
});

const sfoSin = {
  kind: "flight" as const,
  airline: "United",
  flightNumber: "UA 1",
  fromCode: "SFO",
  fromCity: "San Francisco",
  toCode: "SIN",
  toCity: "Singapore",
  departAt: "2026-11-03T22:40",
  arriveAt: "2026-11-05T06:30",
  confirmation: "ABC123",
};

describe("what a flight needs", () => {
  it("asks only for what is missing, and passports only when flying abroad", () => {
    const p = { user_id: "u", ...EMPTY_PROFILE };
    const abroad = needsFor(p, factsFor(sfoSin));
    expect(abroad.required).toEqual([
      "name",
      "dateOfBirth",
      "gender",
      "nationality",
      "passportNumber",
      "passportExpiry",
    ]);
    expect(abroad.optional).toContain("knownTraveler");
    expect(abroad.optional).toContain("frequentFlyer");
    const home = needsFor(p, factsFor({ ...sfoSin, toCode: "JFK", toCity: "New York" }));
    expect(home.required).toEqual(["name", "dateOfBirth", "gender"]);

    const known = {
      ...p,
      first_name: "Ann",
      last_name: "Lee",
      date_of_birth: new Date(1990, 3, 12),
      gender: "female" as const,
      nationality: "US",
      passport_expiry: new Date(2027, 0, 10),
      saved_documents: ["passport"],
      no_known_traveler: true,
      no_frequent_flyer: ["UA"],
      seat_side: "window" as const,
      seat_zone: "front" as const,
      seat_empty_nearby: true,
      seat_avoid_washroom: true,
      home_address: "1 Main St",
    };
    const ready = needsFor(known, factsFor(sfoSin));
    expect(ready.required).toEqual([]);
    expect(ready.optional).toEqual([]);
    // Singapore needs 6 months on the passport after arrival; January is too soon.
    expect(ready.warnings[0]).toMatch(
      /Singapore needs your passport to be valid for at least 6 months/,
    );
  });

  it("turns down answers that can't be right", () => {
    expect(() => checkPrep({ dateOfBirth: "2030-01-01" }, "2026-10-21")).toThrow(/date of birth/);
    expect(() => checkPrep({ passportExpiry: "2025-01-01" }, "2026-10-21")).toThrow(/expired/);
    expect(() => checkPrep({ passportNumber: "12" }, "2026-10-21")).toThrow(/passport number/);
    expect(() => checkPrep({ firstName: "<script>" }, "2026-10-21")).toThrow(/first name/);
    expect(() =>
      checkPrep(
        { firstName: "Zoë", lastName: "O'Brien-Smith", passportNumber: "X1234567" },
        "2026-10-21",
      ),
    ).not.toThrow();
  });

  it("checks bookings given in chat", () => {
    expect(
      bookingFrom({
        kind: "flight",
        flight_number: "ua123",
        from_code: "sfo",
        to_code: "sin",
        depart_at: "2026-11-03T22:40",
      }),
    ).toMatchObject({
      flightNumber: "UA 123",
      fromCode: "SFO",
      toCode: "SIN",
      toCity: "Singapore",
    });
    expect(
      bookingFrom({
        kind: "flight",
        from_code: "XXX",
        to_code: "SIN",
        depart_at: "2026-11-03T22:40",
      }),
    ).toEqual({
      error: expect.stringMatching(/airport codes/),
    });
    expect(bookingFrom({ kind: "hotel", check_in: "soon" })).toEqual({
      error: expect.stringMatching(/dates/),
    });
  });

  it("reads the browser's answer only from the start of a line", () => {
    expect(readMarker('CHECKED_IN {"seat":"14A"}')).toEqual({
      marker: "CHECKED_IN",
      rest: '{"seat":"14A"}',
    });
    expect(readMarker("Done.\nNEEDS_INFO: What is your emergency contact?")?.marker).toBe(
      "NEEDS_INFO",
    );
    expect(readMarker("The page said you are CHECKED_IN already")).toBeNull();
  });

  it("picks the train unless the car is clearly faster", () => {
    expect(pickMode({ mode: "car", minutes: 40 }, { mode: "train", minutes: 45 })?.mode).toBe(
      "train",
    );
    expect(pickMode({ mode: "car", minutes: 30 }, { mode: "train", minutes: 55 })?.mode).toBe(
      "car",
    );
    expect(pickMode(null, { mode: "train", minutes: 55 })?.mode).toBe("train");
  });

  it("reads FlightAware's flight", () => {
    const live = toLive({
      status: "Scheduled / Delayed",
      departure_delay: 2700,
      scheduled_out: "2026-11-04T06:40:00Z",
      estimated_out: "2026-11-04T07:25:00Z",
      gate_origin: "G92",
      terminal_origin: "I",
    });
    expect(live).toMatchObject({ delayMinutes: 45, gate: "G92", terminal: "I", departed: false });
    expect(live.departAt).toBe("2026-11-04T07:25:00Z");
  });
});

// The whole flight, with a clock we move by hand ----------------------------------------------

class FakeStatus implements FlightStatusSource {
  available = true;
  live: LiveFlight | null = null;
  asks = 0;
  async find() {
    this.asks++;
    return this.live;
  }
}

class FakeRoutes implements RouteSource {
  available = true;
  minutes = { car: 50, train: 40 };
  async travel(mode: "car" | "train") {
    return { mode, minutes: this.minutes[mode] };
  }
}

let sql: Sql | null = null;
let browser: FakeBrowserUse;
let status: FakeStatus;
let routes: FakeRoutes;
let now: Date;
let pending: Promise<unknown>[] = [];
let app: ReturnType<typeof buildApp>;
const config = { ...loadConfig({}), signupCode: "invite-123", cronSecret: "cron-secret-1" };

beforeAll(async () => {
  sql = await testDatabase();
});
afterAll(async () => {
  await sql?.end();
});
beforeEach(async () => {
  // The scheduler looks at everyone's flights: start each test with none.
  if (sql) await sql`DELETE FROM flight_plans`;
  browser = new FakeBrowserUse();
  status = new FakeStatus();
  routes = new FakeRoutes();
  now = new Date();
  pending = [];
  if (sql)
    app = buildApp({
      config,
      sql,
      travila: new FakeTravila(),
      search: new FakeSearch(),
      browser,
      flightStatus: status,
      routes,
      now: () => now,
      browserCheckGapMs: 0,
      defer: (p) => pending.push(p),
    });
});

const settle = async () => {
  while (pending.length) await Promise.all(pending.splice(0));
};

let seq = 0;
async function signUp(): Promise<{ cookie: string; userId: string }> {
  const email = `flights${Date.now()}_${++seq}@example.com`;
  const res = await app.inject({
    method: "POST",
    url: "/auth/sign-up",
    payload: { email, password: "long-enough-pw", inviteCode: "invite-123" },
  });
  expect(res.statusCode).toBe(200);
  const cookie = `aia_session=${res.cookies.find((c) => c.name === "aia_session")!.value}`;
  // Makes the Main chat.
  await app.inject({ method: "GET", url: "/chats", headers: { cookie } });
  await settle();
  const [u] = await sql!<{ id: string }[]>`SELECT id FROM users WHERE email = ${email}`;
  return { cookie, userId: u!.id };
}

const local = (at: Date, code: string) => instantToLocal(at, code)!;
const H = 3600000;

/** A flight from San Francisco to Singapore leaving in `hours`, with a hotel there. */
async function bookTrip(userId: string, hours: number) {
  const depart = new Date(now.getTime() + hours * H);
  const arrive = new Date(depart.getTime() + 17 * H);
  const arriveDay = local(arrive, "SIN").slice(0, 10);
  await withUser(sql!, userId, async (tx) => {
    await fileBooking(
      tx,
      userId,
      {
        ...sfoSin,
        status: "confirmed",
        departAt: local(depart, "SFO"),
        arriveAt: local(arrive, "SIN"),
      },
      null,
    );
    await fileBooking(
      tx,
      userId,
      {
        kind: "hotel",
        status: "confirmed",
        name: "Marina Bay Sands",
        city: "Singapore",
        address: "10 Bayfront Ave",
        checkIn: arriveDay,
        checkOut: arriveDay.slice(0, 8) + String(Number(arriveDay.slice(8)) + 1).padStart(2, "0"),
        confirmation: "MBS1",
      },
      null,
    );
  });
  await planFlights({ sql: sql!, now: () => now }, userId);
  return depart;
}

async function flights(cookie: string): Promise<FlightView[]> {
  const res = await app.inject({ method: "GET", url: "/flights", headers: { cookie } });
  expect(res.statusCode).toBe(200);
  return res.json().flights;
}

async function mainTexts(cookie: string): Promise<string[]> {
  const chats = (await app.inject({ method: "GET", url: "/chats", headers: { cookie } })).json();
  const main = chats.chats.find((c: { kind: string }) => c.kind === "main");
  const chat = await app.inject({ method: "GET", url: `/chats/${main.id}`, headers: { cookie } });
  return chat.json().messages.map((m: { text: string }) => m.text);
}

/** Runs the scheduler a few times, a minute apart, so browser work can finish. */
async function ticks(n = 3) {
  for (let i = 0; i < n; i++) await tick();
}

/** Runs the scheduler the way the cron does, a minute later each time. */
async function tick() {
  now = new Date(now.getTime() + 60000);
  const res = await app.inject({
    method: "GET",
    url: "/cron/flights",
    headers: { authorization: "Bearer cron-secret-1" },
  });
  expect(res.statusCode).toBe(200);
  await settle();
}

const prep = {
  firstName: "Ann",
  lastName: "Lee",
  dateOfBirth: "1990-04-12",
  gender: "female",
  nationality: "US",
  passportNumber: "X1234567",
  passportExpiry: "2031-01-10",
  knownTravelerNumber: null,
  frequentFlyerNumber: null,
  seatSide: "window",
  seatZone: "front",
  seatEmptyNearby: true,
  seatAvoidWashroom: true,
  homeAddress: "1 Market St, San Francisco",
  noBannedItems: true,
};

describe.skipIf(!process.env.DATABASE_URL)("a flight from booking to landing", () => {
  it("asks once, checks in by itself, files the arrival card and says when to leave", async () => {
    const { cookie, userId } = await signUp();
    const depart = await bookTrip(userId, 72);

    // 1. The trip card is in the Main chat and asks only for what's missing.
    const texts = await mainTexts(cookie);
    expect(
      texts.some((t) => t.includes("UA 1 to Singapore") && t.includes("check you in by myself")),
    ).toBe(true);
    let [f] = await flights(cookie);
    expect(f!.prep.required).toContain("passportNumber");
    expect(f!.checkin.status).toBe("scheduled");
    expect(f!.arrival).toMatchObject({
      form: "Singapore arrival card",
      stay: "Marina Bay Sands, 10 Bayfront Ave",
    });

    // 2. One answer. The passport number goes to the vault, never back out.
    const saved = await app.inject({
      method: "POST",
      url: `/flights/${f!.id}/prep`,
      headers: { cookie },
      payload: prep,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain("X1234567");
    f = saved.json().flight;
    expect(f!.prep.required).toEqual([]);
    expect(f!.prep.noBannedItems).toBe(true);
    await settle();
    const [row] = await sql!`SELECT * FROM travel_profiles WHERE user_id = ${userId}`;
    expect(JSON.stringify(row)).not.toContain("X1234567");
    const [doc] = await sql!`SELECT sealed FROM vault.travel_documents WHERE user_id = ${userId}`;
    expect(Buffer.from(doc!.sealed).toString("latin1")).not.toContain("X1234567");

    // Nothing happens before check-in opens.
    await tick();
    expect(browser.runs.size).toBe(0);

    // 3. Check-in opens (24 hours before): the browser checks in on united.com by itself.
    now = new Date(depart.getTime() - 24 * H + 60000);
    browser.scripts.push({
      polls: 1,
      result:
        'CHECKED_IN {"flight":"UA1","date":"' +
        local(depart, "SFO").slice(0, 10) +
        '","lastName":"LEE","seat":"12A","group":"2","skipped":["Economy Plus $129"]}',
      outputs: [{ name: "boarding-pass.pdf", data: "%PDF-1.4 boarding pass" }],
    });
    await tick();
    expect(browser.runs.size).toBe(1);
    const [run] = [...browser.runs.values()];
    expect(run!.input.task).toContain("UA 1");
    expect(run!.input.task).toContain("Start at: https://www.united.com/");
    expect(run!.input.task).toContain("Only ever choose a seat that costs nothing");
    expect(run!.input.task).not.toContain("X1234567");
    expect(run!.input.secrets).toEqual([
      { alias: "passport_number", value: "X1234567", allowedDomains: ["united.com"] },
    ]);
    // The arrival card waits for the person's OK on the health and customs answers.
    [f] = await flights(cookie);
    expect(f!.checkin.status).toBe("running");
    expect(f!.checkin.browser).not.toBeNull();
    expect(f!.arrival!.status).toBe("ready");

    // 4. The browser finishes: boarding pass on the card, one message.
    await ticks();
    [f] = await flights(cookie);
    expect(f!.checkin).toMatchObject({ status: "done", seat: "12A", group: "2", mismatch: null });
    expect(f!.checkin.boardingPass?.name).toBe("boarding-pass.pdf");
    const after = await mainTexts(cookie);
    expect(
      after.some((t) => t.startsWith("You're checked in for UA 1, seat 12A, boarding group 2.")),
    ).toBe(true);
    expect(after.some((t) => t.includes("Looks right, submit"))).toBe(true);

    // 5. The person taps OK; the arrival card is filed on the official site.
    browser.scripts.push({
      result: 'SUBMITTED {"reference":"SGAC-778"}',
      outputs: [{ name: "arrival-card.pdf", data: "%PDF-1.4 arrival" }],
    });
    const ok = await app.inject({
      method: "PATCH",
      url: `/flights/${f!.id}`,
      headers: { cookie },
      payload: { arrivalConfirmed: true },
    });
    expect(ok.statusCode).toBe(200);
    await settle();
    const arrivalRun = [...browser.runs.values()][1]!;
    expect(arrivalRun.input.task).toContain(
      "Start at: https://eservices.ica.gov.sg/sgarrivalcard/",
    );
    expect(arrivalRun.input.task).toContain("Marina Bay Sands");
    expect(arrivalRun.input.secrets).toEqual([
      { alias: "passport_number", value: "X1234567", allowedDomains: ["ica.gov.sg"] },
    ]);
    await ticks();
    [f] = await flights(cookie);
    expect(f!.arrival).toMatchObject({ status: "done", note: "Reference SGAC-778" });

    // 6. Flight day: live status shows a delay, and "time to leave" picks the train.
    status.live = {
      statusText: "Scheduled / Delayed",
      cancelled: false,
      diverted: false,
      departAt: new Date(depart.getTime() + 45 * 60000).toISOString(),
      arriveAt: null,
      scheduledDepartAt: depart.toISOString(),
      departed: false,
      landed: false,
      delayMinutes: 45,
      terminal: "I",
      gate: "G92",
      arrivalTerminal: null,
      arrivalGate: null,
      baggageClaim: null,
    };
    now = new Date(depart.getTime() - 5 * H);
    await tick();
    [f] = await flights(cookie);
    expect(f!.today).toBe(true);
    expect(f!.live).toMatchObject({ status: "delayed", delayMinutes: 45, gate: "G92" });
    // Be there 3 hours before (international), 40 min by train + 15 min spare: leave 3h55 before.
    expect(new Date(f!.leave!.leaveBy).getTime()).toBe(
      Date.parse(f!.departAt!) - (180 + 55) * 60000,
    );
    expect(f!.leave).toMatchObject({
      mode: "train",
      minutes: 40,
      otherMode: "car",
      otherMinutes: 50,
    });
    const day = await mainTexts(cookie);
    expect(day.some((t) => t.includes("UA 1 is now about 45 minutes late"))).toBe(true);

    now = new Date(depart.getTime() - (180 + 55 + 20) * 60000);
    await tick();
    const leave = await mainTexts(cookie);
    expect(
      leave.some(
        (t) => t.includes("Time to leave in") && t.includes("Take the train: about 40 min"),
      ),
    ).toBe(true);
    // Each message is sent once.
    await tick();
    expect((await mainTexts(cookie)).filter((t) => t.includes("Time to leave")).length).toBe(1);
  });

  it("asks for what's missing when check-in opens, then a backup link before it's too late", async () => {
    const { cookie, userId } = await signUp();
    const depart = await bookTrip(userId, 30);
    // A day before check-in opens it's already within reach: a reminder.
    await tick();
    expect(
      (await mainTexts(cookie)).some((t) => t.startsWith("I still need your name as on your ID")),
    ).toBe(true);
    now = new Date(depart.getTime() - 23 * H);
    await tick();
    expect((await mainTexts(cookie)).some((t) => t.startsWith("Check-in for UA 1 is open"))).toBe(
      true,
    );
    expect(browser.runs.size).toBe(0);
    now = new Date(depart.getTime() - 2.5 * H);
    await tick();
    const texts = await mainTexts(cookie);
    expect(
      texts.some((t) => t.includes("check in yourself on united.com with booking ABC123")),
    ).toBe(true);
  });

  it("asks the airline's question, remembers the answer, and tries again", async () => {
    const { cookie, userId } = await signUp();
    const depart = await bookTrip(userId, 20);
    const [f] = await flights(cookie);
    // Check-in is already open, so it starts as soon as the details are in.
    browser.scripts.push({ result: "NEEDS_INFO: Who is your emergency contact?" });
    await app.inject({
      method: "POST",
      url: `/flights/${f!.id}/prep`,
      headers: { cookie },
      payload: prep,
    });
    await settle();
    await ticks();
    let [view] = await flights(cookie);
    expect(view!.checkin).toMatchObject({
      status: "waiting_for_you",
      question: "Who is your emergency contact?",
    });
    expect(
      (await mainTexts(cookie)).some((t) =>
        t.includes('United is asking: "Who is your emergency contact?"'),
      ),
    ).toBe(true);

    browser.scripts.push({ result: 'CHECKED_IN {"seat":"3C"}' });
    await app.inject({
      method: "POST",
      url: `/flights/${f!.id}/prep`,
      headers: { cookie },
      payload: { answer: "Bo Lee, +1 415 555 0100" },
    });
    await settle();
    const second = [...browser.runs.values()][1]!;
    expect(second.input.task).toContain("Who is your emergency contact?: Bo Lee, +1 415 555 0100");
    await ticks();
    [view] = await flights(cookie);
    expect(view!.checkin.status).toBe("done");
    void depart;
  });

  it("sends people to the desk when the airline says so", async () => {
    const { cookie, userId } = await signUp();
    await bookTrip(userId, 20);
    const [f] = await flights(cookie);
    browser.scripts.push({
      result: "AIRPORT_ONLY: Travel documents for this destination must be checked at the airport.",
    });
    await app.inject({
      method: "POST",
      url: `/flights/${f!.id}/prep`,
      headers: { cookie },
      payload: prep,
    });
    await settle();
    await ticks();
    const [view] = await flights(cookie);
    expect(view!.checkin.status).toBe("airport");
    expect(
      (await mainTexts(cookie)).some(
        (t) =>
          t.startsWith("Please check in at the United desk for UA 1") &&
          t.includes("must be checked at the airport"),
      ),
    ).toBe(true);
  });

  it("keeps each person's flights and travel details to themselves", async () => {
    const a = await signUp();
    const b = await signUp();
    await bookTrip(a.userId, 50);
    const [f] = await flights(a.cookie);
    await app.inject({
      method: "POST",
      url: `/flights/${f!.id}/prep`,
      headers: { cookie: a.cookie },
      payload: prep,
    });
    await settle();
    expect((await flights(b.cookie)).length).toBe(0);
    expect(
      (await app.inject({ method: "GET", url: `/flights/${f!.id}`, headers: { cookie: b.cookie } }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/flights/${f!.id}/prep`,
          headers: { cookie: b.cookie },
          payload: { firstName: "Eve" },
        })
      ).statusCode,
    ).toBe(403);
    const other = await app.inject({
      method: "POST",
      url: "/travel-profile/reveal",
      headers: { cookie: b.cookie },
    });
    expect(other.json()).toEqual({ documents: {} });
    const mine = await app.inject({
      method: "POST",
      url: "/travel-profile/reveal",
      headers: { cookie: a.cookie },
    });
    expect(mine.json().documents.passportNumber).toBe("X1234567");
    // Row-level security, straight from the database.
    const seen = await withUser(sql!, b.userId, (tx) => tx`SELECT * FROM flight_plans`);
    expect(seen.length).toBe(0);
    const profiles = await withUser(sql!, b.userId, (tx) => tx`SELECT * FROM travel_profiles`);
    expect(profiles.length).toBe(0);
    // The cron route needs its secret.
    expect((await app.inject({ method: "GET", url: "/cron/flights" })).statusCode).toBe(401);
  });

  it("edits travel details in Settings", async () => {
    const { cookie } = await signUp();
    const res = await app.inject({
      method: "PATCH",
      url: "/travel-profile",
      headers: { cookie },
      payload: { firstName: "Ann", passportNumber: "Y7654321", frequentFlyer: { UA: "MP123456" } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().profile).toMatchObject({
      firstName: "Ann",
      hasPassportNumber: true,
      frequentFlyerAirlines: ["UA"],
    });
    expect(res.body).not.toContain("Y7654321");
    const cleared = await app.inject({
      method: "PATCH",
      url: "/travel-profile",
      headers: { cookie },
      payload: { passportNumber: "" },
    });
    expect(cleared.json().profile.hasPassportNumber).toBe(false);
    const bad = await app.inject({
      method: "PATCH",
      url: "/travel-profile",
      headers: { cookie },
      payload: { dateOfBirth: "2099-01-01" },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("runs the scheduler for everyone without mixing people up", async () => {
    const a = await signUp();
    await bookTrip(a.userId, 10);
    // Plans are due right away; one pass looks at them and sets the next time.
    const n = await tickAll({
      sql: sql!,
      browser,
      secret: config.sessionSecret,
      vaultKey: { masterKey: Buffer.alloc(32), keyId: "test" } as never,
      status,
      routes,
      now: () => now,
    });
    expect(n).toBeGreaterThan(0);
  });
});
