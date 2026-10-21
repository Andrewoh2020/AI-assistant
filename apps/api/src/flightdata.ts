import { HttpError } from "./http.js";

/**
 * Outside data for flight day: live flight status from FlightAware (AeroAPI v4, what Muse uses)
 * and travel times to the airport from Google's Routes API. Both are optional: without a key the
 * trip card shows the booked times, and "time to leave" works from the airline's usual advice.
 */

export interface LiveFlight {
  /** FlightAware's own words, like "Scheduled" or "En Route / Delayed". */
  statusText: string;
  cancelled: boolean;
  diverted: boolean;
  /** Real moments (ISO), best known: actual, else estimated, else scheduled. */
  departAt: string | null;
  arriveAt: string | null;
  scheduledDepartAt: string | null;
  departed: boolean;
  landed: boolean;
  /** Minutes late leaving the gate (negative: early). */
  delayMinutes: number;
  terminal: string | null;
  gate: string | null;
  arrivalTerminal: string | null;
  arrivalGate: string | null;
  baggageClaim: string | null;
}

export interface FlightStatusSource {
  readonly available: boolean;
  /** The flight leaving `from` around `departAt`, or null when FlightAware doesn't have it. */
  find(flightNumber: string, from: string, departAt: Date): Promise<LiveFlight | null>;
}

interface AeroFlight {
  ident_iata?: string | null;
  status?: string | null;
  cancelled?: boolean;
  diverted?: boolean;
  departure_delay?: number | null;
  origin?: { code_iata?: string | null } | null;
  scheduled_out?: string | null;
  estimated_out?: string | null;
  actual_out?: string | null;
  scheduled_off?: string | null;
  estimated_off?: string | null;
  actual_off?: string | null;
  scheduled_in?: string | null;
  estimated_in?: string | null;
  actual_in?: string | null;
  scheduled_on?: string | null;
  estimated_on?: string | null;
  actual_on?: string | null;
  gate_origin?: string | null;
  gate_destination?: string | null;
  terminal_origin?: string | null;
  terminal_destination?: string | null;
  baggage_claim?: string | null;
}

export function toLive(f: AeroFlight): LiveFlight {
  const departAt =
    f.actual_out ?? f.estimated_out ?? f.scheduled_out ?? f.actual_off ?? f.estimated_off ?? null;
  const arriveAt =
    f.actual_in ?? f.estimated_in ?? f.scheduled_in ?? f.actual_on ?? f.estimated_on ?? null;
  return {
    statusText: f.status ?? "",
    cancelled: !!f.cancelled,
    diverted: !!f.diverted,
    departAt,
    arriveAt,
    scheduledDepartAt: f.scheduled_out ?? f.scheduled_off ?? null,
    departed: !!(f.actual_out || f.actual_off),
    landed: !!(f.actual_in || f.actual_on),
    delayMinutes: Math.round((f.departure_delay ?? 0) / 60),
    terminal: f.terminal_origin ?? null,
    gate: f.gate_origin ?? null,
    arrivalTerminal: f.terminal_destination ?? null,
    arrivalGate: f.gate_destination ?? null,
    baggageClaim: f.baggage_claim ?? null,
  };
}

export class FlightAwareHttp implements FlightStatusSource {
  constructor(
    private readonly key: string,
    private readonly base = "https://aeroapi.flightaware.com/aeroapi",
  ) {}

  get available() {
    return !!this.key;
  }

  async find(flightNumber: string, from: string, departAt: Date): Promise<LiveFlight | null> {
    if (!this.key) return null;
    const ident = flightNumber.replace(/\s+/g, "").toUpperCase();
    const iso = (t: number) => new Date(t).toISOString().slice(0, 19) + "Z";
    const q = new URLSearchParams({
      ident_type: "designator",
      start: iso(departAt.getTime() - 12 * 3600000),
      end: iso(departAt.getTime() + 12 * 3600000),
    });
    const res = await fetch(`${this.base}/flights/${encodeURIComponent(ident)}?${q}`, {
      headers: { "x-apikey": this.key, Accept: "application/json" },
      signal: AbortSignal.timeout(20000),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new HttpError(res.status, await res.text(), "FlightAware");
    const data = (await res.json()) as { flights?: AeroFlight[] };
    const flights = (data.flights ?? []).filter(
      (f) => !from || (f.origin?.code_iata ?? "").toUpperCase() === from.toUpperCase(),
    );
    if (!flights.length) return null;
    // The one scheduled closest to the booked departure.
    const gap = (f: AeroFlight) =>
      Math.abs(new Date(f.scheduled_out ?? f.scheduled_off ?? 0).getTime() - departAt.getTime());
    flights.sort((a, b) => gap(a) - gap(b));
    return toLive(flights[0]!);
  }
}

// Routes -------------------------------------------------------------------------------------------

export interface RouteOption {
  mode: "car" | "train";
  minutes: number;
}

export interface RouteSource {
  readonly available: boolean;
  /** Door-to-door minutes from an address to a point, leaving at `leaveAt`. Null: no route. */
  travel(
    mode: "car" | "train",
    from: string,
    to: { lat: number; lon: number },
    leaveAt: Date,
  ): Promise<RouteOption | null>;
}

export class GoogleRoutesHttp implements RouteSource {
  constructor(private readonly key: string) {}

  get available() {
    return !!this.key;
  }

  async travel(
    mode: "car" | "train",
    from: string,
    to: { lat: number; lon: number },
    leaveAt: Date,
  ): Promise<RouteOption | null> {
    if (!this.key) return null;
    // Traffic is only predicted for times in the future.
    const when = new Date(Math.max(leaveAt.getTime(), Date.now() + 60000)).toISOString();
    const body: Record<string, unknown> = {
      origin: { address: from },
      destination: { location: { latLng: { latitude: to.lat, longitude: to.lon } } },
      travelMode: mode === "car" ? "DRIVE" : "TRANSIT",
      departureTime: when,
    };
    if (mode === "car") body.routingPreference = "TRAFFIC_AWARE";
    else
      body.transitPreferences = { allowedTravelModes: ["TRAIN", "RAIL", "SUBWAY", "LIGHT_RAIL"] };
    const res = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": this.key,
        "X-Goog-FieldMask": "routes.duration",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new HttpError(res.status, await res.text(), "Google Routes");
    const data = (await res.json()) as { routes?: { duration?: string }[] };
    const seconds = Number((data.routes?.[0]?.duration ?? "").replace(/s$/, ""));
    return seconds > 0 ? { mode, minutes: Math.round(seconds / 60) } : null;
  }
}
