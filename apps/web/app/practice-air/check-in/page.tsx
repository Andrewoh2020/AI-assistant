"use client";

import { useMemo, useState } from "react";
import { Chrome } from "../Chrome";

/**
 * Practice Air's online check-in, laid out like a budget airline's: find the booking, passenger
 * and passport details (dates as day / month / year menus), the restricted items declaration, a
 * seat map where most seats cost money, extras with travel insurance already ticked, a payment
 * page for anything paid, and the boarding pass.
 */

interface Booking {
  token: string;
  reference: string;
  flight: {
    number: string | null;
    fromCode: string | null;
    fromCity: string | null;
    toCode: string | null;
    toCity: string | null;
    departLocal: string | null;
    arriveLocal: string | null;
  };
  passenger: { firstName: string | null; lastName: string | null };
  checkin: "open" | "not_open" | "closed";
  opensLocal: string | null;
  checkedIn: { seat: string; boardingPass: string } | null;
  taken: string[];
}

type Step = "find" | "details" | "declaration" | "seat" | "extras" | "payment" | "done";

const COUNTRIES = [
  "Australia",
  "Bangladesh",
  "Brunei",
  "Cambodia",
  "Canada",
  "China",
  "France",
  "Germany",
  "Hong Kong",
  "India",
  "Indonesia",
  "Ireland",
  "Italy",
  "Japan",
  "Laos",
  "Malaysia",
  "Mexico",
  "Myanmar",
  "Netherlands",
  "New Zealand",
  "Pakistan",
  "Philippines",
  "Singapore",
  "South Korea",
  "Spain",
  "Sri Lanka",
  "Switzerland",
  "Taiwan",
  "Thailand",
  "United Arab Emirates",
  "United Kingdom",
  "United States",
  "Vietnam",
];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const ROWS = 31;
const LETTERS = ["A", "B", "C", "D", "E", "F"];
const seatPrice = (row: number) => (row <= 4 ? 28 : row <= 19 ? 11 : 0);
const EXTRAS = [
  { id: "bag20", name: "20 kg checked bag", price: 32, note: "Save 50% vs the airport" },
  {
    id: "insurance",
    name: "Travel insurance",
    price: 9,
    note: "Cover for delays and medical costs",
  },
  { id: "priority", name: "Priority boarding", price: 8, note: "Board first, settle in sooner" },
  { id: "meal", name: "Hot meal", price: 7, note: "Pre-order and save" },
];

const nice = (local: string | null) => {
  if (!local) return "";
  const [y, m, d] = local.slice(0, 10).split("-").map(Number) as [number, number, number];
  return `${d} ${MONTHS[m - 1]!.slice(0, 3)} ${y}, ${local.slice(11, 16)}`;
};

