import { withUser, type Sql, type TransactionSql } from "@ai-assistant/db";
import type { PrepKey, TravelProfileView } from "@ai-assistant/api-client";
import { BadRequest } from "./errors.js";
import {
  documentKinds,
  revealTravelDocuments,
  saveTravelDocuments,
  type TravelDocuments,
  type VaultKey,
} from "./vault.js";

/**
 * The person's travel details: given once, kept, and never asked for again (unless a passport
 * expires or an airline turns something down). Passport, Known Traveler and frequent flyer numbers
 * are sealed in the vault; the rest is here. Plan: /mnt/project-files/design/checkin-plan.html.
 */

export interface TravelProfileRow {
  user_id: string;
  first_name: string | null;
  middle_name: string | null;
  last_name: string | null;
  date_of_birth: Date | null;
  gender: "female" | "male" | "x" | null;
  nationality: string | null;
  passport_country: string | null;
  passport_expiry: Date | null;
  home_address: string | null;
  skipped_home_address: boolean;
  seat_side: "window" | "aisle" | "any" | null;
  seat_zone: "front" | "middle" | "back" | "any" | null;
  seat_empty_nearby: boolean | null;
  seat_avoid_washroom: boolean | null;
  saved_documents: string[];
  no_known_traveler: boolean;
  no_frequent_flyer: string[];
  answers: Record<string, string>;
}

export const EMPTY_PROFILE: Omit<TravelProfileRow, "user_id"> = {
  first_name: null,
  middle_name: null,
  last_name: null,
  date_of_birth: null,
  gender: null,
  nationality: null,
  passport_country: null,
  passport_expiry: null,
  home_address: null,
  skipped_home_address: false,
  seat_side: null,
  seat_zone: null,
  seat_empty_nearby: null,
  seat_avoid_washroom: null,
  saved_documents: [],
  no_known_traveler: false,
  no_frequent_flyer: [],
  answers: {},
};

export async function profileOf(tx: TransactionSql, userId: string): Promise<TravelProfileRow> {
  const [row] = await tx<TravelProfileRow[]>`SELECT * FROM travel_profiles`;
  return row ?? { user_id: userId, ...EMPTY_PROFILE };
}

export async function readProfile(sql: Sql, userId: string): Promise<TravelProfileRow> {
  return withUser(sql, userId, (tx) => profileOf(tx, userId));
}

// Postgres dates arrive as local-midnight Dates; read them back the same way. A date just typed in
// (editProfile) is still its "YYYY-MM-DD" text.
export const isoDate = (d: Date | string | null) =>
  typeof d === "string"
    ? d
    : d
      ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
      : null;

/** What one flight needs, given what we already have. */
export interface FlightNeeds {
  /** Needed before check-in can run. */
  required: PrepKey[];
  /** Asked once, but check-in works without them. */
  optional: PrepKey[];
  /** Friendly names of what we already have, for "Already have: ..." on the card. */
  have: string[];
  /** Problems to fix early, in plain words ("That passport expires before your trip"). */
  warnings: string[];
}

export interface FlightFacts {
  international: boolean;
  /** Airline code for frequent flyer numbers, like "UA". */
  airline: string | null;
  airlineName: string | null;
  /** The flight leaves from the US (TSA PreCheck applies). */
  fromUs: boolean;
  /** The arrival country, when it needs a passport valid 6 months after arrival. */
  sixMonthCountry: string | null;
  arriveOn: string | null;
  departOn: string | null;
}

const monthsAfter = (day: string, months: number) => {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1 + months, d)).toISOString().slice(0, 10);
};

export function needsFor(p: TravelProfileRow, f: FlightFacts): FlightNeeds {
  const required: PrepKey[] = [];
  const optional: PrepKey[] = [];
  const have: string[] = [];
  if (!p.first_name || !p.last_name) required.push("name");
  else have.push("name");
  if (!p.date_of_birth) required.push("dateOfBirth");
  else have.push("date of birth");
  if (!p.gender) required.push("gender");
  else have.push("gender");
  const hasPassport = p.saved_documents.includes("passport");
  if (f.international) {
    if (!p.nationality) required.push("nationality");
    else have.push("nationality");
    if (!hasPassport) required.push("passportNumber");
    if (!p.passport_expiry || (f.departOn && isoDate(p.passport_expiry)! < f.departOn)) {
      required.push("passportExpiry");
    }
    if (hasPassport && p.passport_expiry) have.push("passport");
  }
  if (f.fromUs && !p.saved_documents.includes("known_traveler") && !p.no_known_traveler) {
    optional.push("knownTraveler");
  } else if (p.saved_documents.includes("known_traveler")) have.push("PreCheck");
  if (f.airline) {
    if (p.saved_documents.includes(`ff:${f.airline}`))
      have.push(`${f.airlineName ?? f.airline} number`);
    else if (!p.no_frequent_flyer.includes(f.airline)) optional.push("frequentFlyer");
  }
  if (
    !p.seat_side ||
    !p.seat_zone ||
    p.seat_empty_nearby === null ||
    p.seat_avoid_washroom === null
  ) {
    optional.push("seatStyle");
  } else have.push("seat style");
  if (!p.home_address && !p.skipped_home_address) optional.push("homeAddress");

  const warnings: string[] = [];
  const expiry = isoDate(p.passport_expiry);
  if (f.international && expiry && f.departOn && expiry < f.departOn) {
    warnings.push("The passport we have expires before this trip. Add your new one.");
  } else if (f.international && expiry && f.sixMonthCountry && f.arriveOn) {
    if (expiry < monthsAfter(f.arriveOn, 6)) {
      warnings.push(
        `${f.sixMonthCountry} needs your passport to be valid for at least 6 months after you arrive, and yours runs out on ${expiry}.`,
      );
    }
  }
  return { required, optional, have, warnings };
}

