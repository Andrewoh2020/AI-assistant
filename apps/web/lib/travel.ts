/**
 * Small helpers for trip cards and travel details: airport-local times and country names.
 * Airport times arrive as "2026-11-03T22:40" (local at the airport) and are shown as they are,
 * never moved into the viewer's time zone.
 */

const fmt = (opts: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("en-GB", { ...opts, timeZone: "UTC" });
const DAY = fmt({ weekday: "short", day: "numeric", month: "short" });

function asUtc(local: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(local);
  if (!m) return null;
  return new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +(m[4] ?? 0), +(m[5] ?? 0)));
}

/** "Tue 3 Nov" */
export function localDay(local: string | null | undefined): string {
  const d = local ? asUtc(local) : null;
  return d ? DAY.format(d).replace(",", "") : "";
}

/** "10:40 pm" */
export function localClock(local: string | null | undefined): string {
  if (!local || local.length < 16) return "";
  const h = Number(local.slice(11, 13));
  return `${h % 12 || 12}:${local.slice(14, 16)} ${h < 12 ? "am" : "pm"}`;
}

/** "Tue 3 Nov, 10:40 pm" */
export function localWhen(local: string | null | undefined): string {
  const day = localDay(local);
  const clock = localClock(local);
  return clock ? `${day}, ${clock}` : day;
}

/** A real moment (ISO) in the viewer's own time: "Thu 8:05 am". */
export function viewerWhen(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" })
    .format(d)
    .replace(",", "");
  const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" })
    .format(d)
    .toLowerCase();
  return `${day}, ${time}`;
}

/** "2 min ago" */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const min = Math.max(0, Math.round((now - Date.parse(iso)) / 60000));
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h === 1 ? "1 hour ago" : `${h} hours ago`;
}

// ISO 3166 country codes, named in the viewer's language by the browser.
const CODES =
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW".split(
    " ",
  );

let named: { code: string; name: string }[] | null = null;

export function countries(): { code: string; name: string }[] {
  if (!named) {
    const names = new Intl.DisplayNames(["en"], { type: "region" });
    named = CODES.map((code) => ({ code, name: names.of(code) ?? code })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }
  return named;
}

export function countryName(code: string | null | undefined): string {
  if (!code) return "";
  return countries().find((c) => c.code === code)?.name ?? code;
}
