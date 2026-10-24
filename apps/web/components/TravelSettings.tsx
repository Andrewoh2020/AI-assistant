"use client";

import {
  ApiError,
  type PrepAnswers,
  type TravelDocumentsView,
  type TravelProfileView,
} from "@ai-assistant/api-client";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { api } from "@/lib/client";
import { countries } from "@/lib/travel";

/**
 * Settings › Travel details: what trip cards collected, given once and kept. Click straight into a
 * field to change it; it saves when you leave it (Enter saves too, Escape undoes). Passport and
 * other numbers are shown in full: they are the person's own, and a wrong one can cost a flight.
 * They live in the vault, and the assistant never sees them.
 */

type Edit = PrepAnswers & { frequentFlyer?: Record<string, string | null>; removeAnswer?: string };

export function TravelPage() {
  const [profile, setProfile] = useState<TravelProfileView | null>(null);
  const [docs, setDocs] = useState<TravelDocumentsView | null>(null);
  const [status, setStatus] = useState<"saving" | "saved" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    Promise.all([api.travelProfile(), api.revealTravelDocuments()])
      .then(([r, d]) => {
        setDocs(d.documents);
        setProfile(r.profile);
      })
      .catch(() => setError("Couldn't load your travel details."));
    return () => clearTimeout(flashTimer.current);
  }, []);

  async function save(change: Edit) {
    setStatus("saving");
    setError(null);
    try {
      const { profile: next } = await api.editTravelProfile(change);
      setProfile(next);
      // Keep shown numbers in step with what was saved.
      if (docs) {
        setDocs({
          ...docs,
          ...(change.passportNumber !== undefined && {
            passportNumber: change.passportNumber || undefined,
          }),
          ...(change.knownTravelerNumber !== undefined && {
            knownTravelerNumber: change.knownTravelerNumber || undefined,
          }),
          ...(change.frequentFlyer && {
            frequentFlyer: Object.fromEntries(
              Object.entries({ ...docs.frequentFlyer, ...change.frequentFlyer }).filter(
                (e): e is [string, string] => !!e[1],
              ),
            ),
          }),
        });
      }
      setStatus("saved");
      clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setStatus(null), 1500);
      return true;
    } catch (err) {
      setStatus(null);
      setError(err instanceof ApiError ? err.message : "That didn't save. Try again.");
      return false;
    }
  }

  if (!profile) {
    return error ? (
      <p className="form-error" role="alert">
        {error}
      </p>
    ) : (
      <p className="group-note">Loading…</p>
    );
  }
  const p = profile;
  return (
    <>
      <p className="group-note">
        Trip cards ask for these once, then check you in with them. Change anything by clicking it.
      </p>
      <div className="group">
        <TextRow label="First name" value={p.firstName} onSave={(v) => save({ firstName: v })} />
        <TextRow label="Middle name" value={p.middleName} onSave={(v) => save({ middleName: v })} />
        <TextRow label="Last name" value={p.lastName} onSave={(v) => save({ lastName: v })} />
        <TextRow
          label="Date of birth"
          type="date"
          value={p.dateOfBirth}
          onSave={(v) => save({ dateOfBirth: v })}
        />
        <SelectRow
          label="Gender (as on your ID)"
          value={p.gender}
          options={[
            ["female", "Female"],
            ["male", "Male"],
            ["x", "X / unspecified"],
          ]}
          onSave={(v) => save({ gender: v as PrepAnswers["gender"] })}
        />
        <SelectRow
          label="Nationality"
          value={p.nationality}
          options={countries().map((c) => [c.code, c.name])}
          onSave={(v) => save({ nationality: v })}
        />
      </div>

      <div className="group">
        <TextRow
          label="Passport number"
          value={docs?.passportNumber ?? null}
          onSave={(v) => save({ passportNumber: v })}
        />
        <TextRow
          label="Passport expiry date"
          type="date"
          value={p.passportExpiry}
          onSave={(v) => save({ passportExpiry: v })}
        />
        <TextRow
          label="TSA PreCheck or Global Entry number"
          value={docs?.knownTravelerNumber ?? null}
          onSave={(v) => save({ knownTravelerNumber: v || null })}
        />
        {p.frequentFlyerAirlines.map((code) => (
          <TextRow
            key={code}
            label={`Frequent flyer number (${code})`}
            value={docs?.frequentFlyer?.[code] ?? null}
            onSave={(v) => save({ frequentFlyer: { [code]: v || null } })}
          />
        ))}
      </div>

      <div className="group">
        <TextRow
          label="Where you leave for the airport from"
          value={p.homeAddress}
          onSave={(v) => save({ homeAddress: v })}
        />
        <SelectRow
          label="Seat"
          value={p.seatSide}
          options={[
            ["window", "Window"],
            ["aisle", "Aisle"],
            ["any", "Either"],
          ]}
          onSave={(v) => save({ seatSide: v as PrepAnswers["seatSide"] })}
        />
        <SelectRow
          label="Part of the plane"
          value={p.seatZone}
          options={[
            ["front", "Front"],
            ["middle", "Middle"],
            ["back", "Back"],
            ["any", "Any"],
          ]}
          onSave={(v) => save({ seatZone: v as PrepAnswers["seatZone"] })}
        />
        <CheckRow
          label="Empty seats next to me if possible"
          value={!!p.seatEmptyNearby}
          onSave={(v) => save({ seatEmptyNearby: v })}
        />
        <CheckRow
          label="Away from the washrooms"
          value={!!p.seatAvoidWashroom}
          onSave={(v) => save({ seatAvoidWashroom: v })}
        />
      </div>

      {p.answers.length > 0 && (
        <>
          <p className="group-note">Answers you gave to airlines&apos; questions</p>
          <div className="group">
            {p.answers.map((a) => (
              <div key={a.question} className="row row-static row-secret">
                <span className="row-text">
                  <span className="row-sub">{a.question}</span>
                  <span>{a.answer}</span>
                </span>
                <span className="row-actions">
                  <button
                    type="button"
                    className="bsign-alt"
                    onClick={() => void save({ removeAnswer: a.question })}
                  >
                    Remove
                  </button>
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : (
        status && (
          <p className="field-status" role="status">
            {status === "saving" ? "Saving…" : "Saved"}
          </p>
        )
      )}
    </>
  );
}

/** Enter saves, Escape puts back what was there (instead of closing Settings). */
function keys(undo: () => void) {
  return (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") e.currentTarget.blur();
    if (e.key === "Escape") {
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation();
      const input = e.currentTarget;
      undo();
      setTimeout(() => input.blur());
    }
  };
}

function TextRow({
  label,
  value,
  type = "text",
  onSave,
}: {
  label: string;
  value: string | null;
  type?: "text" | "date";
  onSave: (value: string) => Promise<boolean>;
}) {
  const [text, setText] = useState(value ?? "");
  const undone = useRef(false);
  useEffect(() => setText(value ?? ""), [value]);
  return (
    <label className="row row-static row-detail row-field">
      <span className="row-sub">{label}</span>
      <input
        className="field-inline"
        type={type}
        value={text}
        placeholder="Not added"
        onChange={(e) => setText(e.target.value)}
        onBlur={async () => {
          if (undone.current) {
            undone.current = false;
            return;
          }
          if (text.trim() === (value ?? "")) return;
          if (!(await onSave(text.trim()))) setText(value ?? "");
        }}
        onKeyDown={keys(() => {
          undone.current = true;
          setText(value ?? "");
        })}
        autoComplete="off"
        maxLength={300}
      />
    </label>
  );
}

function SelectRow({
  label,
  value,
  options,
  onSave,
}: {
  label: string;
  value: string | null;
  options: [string, string][];
  onSave: (value: string) => Promise<boolean>;
}) {
  return (
    <label className="row row-static row-detail row-field">
      <span className="row-sub">{label}</span>
      <select
        className="field-inline"
        value={value ?? ""}
        onChange={(e) => void onSave(e.target.value)}
      >
        {!value && <option value="">Not added</option>}
        {options.map(([v, text]) => (
          <option key={v} value={v}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}

function CheckRow({
  label,
  value,
  onSave,
}: {
  label: string;
  value: boolean;
  onSave: (value: boolean) => Promise<boolean>;
}) {
  return (
    <label className="row row-static bsign-check">
      <input type="checkbox" checked={value} onChange={(e) => void onSave(e.target.checked)} />
      {label}
    </label>
  );
}