const NAME = /^[\p{L}][\p{L}\p{M}' .-]{0,59}$/u;
const COUNTRY = /^[A-Z]{2}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** One prep card's answers, as sent by the app. Every field is optional. */
export interface PrepInput {
  firstName?: string;
  middleName?: string;
  lastName?: string;
  dateOfBirth?: string;
  gender?: "female" | "male" | "x";
  nationality?: string;
  passportNumber?: string;
  passportExpiry?: string;
  passportCountry?: string;
  /** Empty or null: "I don't have one" (never asked again). */
  knownTravelerNumber?: string | null;
  /** For the flight's airline; empty or null: "I don't have one" for that airline. */
  frequentFlyerNumber?: string | null;
  seatSide?: "window" | "aisle" | "any";
  seatZone?: "front" | "middle" | "back" | "any";
  seatEmptyNearby?: boolean;
  seatAvoidWashroom?: boolean;
  homeAddress?: string;
  /** The answer to the question an airline or arrival form asked. */
  answer?: string;
}

/** Checks the answers; throws BadRequest with a plain sentence for the first problem. */
export function checkPrep(input: PrepInput, today: string): void {
  const bad = (msg: string): never => {
    throw new BadRequest(msg);
  };
  for (const [k, label] of [
    ["firstName", "first name"],
    ["lastName", "last name"],
  ] as const) {
    const v = input[k];
    if (v !== undefined && !NAME.test(v.trim()))
      bad(`Check your ${label}: letters only, as on your ID.`);
  }
  if (input.middleName && !NAME.test(input.middleName.trim())) bad("Check your middle name.");
  if (input.dateOfBirth !== undefined) {
    if (
      !DAY.test(input.dateOfBirth) ||
      input.dateOfBirth >= today ||
      input.dateOfBirth < "1900-01-01"
    ) {
      bad("That date of birth doesn't look right.");
    }
  }
  if (input.passportExpiry !== undefined) {
    if (!DAY.test(input.passportExpiry)) bad("Enter the passport's expiry date.");
    if (input.passportExpiry < today) {
      bad(`That passport expired on ${input.passportExpiry}. Do you have a newer one?`);
    }
  }
  for (const k of ["nationality", "passportCountry"] as const) {
    const v = input[k];
    if (v !== undefined && !COUNTRY.test(v)) bad("Choose a country.");
  }
  if (
    input.passportNumber !== undefined &&
    !/^[A-Za-z0-9]{5,20}$/.test(input.passportNumber.replace(/\s+/g, ""))
  ) {
    bad("That passport number doesn't look right: letters and numbers only.");
  }
  if (
    input.knownTravelerNumber &&
    !/^[A-Za-z0-9]{5,20}$/.test(input.knownTravelerNumber.replace(/\s+/g, ""))
  ) {
    bad("That Known Traveler Number doesn't look right.");
  }
  if (
    input.frequentFlyerNumber &&
    !/^[A-Za-z0-9-]{3,30}$/.test(input.frequentFlyerNumber.replace(/\s+/g, ""))
  ) {
    bad("That frequent flyer number doesn't look right.");
  }
  if (input.homeAddress !== undefined && input.homeAddress.trim().length > 300)
    bad("That address is too long.");
  if (input.answer !== undefined && input.answer.trim().length > 500)
    bad("That answer is too long.");
}

/**
 * Saves a prep card's answers: plain details here, secret numbers in the vault. `airline` is the
 * flight's airline (for its frequent flyer number) and `question` the airline's question being
 * answered, if any.
 */
export async function savePrep(
  sql: Sql,
  vk: VaultKey,
  userId: string,
  input: PrepInput,
  ctx: { airline: string | null; question: string | null },
): Promise<void> {
  const ff =
    input.frequentFlyerNumber !== undefined && ctx.airline
      ? { [ctx.airline]: input.frequentFlyerNumber?.replace(/\s+/g, "") || null }
      : undefined;
  let kinds: string[] | null = null;
  if (input.passportNumber !== undefined || input.knownTravelerNumber || ff?.[ctx.airline!]) {
    kinds = await saveTravelDocuments(sql, vk, userId, {
      passportNumber: input.passportNumber?.replace(/\s+/g, "").toUpperCase(),
      knownTravelerNumber: input.knownTravelerNumber
        ? input.knownTravelerNumber.replace(/\s+/g, "")
        : undefined,
      frequentFlyer: ff && ff[ctx.airline!] ? ff : undefined,
    });
  }
  await withUser(sql, userId, async (tx) => {
    const p = await profileOf(tx, userId);
    const trim = (v: string | undefined) =>
      v === undefined ? undefined : v.replace(/\s+/g, " ").trim();
    const next: TravelProfileRow = {
      ...p,
      first_name: trim(input.firstName) ?? p.first_name,
      middle_name: input.middleName !== undefined ? trim(input.middleName) || null : p.middle_name,
      last_name: trim(input.lastName) ?? p.last_name,
      date_of_birth: input.dateOfBirth ? (input.dateOfBirth as unknown as Date) : p.date_of_birth,
      gender: input.gender ?? p.gender,
      nationality: input.nationality ?? p.nationality,
      passport_country:
        input.passportCountry ?? p.passport_country ?? input.nationality ?? p.nationality,
      passport_expiry: input.passportExpiry
        ? (input.passportExpiry as unknown as Date)
        : p.passport_expiry,
      home_address: trim(input.homeAddress) || p.home_address,
      skipped_home_address: p.skipped_home_address || input.homeAddress?.trim() === "",
      seat_side: input.seatSide ?? p.seat_side,
      seat_zone: input.seatZone ?? p.seat_zone,
      seat_empty_nearby: input.seatEmptyNearby ?? p.seat_empty_nearby,
      seat_avoid_washroom: input.seatAvoidWashroom ?? p.seat_avoid_washroom,
      saved_documents: kinds ?? p.saved_documents,
      no_known_traveler:
        input.knownTravelerNumber !== undefined ? !input.knownTravelerNumber : p.no_known_traveler,
      no_frequent_flyer:
        ff && ctx.airline && !ff[ctx.airline]
          ? [...new Set([...p.no_frequent_flyer, ctx.airline])]
          : p.no_frequent_flyer.filter(
              (a) => !(ff && ctx.airline && ff[ctx.airline] && a === ctx.airline),
            ),
      answers:
        input.answer?.trim() && ctx.question
          ? { ...p.answers, [ctx.question.slice(0, 200)]: input.answer.trim() }
          : p.answers,
    };
    await writeProfile(tx, userId, next);
  });
}

async function writeProfile(tx: TransactionSql, userId: string, p: TravelProfileRow) {
  await tx`
    INSERT INTO travel_profiles (user_id, first_name, middle_name, last_name, date_of_birth, gender,
      nationality, passport_country, passport_expiry, home_address, skipped_home_address, seat_side, seat_zone,
      seat_empty_nearby, seat_avoid_washroom, saved_documents, no_known_traveler,
      no_frequent_flyer, answers)
    VALUES (${userId}, ${p.first_name}, ${p.middle_name}, ${p.last_name}, ${p.date_of_birth},
      ${p.gender}, ${p.nationality}, ${p.passport_country}, ${p.passport_expiry}, ${p.home_address}, ${p.skipped_home_address},
      ${p.seat_side}, ${p.seat_zone}, ${p.seat_empty_nearby}, ${p.seat_avoid_washroom},
      ${p.saved_documents}, ${p.no_known_traveler}, ${p.no_frequent_flyer},
      ${tx.json(p.answers)})
    ON CONFLICT (user_id) DO UPDATE SET
      first_name = EXCLUDED.first_name, middle_name = EXCLUDED.middle_name,
      last_name = EXCLUDED.last_name, date_of_birth = EXCLUDED.date_of_birth,
      gender = EXCLUDED.gender, nationality = EXCLUDED.nationality,
      passport_country = EXCLUDED.passport_country, passport_expiry = EXCLUDED.passport_expiry,
      home_address = EXCLUDED.home_address, skipped_home_address = EXCLUDED.skipped_home_address,
      seat_side = EXCLUDED.seat_side,
      seat_zone = EXCLUDED.seat_zone, seat_empty_nearby = EXCLUDED.seat_empty_nearby,
      seat_avoid_washroom = EXCLUDED.seat_avoid_washroom,
      saved_documents = EXCLUDED.saved_documents, no_known_traveler = EXCLUDED.no_known_traveler,
      no_frequent_flyer = EXCLUDED.no_frequent_flyer, answers = EXCLUDED.answers,
      updated_at = now()`;
}

// Settings ---------------------------------------------------------------------------------------

export function profileView(p: TravelProfileRow): TravelProfileView {
  return {
    firstName: p.first_name,
    middleName: p.middle_name,
    lastName: p.last_name,
    dateOfBirth: isoDate(p.date_of_birth),
    gender: p.gender,
    nationality: p.nationality,
    passportCountry: p.passport_country,
    passportExpiry: isoDate(p.passport_expiry),
    homeAddress: p.home_address,
    seatSide: p.seat_side,
    seatZone: p.seat_zone,
    seatEmptyNearby: p.seat_empty_nearby,
    seatAvoidWashroom: p.seat_avoid_washroom,
    hasPassportNumber: p.saved_documents.includes("passport"),
    hasKnownTraveler: p.saved_documents.includes("known_traveler"),
    frequentFlyerAirlines: p.saved_documents
      .filter((k) => k.startsWith("ff:"))
      .map((k) => k.slice(3)),
    answers: Object.entries(p.answers).map(([question, answer]) => ({ question, answer })),
  };
}

/** The hidden numbers, for the person's own eyes in Settings. */
export async function revealDocuments(
  sql: Sql,
  vk: VaultKey,
  userId: string,
): Promise<TravelDocuments> {
  return revealTravelDocuments(sql, vk, userId);
}

/** Settings edits: one field at a time, saved on click-away. Empty removes it. */
export async function editProfile(
  sql: Sql,
  vk: VaultKey,
  userId: string,
  input: PrepInput & { frequentFlyer?: Record<string, string | null>; removeAnswer?: string },
  today: string,
): Promise<TravelProfileView> {
  checkPrep(
    {
      ...input,
      // Empty clears a field in Settings; only check what is being set.
      firstName: input.firstName || undefined,
      lastName: input.lastName || undefined,
      dateOfBirth: input.dateOfBirth || undefined,
      passportExpiry: input.passportExpiry || undefined,
      passportNumber: input.passportNumber || undefined,
      nationality: input.nationality || undefined,
      passportCountry: input.passportCountry || undefined,
    },
    today,
  );
  let kinds: string[] | null = null;
  if (
    input.passportNumber !== undefined ||
    input.knownTravelerNumber !== undefined ||
    input.frequentFlyer !== undefined
  ) {
    kinds = await saveTravelDocuments(
      sql,
      vk,
      userId,
      {
        passportNumber:
          input.passportNumber === undefined
            ? undefined
            : input.passportNumber.replace(/\s+/g, "").toUpperCase() || null,
        knownTravelerNumber:
          input.knownTravelerNumber === undefined
            ? undefined
            : input.knownTravelerNumber?.replace(/\s+/g, "") || null,
        frequentFlyer: input.frequentFlyer,
      },
      "edited",
    );
  }
  return withUser(sql, userId, async (tx) => {
    const p = await profileOf(tx, userId);
    const text = (v: string | undefined, old: string | null) =>
      v === undefined ? old : v.replace(/\s+/g, " ").trim() || null;
    const day = (v: string | undefined, old: Date | null) =>
      v === undefined ? old : ((v || null) as unknown as Date | null);
    const answers = { ...p.answers };
    if (input.removeAnswer) delete answers[input.removeAnswer];
    const next: TravelProfileRow = {
      ...p,
      first_name: text(input.firstName, p.first_name),
      middle_name: text(input.middleName, p.middle_name),
      last_name: text(input.lastName, p.last_name),
      date_of_birth: day(input.dateOfBirth, p.date_of_birth),
      gender: input.gender ?? p.gender,
      nationality: input.nationality === undefined ? p.nationality : input.nationality || null,
      passport_country:
        input.passportCountry === undefined ? p.passport_country : input.passportCountry || null,
      passport_expiry: day(input.passportExpiry, p.passport_expiry),
      home_address: text(input.homeAddress, p.home_address),
      seat_side: input.seatSide ?? p.seat_side,
      seat_zone: input.seatZone ?? p.seat_zone,
      seat_empty_nearby: input.seatEmptyNearby ?? p.seat_empty_nearby,
      seat_avoid_washroom: input.seatAvoidWashroom ?? p.seat_avoid_washroom,
      saved_documents: kinds ?? p.saved_documents,
      // Removing a number in Settings means "ask me again next time".
      no_known_traveler: input.knownTravelerNumber !== undefined ? false : p.no_known_traveler,
      answers,
    };
    await writeProfile(tx, userId, next);
    return profileView(next);
  });
}

export { documentKinds };
