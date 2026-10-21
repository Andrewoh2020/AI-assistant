import { AIRPORTS } from "./airports-data.js";

/**
 * Airports by IATA code: time zone, position and country. Bookings only give airport-local times
 * ("2026-11-03T10:30"), so the time zone turns them into real moments for scheduling check-in,
 * and the position is where the "time to leave" route ends.
 */

export interface Airport {
  code: string;
  tz: string;
  lat: number;
  lon: number;
  /** ISO country code, like "SG". */
  country: string;
  city: string;
}

let byCode: Map<string, Airport> | null = null;

export function airport(code: string | null | undefined): Airport | null {
  if (!code) return null;
  if (!byCode) {
    byCode = new Map();
    for (const line of AIRPORTS.split("\n")) {
      const [c, tz, lat, lon, country, city] = line.split("|");
      if (!c || !tz) continue;
      byCode.set(c, {
        code: c,
        tz,
        lat: Number(lat),
        lon: Number(lon),
        country: country!,
        city: city!,
      });
    }
  }
  return byCode.get(code.toUpperCase()) ?? null;
}

/** The time zone's offset from UTC at that moment, in minutes (Singapore: 480). */
function offsetMinutes(tz: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return Math.round((asUtc - at.getTime()) / 60000);
}

/** "2026-11-03T10:30" at an airport, as a real moment. Null when the airport isn't known. */
export function localToInstant(local: string | null, code: string | null): Date | null {
  const a = airport(code);
  if (!local || !a || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(local)) return null;
  const [y, m, d] = local.slice(0, 10).split("-").map(Number) as [number, number, number];
  const [hh, mm] = local.slice(11, 16).split(":").map(Number) as [number, number];
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  // Twice, so a time near a clock change lands on the right side of it.
  let at = new Date(guess - offsetMinutes(a.tz, new Date(guess)) * 60000);
  at = new Date(guess - offsetMinutes(a.tz, at) * 60000);
  return at;
}

/** A moment as local time at an airport, "2026-11-03T10:30". */
export function instantToLocal(at: Date, code: string | null): string | null {
  const a = airport(code);
  if (!a) return null;
  return new Date(at.getTime() + offsetMinutes(a.tz, at) * 60000).toISOString().slice(0, 16);
}

/** A moment as local time in a time zone, "2026-11-03T10:30". */
export function inZone(at: Date, tz: string): string {
  return new Date(at.getTime() + offsetMinutes(tz, at) * 60000).toISOString().slice(0, 16);
}
