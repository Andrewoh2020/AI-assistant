"use client";

import {
  ApiError,
  type BrowserView,
  type FlightView,
  type PrepAnswers,
  type PrepKey,
} from "@ai-assistant/api-client";
import { useState, type FormEvent, type ReactNode } from "react";
import { api } from "@/lib/client";
import { ago, countries, localClock, localDay, viewerWhen } from "@/lib/travel";
import { FileChip } from "./Files";

/**
 * The trip card (plan: /mnt/project-files/design/checkin-plan.html). One card per flight, kept up
 * to date in place: the route and times (live on the day), what check-in is doing, the one
 * "Trip prep" form for anything missing, the arrival card, and when to leave.
 */
export function FlightCard({
  flight,
  onChange,
  browserCard,
}: {
  flight: FlightView;
  onChange: (view: FlightView) => void;
  /** Renders the check-in or arrival card's browser, like any other browser card. */
  browserCard: (b: BrowserView) => ReactNode;
}) {
  const f = flight;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function change(input: { autoCheckin?: boolean; arrivalConfirmed?: boolean }) {
    setBusy(true);
    setError(null);
    try {
      onChange((await api.updateFlight(f.id, input)).flight);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't save. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const ci = f.checkin;
  const finished = ["done", "airport", "backup", "off", "past"].includes(ci.status);
  const needsPrep =
    !finished &&
    (f.prep.required.length > 0 ||
      f.prep.optional.length > 0 ||
      !f.prep.noBannedItems ||
      !!ci.question ||
      (f.arrival?.status === "waiting_for_you" && !!f.arrival.question));
  const activeBrowsers = [ci.browser, f.arrival?.browser].filter(
    (b): b is BrowserView =>
      !!b && ["starting", "running", "needs_user", "user_control"].includes(b.status),
  );

  return (
    <section
      className={`trip-card ${f.live?.status === "cancelled" ? "is-cancelled" : ""}`}
      aria-label={`Trip card: ${f.flightNumber ?? "flight"} ${f.fromCode ?? ""} to ${f.toCode ?? ""}`}
    >
      <Header flight={f} />
      <Times flight={f} />
      <AirportLine flight={f} />

      <div className="trip-section">
        <CheckinLine flight={f} />
        {ci.mismatch && (
          <p className="trip-warn" role="alert">
            The boarding pass shows {ci.mismatch}. Please call {f.airlineName} to fix it.
          </p>
        )}
      </div>

      {activeBrowsers.map((b) => (
        <div key={b.id} className="trip-browser">
          {browserCard(b)}
        </div>
      ))}

      {needsPrep && <PrepForm flight={f} onSaved={onChange} />}

      {f.arrival && (
        <ArrivalLine flight={f} busy={busy} onConfirm={() => change({ arrivalConfirmed: true })} />
      )}

      {f.leave && <LeaveLine flight={f} />}

      {(ci.boardingPass || f.arrival?.file) && (
        <div className="trip-files">
          {ci.boardingPass && <FileChip file={ci.boardingPass} />}
          {f.arrival?.file && <FileChip file={f.arrival.file} />}
        </div>
      )}

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <footer className="trip-foot">
        <span>
          {f.live?.checkedAt
            ? `Live status from FlightAware · updated ${ago(f.live.checkedAt)}`
            : f.liveAvailable
              ? "Live status starts a week before the flight"
              : "Booked times · live status isn't set up yet"}
        </span>
        {!f.past && ["scheduled", "waiting_for_you"].includes(ci.status) && (
          <button
            type="button"
            className="bsign-alt"
            disabled={busy}
            onClick={() => change({ autoCheckin: false })}
          >
            Don&apos;t check me in
          </button>
        )}
        {!f.past && ci.status === "off" && (
          <button
            type="button"
            className="bsign-alt"
            disabled={busy}
            onClick={() => change({ autoCheckin: true })}
          >
            Check me in automatically
          </button>
        )}
      </footer>
    </section>
  );
}

function Header({ flight: f }: { flight: FlightView }) {
  const kicker = f.past
    ? "PAST FLIGHT"
    : f.today
      ? "YOUR NEXT TRIP · TODAY"
      : `FLIGHT · ${localDay(f.departLocal).toUpperCase()}`;
  const pill = pillFor(f);
  return (
    <>
      <div className="trip-kicker">{kicker}</div>
      <div className="trip-route">
        {f.fromCode ?? "?"} <span aria-label="to">→</span> {f.toCode ?? "?"}
      </div>
      <div className="trip-meta">
        {[
          f.flightNumber ?? f.airlineName,
          localDay(f.departLocal),
          f.confirmation && `Booking ${f.confirmation}`,
        ]
          .filter(Boolean)
          .join(" · ")}
      </div>
      {pill && <span className={`trip-pill pill-${pill.tone}`}>{pill.text}</span>}
    </>
  );
}

function pillFor(f: FlightView): { text: string; tone: "ok" | "late" | "bad" | "info" } | null {
  const live = f.live;
  if (live?.status === "cancelled") return { text: "Cancelled", tone: "bad" };
  if (live?.status === "landed") return { text: "Landed", tone: "ok" };
  if (live?.status === "departed") return { text: "In the air", tone: "info" };
  if (live?.status === "delayed") return { text: `Delayed ${live.delayMinutes} min`, tone: "late" };
  if (live?.status === "on_time") return { text: "On time", tone: "ok" };
  return null;
}

function Times({ flight: f }: { flight: FlightView }) {
  const live = f.live;
  const late = live?.status === "delayed";
  const departNow = live?.departLocal ?? f.departLocal;
  const arriveNow = live?.arriveLocal ?? f.arriveLocal;
  const moved = (now: string | null, booked: string | null) =>
    !!now && !!booked && now.slice(0, 16) !== booked.slice(0, 16);
  const departDay = f.departLocal?.slice(0, 10);
  return (
    <div className="trip-times">
      <div>
        <span className="trip-meta">Departs · {f.fromCity ?? f.fromCode}</span>
        <b className={late ? "is-late" : ""}>{localClock(departNow)}</b>
        <span className="trip-meta">
          {moved(departNow, f.departLocal) ? `was ${localClock(f.departLocal)} · ` : ""}local time
        </span>
      </div>
      <div className="trip-times-end">
        <span className="trip-meta">Arrives · {f.toCity ?? f.toCode}</span>
        <b className={late ? "is-late" : ""}>{localClock(arriveNow)}</b>
        <span className="trip-meta">
          {arriveNow && arriveNow.slice(0, 10) !== departDay
            ? `${localDay(arriveNow).split(" ")[0]} · `
            : ""}
          local time
        </span>
      </div>
    </div>
  );
}

function AirportLine({ flight: f }: { flight: FlightView }) {
  const terminal = f.live?.terminal ?? f.checkin.terminal;
  const bits = [
    terminal && `Terminal ${terminal}`,
    f.live?.gate && `Gate ${f.live.gate}`,
    f.checkin.seat && `Seat ${f.checkin.seat}`,
    f.checkin.group && `Group ${f.checkin.group}`,
    f.checkin.status === "done" && "Checked in ✓",
    f.live?.status === "landed" && f.live.baggageClaim && `Bags at ${f.live.baggageClaim}`,
  ].filter(Boolean);
  if (!bits.length) return null;
  return <div className="trip-line">{bits.join(" · ")}</div>;
}

function CheckinLine({ flight: f }: { flight: FlightView }) {
  const ci = f.checkin;
  const missing = f.prep.required.length > 0 || !f.prep.noBannedItems || !!ci.question;
  let text: ReactNode;
  switch (ci.status) {
    case "scheduled":
      text = missing
        ? `I'll check you in by myself when check-in opens (${viewerWhen(ci.opensAt)}). I just need a few details first.`
        : `All set. I'll check you in by myself when check-in opens (${viewerWhen(ci.opensAt)}) and send your boarding pass.`;
      break;
    case "waiting_for_you":
      text = ci.question
        ? `Waiting for you: ${f.airlineName} is asking one question. Check-in carries on as soon as you answer.`
        : "Check-in is open. I'll check you in as soon as you add the details below.";
      break;
    case "running":
      text = "Checking you in now.";
      break;
    case "done":
      text = `You're checked in${ci.seat ? `, seat ${ci.seat}` : ""}.${ci.skipped.length ? ` I said no to the paid extras (${ci.skipped.join(", ")}).` : ""}`;
      break;
    case "airport":
      text = `Check in at the ${f.airlineName} desk: online check-in isn't possible for this flight.${ci.note ? ` The site said: "${ci.note}"` : ""}`;
      break;
    case "backup":
      text = (
        <>
          {ci.note ?? "I couldn't check you in."} It takes about a minute yourself
          {ci.site ? (
            <>
              {" "}
              on{" "}
              <a href={`https://www.${ci.site}/`} target="_blank" rel="noreferrer">
                {ci.site}
              </a>
            </>
          ) : (
            " on the airline's website"
          )}
          {f.confirmation ? ` with booking ${f.confirmation}` : ""}.
        </>
      );
      break;
    case "off":
      text = "Automatic check-in is off for this flight.";
      break;
    default:
      text = null;
  }
  if (!text) return null;
  return (
    <p className={`trip-status status-${ci.status}`} role="status">
      {text}
    </p>
  );
}

function ArrivalLine({
  flight: f,
  busy,
  onConfirm,
}: {
  flight: FlightView;
  busy: boolean;
  onConfirm: () => void;
}) {
  const a = f.arrival!;
  const site = new URL(a.site).hostname.replace(/^(www|eservices|tdac)\./, "");
  let body: ReactNode;
  switch (a.status) {
    case "scheduled":
      body = `I'll file it on ${site} when it opens (${viewerWhen(a.opensAt)})${a.stay ? `, using ${a.stay} from your booking` : ""}.`;
      break;
    case "ready":
      body = a.confirmed ? (
        "Filing it now."
      ) : (
        <>
          <span>
            Staying at {a.stay ?? "your answer above"} · Holiday · No fever or symptoms, nothing to
            declare at customs.
          </span>
          <button
            type="button"
            className="btn btn-primary btn-small btn-block trip-submit"
            disabled={busy}
            onClick={onConfirm}
          >
            Looks right, submit
          </button>
          <span className="trip-note">Filled in on {site}, the official site. It&apos;s free.</span>
        </>
      );
      break;
    case "running":
      body = `Filing it on ${site} now.`;
      break;
    case "waiting_for_you":
      body = a.question
        ? `One question first: ${a.question}`
        : "I need a few details first (above).";
      break;
    case "done":
      body = `Filed${a.note ? ` · ${a.note}` : ""}. Show the confirmation at immigration if asked.`;
      break;
    case "backup":
      body = (
        <>
          I couldn&apos;t file it. It&apos;s free and takes a few minutes yourself on{" "}
          <a href={a.site} target="_blank" rel="noreferrer">
            {site}
          </a>{" "}
          (the official site; avoid look-alikes that charge).
        </>
      );
      break;
    default:
      return null;
  }
  return (
    <div className="trip-section trip-arrival">
      <b>{a.form}</b>
      <div className="trip-arrival-body">{body}</div>
    </div>
  );
}

function LeaveLine({ flight: f }: { flight: FlightView }) {
  const l = f.leave!;
  const how =
    l.mode === "train"
      ? `Train · ${l.minutes} min${l.otherMode ? ` (car ${l.otherMinutes} min)` : ""}`
      : l.mode === "car"
        ? `Car · ${l.minutes} min in traffic${l.otherMode ? ` (train ${l.otherMinutes} min)` : ""}`
        : "About an hour to get there";
  return (
    <div className="trip-section trip-leave">
      <b>Leave by {localClock(l.leaveLocal)}</b>
      <span>{how}</span>
      {l.beAtLocal && (
        <span className="trip-note">
          Be at {f.fromCode} by {localClock(l.beAtLocal)}.
        </span>
      )}
    </div>
  );
}

// The Trip prep form -------------------------------------------------------------------------

const GENDERS = [
  { value: "female", label: "Female" },
  { value: "male", label: "Male" },
  { value: "x", label: "X / unspecified" },
] as const;

function PrepForm({
  flight: f,
  onSaved,
}: {
  flight: FlightView;
  onSaved: (v: FlightView) => void;
}) {
  const need = new Set<PrepKey>([...f.prep.required, ...f.prep.optional]);
  const [v, setV] = useState<PrepAnswers>({
    seatSide: "any",
    seatZone: "any",
    seatEmptyNearby: false,
    seatAvoidWashroom: false,
  });
  const [answer, setAnswer] = useState("");
  const [noBanned, setNoBanned] = useState(f.prep.noBannedItems);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof PrepAnswers>(k: K, value: PrepAnswers[K]) =>
    setV((old) => ({ ...old, [k]: value }));
  const question =
    f.checkin.question ?? (f.arrival?.status === "waiting_for_you" ? f.arrival.question : null);

  async function save(e: FormEvent) {
    e.preventDefault();
    const out: PrepAnswers = {};
    if (need.has("name")) {
      out.firstName = v.firstName?.trim() ?? "";
      out.lastName = v.lastName?.trim() ?? "";
      if (v.middleName?.trim()) out.middleName = v.middleName.trim();
      if (!out.firstName || !out.lastName)
        return setError("Add your first and last name as on your ID.");
    }
    const copy = <K extends keyof PrepAnswers>(key: PrepKey, ...fields: K[]) => {
      if (!need.has(key)) return;
      for (const k of fields) if (v[k] !== undefined && v[k] !== "") out[k] = v[k];
    };
    copy("dateOfBirth", "dateOfBirth");
    copy("gender", "gender");
    copy("nationality", "nationality");
    copy("passportNumber", "passportNumber");
    copy("passportExpiry", "passportExpiry");
    // Left empty: not asked again (the leave reminder then allows an hour to get there).
    // Optional ones are asked once: left empty means "I don't have one".
    if (need.has("knownTraveler")) out.knownTravelerNumber = v.knownTravelerNumber?.trim() || null;
    if (need.has("frequentFlyer")) out.frequentFlyerNumber = v.frequentFlyerNumber?.trim() || null;
    if (need.has("seatStyle")) {
      out.seatSide = v.seatSide;
      out.seatZone = v.seatZone;
      out.seatEmptyNearby = v.seatEmptyNearby;
      out.seatAvoidWashroom = v.seatAvoidWashroom;
    }
    if (question && answer.trim()) out.answer = answer.trim();
    if (noBanned !== f.prep.noBannedItems) out.noBannedItems = noBanned;
    setSaving(true);
    setError(null);
    try {
      onSaved((await api.saveFlightPrep(f.id, out)).flight);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't save. Try again.");
    } finally {
      setSaving(false);
    }
  }

  const ffName = f.prep.airlineCode
    ? `${f.airlineName} frequent flyer number`
    : "Frequent flyer number";
  return (
    <form className="trip-prep" onSubmit={save} aria-label="Trip prep">
      {f.prep.warnings.map((w) => (
        <p key={w} className="trip-warn" role="alert">
          {w}
        </p>
      ))}
      {question && (
        <Field label={question}>
          <input
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            maxLength={500}
            required
          />
        </Field>
      )}
      {need.has("name") && (
        <div className="trip-row">
          <Field label="First name (as on your ID)">
            <input
              value={v.firstName ?? ""}
              onChange={(e) => set("firstName", e.target.value)}
              autoComplete="given-name"
              maxLength={60}
            />
          </Field>
          <Field label="Last name">
            <input
              value={v.lastName ?? ""}
              onChange={(e) => set("lastName", e.target.value)}
              autoComplete="family-name"
              maxLength={60}
            />
          </Field>
        </div>
      )}
      {need.has("name") && (
        <Field label="Middle name, if it's on your ID">
          <input
            value={v.middleName ?? ""}
            onChange={(e) => set("middleName", e.target.value)}
            autoComplete="additional-name"
            maxLength={60}
          />
        </Field>
      )}
      {(need.has("dateOfBirth") || need.has("gender")) && (
        <div className="trip-row">
          {need.has("dateOfBirth") && (
            <Field label="Date of birth">
              <input
                type="date"
                value={v.dateOfBirth ?? ""}
                onChange={(e) => set("dateOfBirth", e.target.value)}
                autoComplete="bday"
              />
            </Field>
          )}
          {need.has("gender") && (
            <Field label="Gender (as on your ID)">
              <select
                value={v.gender ?? ""}
                onChange={(e) =>
                  set("gender", (e.target.value || undefined) as PrepAnswers["gender"])
                }
              >
                <option value="">Choose</option>
                {GENDERS.map((g) => (
                  <option key={g.value} value={g.value}>
                    {g.label}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
      )}
      {need.has("nationality") && (
        <Field label="Nationality (the passport you'll travel on)">
          <select
            value={v.nationality ?? ""}
            onChange={(e) => set("nationality", e.target.value || undefined)}
          >
            <option value="">Choose a country</option>
            {countries().map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      {(need.has("passportNumber") || need.has("passportExpiry")) && (
        <div className="trip-row">
          {need.has("passportNumber") && (
            <Field label="Passport number">
              <input
                placeholder="As on your passport"
                value={v.passportNumber ?? ""}
                onChange={(e) => set("passportNumber", e.target.value)}
                autoComplete="off"
                spellCheck={false}
                maxLength={30}
              />
            </Field>
          )}
          {need.has("passportExpiry") && (
            <Field label="Passport expiry date">
              <input
                type="date"
                value={v.passportExpiry ?? ""}
                onChange={(e) => set("passportExpiry", e.target.value)}
              />
            </Field>
          )}
        </div>
      )}
      {need.has("knownTraveler") && (
        <Field label="TSA PreCheck or Global Entry number">
          <input
            placeholder="Optional"
            value={v.knownTravelerNumber ?? ""}
            onChange={(e) => set("knownTravelerNumber", e.target.value)}
            autoComplete="off"
            spellCheck={false}
            maxLength={30}
          />
        </Field>
      )}
      {need.has("frequentFlyer") && (
        <Field label={ffName}>
          <input
            placeholder="Optional"
            value={v.frequentFlyerNumber ?? ""}
            onChange={(e) => set("frequentFlyerNumber", e.target.value)}
            autoComplete="off"
            spellCheck={false}
            maxLength={40}
          />
        </Field>
      )}
      {need.has("seatStyle") && (
        <fieldset className="trip-seat">
          <legend>Your seat style (free seats only)</legend>
          <Choice
            label="Seat"
            value={v.seatSide!}
            options={[
              ["window", "Window"],
              ["aisle", "Aisle"],
              ["any", "Either"],
            ]}
            onPick={(x) => set("seatSide", x as PrepAnswers["seatSide"])}
          />
          <Choice
            label="Part of the plane"
            value={v.seatZone!}
            options={[
              ["front", "Front"],
              ["middle", "Middle"],
              ["back", "Back"],
              ["any", "Any"],
            ]}
            onPick={(x) => set("seatZone", x as PrepAnswers["seatZone"])}
          />
          <label className="bsign-check">
            <input
              type="checkbox"
              checked={!!v.seatEmptyNearby}
              onChange={(e) => set("seatEmptyNearby", e.target.checked)}
            />
            Empty seats next to me if possible
          </label>
          <label className="bsign-check">
            <input
              type="checkbox"
              checked={!!v.seatAvoidWashroom}
              onChange={(e) => set("seatAvoidWashroom", e.target.checked)}
            />
            Away from the washrooms
          </label>
        </fieldset>
      )}
      {!f.prep.noBannedItems && (
        <label className="bsign-check trip-banned">
          <input
            type="checkbox"
            checked={noBanned}
            onChange={(e) => setNoBanned(e.target.checked)}
          />
          I&apos;m not carrying any banned items in my bags (the airline asks this at check-in)
        </label>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="btn btn-primary btn-small btn-block" disabled={saving}>
        {saving ? "Saving…" : "Save"}
      </button>
      {f.prep.have.length > 0 && (
        <p className="trip-note">Already have: {f.prep.have.join(", ")}.</p>
      )}
    </form>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="trip-field">
      <span>
        {label}
        {hint && <span className="trip-hint"> · {hint}</span>}
      </span>
      {children}
    </label>
  );
}

function Choice({
  label,
  value,
  options,
  onPick,
}: {
  label: string;
  value: string;
  options: [string, string][];
  onPick: (value: string) => void;
}) {
  return (
    <div className="trip-choice" role="radiogroup" aria-label={label}>
      {options.map(([v, text]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          className={value === v ? "is-on" : ""}
          onClick={() => onPick(v)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}