async function post<T>(path: string, body: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(`/api/practice-air/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as T };
}

function DateMenus({
  label,
  value,
  onChange,
  years,
}: {
  label: string;
  value: { d: string; m: string; y: string };
  onChange: (v: { d: string; m: string; y: string }) => void;
  years: number[];
}) {
  return (
    <fieldset className="pa-field">
      <legend>{label}</legend>
      <div className="pa-row">
        <select
          aria-label={`${label}: day`}
          value={value.d}
          onChange={(e) => onChange({ ...value, d: e.target.value })}
        >
          <option value="">Day</option>
          {Array.from({ length: 31 }, (_, i) => (
            <option key={i} value={String(i + 1).padStart(2, "0")}>
              {i + 1}
            </option>
          ))}
        </select>
        <select
          aria-label={`${label}: month`}
          value={value.m}
          onChange={(e) => onChange({ ...value, m: e.target.value })}
        >
          <option value="">Month</option>
          {MONTHS.map((name, i) => (
            <option key={name} value={String(i + 1).padStart(2, "0")}>
              {name}
            </option>
          ))}
        </select>
        <select
          aria-label={`${label}: year`}
          value={value.y}
          onChange={(e) => onChange({ ...value, y: e.target.value })}
        >
          <option value="">Year</option>
          {years.map((y) => (
            <option key={y} value={String(y)}>
              {y}
            </option>
          ))}
        </select>
      </div>
    </fieldset>
  );
}

const emptyDate = { d: "", m: "", y: "" };
const iso = (v: { d: string; m: string; y: string }) =>
  v.d && v.m && v.y ? `${v.y}-${v.m}-${v.d}` : "";

export default function PracticeCheckin() {
  const [step, setStep] = useState<Step>("find");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reference, setReference] = useState("");
  const [lastName, setLastName] = useState("");
  const [booking, setBooking] = useState<Booking | null>(null);
  const [p, setP] = useState({
    firstName: "",
    lastName: "",
    gender: "",
    nationality: "",
    passportNumber: "",
    passportCountry: "",
  });
  const [dob, setDob] = useState(emptyDate);
  const [expiry, setExpiry] = useState(emptyDate);
  const [declared, setDeclared] = useState(false);
  const [seat, setSeat] = useState<string | null>(null);
  const [extras, setExtras] = useState<string[]>(["insurance"]);
  const [cost, setCost] = useState(0);
  const [done, setDone] = useState<{ seat: string; boardingPass: string } | null>(null);
  const thisYear = new Date().getFullYear();
  const taken = useMemo(() => new Set(booking?.taken ?? []), [booking]);

  const find = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { status, data } = await post<Booking & { error?: string }>("lookup", {
      reference,
      lastName,
    });
    setBusy(false);
    if (status !== 200) return setError(data.error ?? "Something went wrong. Try again.");
    setBooking(data);
    setP((x) => ({
      ...x,
      firstName: data.passenger.firstName ?? "",
      lastName: data.passenger.lastName ?? "",
    }));
    if (data.checkedIn) {
      setDone(data.checkedIn);
      setStep("done");
    } else if (data.checkin === "open") setStep("details");
  };

  const details = (e: React.FormEvent) => {
    e.preventDefault();
    const missing = [
      !p.firstName && "first name",
      !p.lastName && "last name",
      !iso(dob) && "date of birth",
      !p.gender && "gender",
      !p.nationality && "nationality",
      !p.passportNumber && "passport number",
      !p.passportCountry && "issuing country",
      !iso(expiry) && "passport expiry date",
    ].filter(Boolean);
    if (missing.length) return setError(`Please fill in: ${missing.join(", ")}.`);
    setError(null);
    setStep("declaration");
  };

  const seatCost = seat ? seatPrice(Number(seat.slice(0, -1))) : 0;
  const extrasCost = EXTRAS.filter((x) => extras.includes(x.id)).reduce((s, x) => s + x.price, 0);

  const submit = async () => {
    if (!booking) return;
    setBusy(true);
    setError(null);
    const { status, data } = await post<{
      seat?: string;
      boardingPass?: string;
      error?: string;
      cost?: number;
    }>("check-in", {
      token: booking.token,
      ...p,
      dateOfBirth: iso(dob),
      passportExpiry: iso(expiry),
      restrictedItems: declared,
      seat,
      extras,
    });
    setBusy(false);
    if (status === 402) {
      setCost(data.cost ?? seatCost + extrasCost);
      return setStep("payment");
    }
    if (status !== 200) return setError(data.error ?? "Something went wrong. Try again.");
    setDone({ seat: data.seat!, boardingPass: data.boardingPass! });
    setStep("done");
  };

  const f = booking?.flight;
  const summary = f && (
    <div className="pa-card pa-flight">
      <div>
        <strong>{f.number}</strong> · Booking {booking!.reference}
      </div>
      <div className="pa-route">
        {f.fromCity} ({f.fromCode}) → {f.toCity} ({f.toCode})
      </div>
      <div className="pa-muted">Departs {nice(f.departLocal)} local time</div>
    </div>
  );

  return (
    <Chrome>
      <h1 className="pa-title">Online check-in</h1>
      {step !== "find" && step !== "done" && (
        <ol className="pa-steps" aria-label="Check-in steps">
          {(["details", "declaration", "seat", "extras"] as const).map((s, i) => (
            <li key={s} className={s === step ? "pa-step-on" : ""}>
              {i + 1}. {["Passenger", "Declaration", "Seat", "Extras"][i]}
            </li>
          ))}
        </ol>
      )}
      {summary}
      {error && (
        <p className="pa-error" role="alert">
          {error}
        </p>
      )}

      {step === "find" && (
        <form className="pa-card pa-form" onSubmit={find}>
          <p>Online check-in opens 24 hours and closes 1 hour before departure.</p>
          <label className="pa-field">
            Booking number
            <input
              name="bookingNumber"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="e.g. A1B2C3"
              autoComplete="off"
            />
          </label>
          <label className="pa-field">
            Last name
            <input
              name="lastName"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              autoComplete="off"
            />
          </label>
          <button className="pa-btn" disabled={busy}>
            {busy ? "Searching…" : "Find my booking"}
          </button>
          {booking?.checkin === "not_open" && (
            <p className="pa-error" role="alert">
              Check-in for this flight isn&apos;t open yet. It opens on {nice(booking.opensLocal)}{" "}
              local time.
            </p>
          )}
          {booking?.checkin === "closed" && (
            <p className="pa-error" role="alert">
              Online check-in has closed for this flight. Please check in at the airport counter.
            </p>
          )}
        </form>
      )}

      {step === "details" && (
        <form className="pa-card pa-form" onSubmit={details}>
          <h2>Passenger details</h2>
          <p className="pa-muted">Enter your details exactly as they appear in your passport.</p>
          <div className="pa-row">
            <label className="pa-field">
              First / given name
              <input
                name="firstName"
                value={p.firstName}
                onChange={(e) => setP({ ...p, firstName: e.target.value })}
              />
            </label>
            <label className="pa-field">
              Last / family name
              <input
                name="lastName"
                value={p.lastName}
                onChange={(e) => setP({ ...p, lastName: e.target.value })}
              />
            </label>
          </div>
          <DateMenus
            label="Date of birth"
            value={dob}
            onChange={setDob}
            years={Array.from({ length: 100 }, (_, i) => thisYear - i)}
          />
          <fieldset className="pa-field">
            <legend>Gender</legend>
            <div className="pa-row">
              {["Male", "Female"].map((g) => (
                <label key={g} className="pa-radio">
                  <input
                    type="radio"
                    name="gender"
                    value={g.toLowerCase()}
                    checked={p.gender === g.toLowerCase()}
                    onChange={() => setP({ ...p, gender: g.toLowerCase() })}
                  />
                  {g}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="pa-field">
            Nationality
            <select
              name="nationality"
              value={p.nationality}
              onChange={(e) => setP({ ...p, nationality: e.target.value })}
            >
              <option value="">Select</option>
              {COUNTRIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <h2>Passport</h2>
          <label className="pa-field">
            Passport number
            <input
              name="passportNumber"
              value={p.passportNumber}
              onChange={(e) => setP({ ...p, passportNumber: e.target.value })}
              autoComplete="off"
            />
          </label>
          <label className="pa-field">
            Issuing country
            <select
              name="passportCountry"
              value={p.passportCountry}
              onChange={(e) => setP({ ...p, passportCountry: e.target.value })}
            >
              <option value="">Select</option>
              {COUNTRIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <DateMenus
            label="Passport expiry date"
            value={expiry}
            onChange={setExpiry}
            years={Array.from({ length: 15 }, (_, i) => thisYear + i)}
          />
          <button className="pa-btn">Continue</button>
        </form>
      )}

      {step === "declaration" && (
        <div className="pa-card pa-form">
          <h2>Restricted items</h2>
          <p>
            For everyone&apos;s safety, these items are not allowed on board or in checked bags:
          </p>
          <ul className="pa-list">
            <li>Explosives, fireworks and flares</li>
            <li>Flammable liquids and gases, including lighter refills</li>
            <li>Power banks over 160 Wh, and any power bank in checked bags</li>
            <li>Corrosives, poisons and radioactive material</li>
          </ul>
          <label className="pa-check">
            <input
              type="checkbox"
              checked={declared}
              onChange={(e) => setDeclared(e.target.checked)}
            />
            I confirm that I&apos;m not carrying any of these items.
          </label>
          <div className="pa-row">
            <button className="pa-btn pa-btn-ghost" onClick={() => setStep("details")}>
              Back
            </button>
            <button className="pa-btn" disabled={!declared} onClick={() => setStep("seat")}>
              Continue
            </button>
          </div>
        </div>
      )}

      {step === "seat" && (
        <div className="pa-card pa-form">
          <h2>Choose your seat</h2>
          <div className="pa-legend">
            <span>
              <i className="pa-seat pa-hot" /> Hot seat USD 28
            </span>
            <span>
              <i className="pa-seat pa-std" /> Standard USD 11
            </span>
            <span>
              <i className="pa-seat pa-free" /> Free
            </span>
            <span>
              <i className="pa-seat pa-taken" /> Taken
            </span>
          </div>
          <p className="pa-muted">
            Front of the plane is row 1. Seats A and F are windows; C and D are aisles. Toilets are
            behind row 31.
          </p>
          <div className="pa-map" role="grid" aria-label="Seat map">
            {Array.from({ length: ROWS }, (_, r) => r + 1).map((row) => (
              <div key={row} className="pa-map-row" role="row">
                <span className="pa-map-n">{row}</span>
                {LETTERS.map((l) => {
                  const id = `${row}${l}`;
                  const price = seatPrice(row);
                  const isTaken = taken.has(id);
                  return (
                    <button
                      key={id}
                      role="gridcell"
                      aria-label={`Seat ${id}, ${isTaken ? "taken" : price ? `USD ${price}` : "free"}`}
                      aria-pressed={seat === id}
                      disabled={isTaken}
                      className={`pa-seat ${isTaken ? "pa-taken" : price === 28 ? "pa-hot" : price ? "pa-std" : "pa-free"} ${seat === id ? "pa-seat-on" : ""} ${l === "C" ? "pa-aisle" : ""}`}
                      onClick={() => setSeat(seat === id ? null : id)}
                    >
                      {l}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          <p>
            {seat
              ? `Seat ${seat}: ${seatCost ? `USD ${seatCost}` : "free"}`
              : "No seat chosen. We'll give you a seat for free at check-in."}
          </p>
          <div className="pa-row">
            <button
              className="pa-btn pa-btn-ghost"
              onClick={() => {
                setSeat(null);
                setStep("extras");
              }}
            >
              Skip, give me any seat for free
            </button>
            <button className="pa-btn" onClick={() => setStep("extras")}>
              Continue
            </button>
          </div>
        </div>
      )}

      {step === "extras" && (
        <div className="pa-card pa-form">
          <h2>Make your trip better</h2>
          {EXTRAS.map((x) => (
            <label key={x.id} className="pa-check pa-extra">
              <input
                type="checkbox"
                checked={extras.includes(x.id)}
                onChange={(e) =>
                  setExtras(e.target.checked ? [...extras, x.id] : extras.filter((y) => y !== x.id))
                }
              />
              <span>
                <strong>{x.name}</strong> USD {x.price}
                <br />
                <span className="pa-muted">{x.note}</span>
              </span>
            </label>
          ))}
          <p>
            <strong>Total: USD {seatCost + extrasCost}</strong>
          </p>
          <div className="pa-row">
            <button className="pa-btn pa-btn-ghost" onClick={() => setStep("seat")}>
              Back
            </button>
            <button className="pa-btn" disabled={busy} onClick={submit}>
              {busy ? "Checking in…" : seatCost + extrasCost ? `Continue to payment` : "Check in"}
            </button>
          </div>
        </div>
      )}

      {step === "payment" && (
        <div className="pa-card pa-form">
          <h2>Payment</h2>
          <p>Pay USD {cost} for your seat and extras to finish checking in.</p>
          <label className="pa-field">
            Card number
            <input
              autoComplete="off"
              disabled
              placeholder="Payments are switched off on this practice site"
            />
          </label>
          <div className="pa-row">
            <button className="pa-btn pa-btn-ghost" onClick={() => setStep("extras")}>
              Back to extras
            </button>
            <button className="pa-btn" disabled>
              Pay USD {cost}
            </button>
          </div>
        </div>
      )}

      {step === "done" && done && f && (
        <div className="pa-card pa-form">
          <h2>You&apos;re checked in</h2>
          <div className="pa-pass">
            <div>
              <span className="pa-muted">Passenger</span>
              <strong>
                {p.lastName.toUpperCase() || booking?.passenger.lastName?.toUpperCase()}/
                {p.firstName.toUpperCase() || booking?.passenger.firstName?.toUpperCase()}
              </strong>
            </div>
            <div>
              <span className="pa-muted">Flight</span>
              <strong>{f.number}</strong>
            </div>
            <div>
              <span className="pa-muted">Date</span>
              <strong>{f.departLocal?.slice(0, 10)}</strong>
            </div>
            <div>
              <span className="pa-muted">Seat</span>
              <strong>{done.seat}</strong>
            </div>
            <div>
              <span className="pa-muted">Group</span>
              <strong>3</strong>
            </div>
          </div>
          <a className="pa-btn" href={done.boardingPass} download="boarding-pass.pdf">
            Download boarding pass (PDF)
          </a>
        </div>
      )}
    </Chrome>
  );
}
