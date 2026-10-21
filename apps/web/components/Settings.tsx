"use client";

import { ApiError, type VaultEvent, type VaultLogin } from "@ai-assistant/api-client";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "@/lib/client";

/**
 * Settings, Muse style: a sheet over the chat with grouped white lists, a centered title and a
 * round close button. Rows push to a detail page with a back chevron. For now it holds the
 * Secure credentials store (the vault); the other rows arrive with their features.
 */

type Page = { name: "home" } | { name: "vault" } | { name: "login"; id: string };

export function Settings({
  start = "home",
  onClose,
  onSignOut,
}: {
  start?: "home" | "vault";
  onClose: () => void;
  onSignOut: () => void;
}) {
  const [page, setPage] = useState<Page>(start === "vault" ? { name: "vault" } : { name: "home" });
  const [logins, setLogins] = useState<VaultLogin[] | null>(null);
  const [activity, setActivity] = useState<VaultEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    try {
      const v = await api.vault();
      setLogins(v.logins);
      setActivity(v.activity);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load your saved logins.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Escape closes; focus starts on the close button.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    closeRef.current?.focus();
  }, [page]);

  const login = page.name === "login" ? logins?.find((l) => l.id === page.id) : undefined;
  const back: Page | null =
    page.name === "vault" ? { name: "home" } : page.name === "home" ? null : { name: "vault" };
  const title =
    page.name === "home"
      ? "Settings"
      : page.name === "vault"
        ? "Secure credentials store"
        : (login?.site ?? "Saved login");

  return (
    <div className="sheet-scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <header className="sheet-head">
          {back ? (
            <button
              type="button"
              className="sheet-back"
              onClick={() => setPage(back)}
              aria-label={back.name === "home" ? "Back to Settings" : "Back to saved logins"}
            >
              <ChevronLeft />
            </button>
          ) : (
            <span />
          )}
          <h2>{title}</h2>
          <button
            ref={closeRef}
            type="button"
            className="sheet-close"
            onClick={onClose}
            aria-label="Close settings"
          >
            <CloseIcon />
          </button>
        </header>
        <div className="sheet-body">
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          {page.name === "home" && (
            <>
              <div className="group">
                <Row
                  icon={<VaultIcon />}
                  label="Secure credentials store"
                  sub={
                    logins === null
                      ? "Saved logins"
                      : logins.length === 1
                        ? "1 saved login"
                        : `${logins.length} saved logins`
                  }
                  onClick={() => setPage({ name: "vault" })}
                />
              </div>
              <div className="group">
                <button type="button" className="row row-danger" onClick={onSignOut}>
                  Log out
                </button>
              </div>
            </>
          )}
          {page.name === "vault" && (
            <VaultPage
              logins={logins}
              activity={activity}
              onPick={(id) => setPage({ name: "login", id })}
            />
          )}
          {page.name === "login" &&
            (login ? (
              <LoginPage
                key={login.id}
                login={login}
                activity={activity.filter(
                  (e) => e.site === login.site && (e.account ?? "") === login.account,
                )}
                onChanged={load}
                onDeleted={async () => {
                  await load();
                  setPage({ name: "vault" });
                }}
              />
            ) : (
              logins && <p className="group-note">This login has been deleted.</p>
            ))}
        </div>
      </section>
    </div>
  );
}

function VaultPage({
  logins,
  activity,
  onPick,
}: {
  logins: VaultLogin[] | null;
  activity: VaultEvent[];
  onPick: (id: string) => void;
}) {
  return (
    <>
      <p className="group-intro">
        Logins the assistant can use but never see. When a site asks you to sign in, the browser
        fills in the saved login by itself, only on the site it was saved for.
      </p>
      <h3 className="group-title">Saved logins</h3>
      <div className="group">
        {logins === null ? (
          <p className="row row-static">
            <span className="dots" />
          </p>
        ) : logins.length === 0 ? (
          <p className="row row-static row-empty">
            No saved logins yet. When the browser asks you to sign in, leave &quot;Save for next
            time&quot; ticked and the login is kept here.
          </p>
        ) : (
          logins.map((l) => (
            <Row
              key={l.id}
              icon={<SiteBadge site={l.site} />}
              label={l.site}
              sub={[
                l.account || "Password only",
                stateOf(l),
                l.hasCodeKey ? "2-step key saved" : null,
              ]
                .filter(Boolean)
                .join(" · ")}
              onClick={() => onPick(l.id)}
            />
          ))
        )}
      </div>
      {activity.length > 0 && (
        <>
          <h3 className="group-title">Activity</h3>
          <ul className="group activity">
            {activity.slice(0, 20).map((e) => (
              <li key={e.id} className="row row-static">
                <span>{eventText(e)}</span>
                <time dateTime={e.at}>{when(e.at)}</time>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="group-note">
        Only you can see, change or delete saved logins. Each one is locked with its own key. When a
        site needs it, it goes straight to the assistant&apos;s browser, which types it into that
        site the way a password manager would. The assistant itself never sees it.
      </p>
    </>
  );
}

function LoginPage({
  login,
  activity,
  onChanged,
  onDeleted,
}: {
  login: VaultLogin;
  activity: VaultEvent[];
  onChanged: () => Promise<void>;
  onDeleted: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [codeKey, setCodeKey] = useState("");
  const [addingKey, setAddingKey] = useState(false);

  async function run(work: () => Promise<unknown>, after: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await work();
      await after();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <SignInDetails login={login} onChanged={onChanged} />
      <div className="group">
        <Detail label="Used on" value={`${login.site} only`} />
        <Detail
          label="Added"
          value={`${
            login.source === "imported"
              ? `Imported${login.importedFrom ? ` from ${login.importedFrom}` : ""}`
              : "Typed in the sign-in box"
          }, ${when(login.savedAt)}`}
        />
        <Detail
          label="Last used"
          value={
            login.lastUsedAt
              ? `${when(login.lastUsedAt)}${stateOf(login) ? ` · ${stateOf(login)}` : ""}`
              : "Not yet"
          }
        />
      </div>
      <div className="group">
        <label className="row row-switch">
          <span className="row-text">
            <span className="row-label">Ask before using</span>
            <span className="row-sub">
              {login.askBeforeUse
                ? "The browser asks you in the sign-in box before using it."
                : "Fills in by itself on this site. Turn on for sensitive sites, like your bank."}
            </span>
          </span>
          <input
            type="checkbox"
            role="switch"
            className="switch"
            checked={login.askBeforeUse}
            disabled={busy}
            onChange={(e) =>
              void run(
                () => api.updateVaultLogin(login.id, { askBeforeUse: e.target.checked }),
                onChanged,
              )
            }
          />
        </label>
      </div>
      <h3 className="group-title">2-step codes</h3>
      <div className="group">
        {login.hasCodeKey ? (
          <div className="row row-static row-confirm">
            <p>
              The authenticator key is saved. When {login.site} asks for a 2-step code, the browser
              makes it and enters it, like your authenticator app would.
            </p>
            <div className="row-actions">
              <button
                type="button"
                className="btn btn-small btn-secondary"
                disabled={busy}
                onClick={() => void run(() => api.removeVaultCodeKey(login.id), onChanged)}
              >
                Remove key
              </button>
            </div>
          </div>
        ) : addingKey ? (
          <form
            className="row row-static row-confirm"
            onSubmit={(e) => {
              e.preventDefault();
              void run(
                () => api.saveVaultCodeKey(login.id, codeKey),
                async () => {
                  setCodeKey("");
                  setAddingKey(false);
                  await onChanged();
                },
              );
            }}
          >
            <label className="bsign-field">
              <span>Setup key or otpauth:// link</span>
              <input
                value={codeKey}
                onChange={(e) => setCodeKey(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                required
                maxLength={1000}
              />
            </label>
            <p className="row-sub">
              {login.site} shows this when you turn on 2-step sign-in (often under &quot;Can&apos;t
              scan the QR code?&quot;). This keeps both your password and your 2-step key in one
              place, so skip it for your most important accounts.
            </p>
            <div className="row-actions">
              <button type="submit" className="btn btn-small btn-accent" disabled={busy}>
                Save key
              </button>
              <button
                type="button"
                className="btn btn-small btn-secondary"
                disabled={busy}
                onClick={() => setAddingKey(false)}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <button type="button" className="row row-nav" onClick={() => setAddingKey(true)}>
            <span className="row-text">
              <span className="row-label">Add authenticator key</span>
              <span className="row-sub">
                The browser then enters 2-step codes itself instead of asking you.
              </span>
            </span>
            <ChevronRight />
          </button>
        )}
      </div>
      <div className="group">
        {confirming ? (
          <div className="row row-static row-confirm">
            <p>Delete the login for {login.site}? Next time the browser will ask you to sign in.</p>
            <div className="row-actions">
              <button
                type="button"
                className="btn btn-small btn-danger"
                disabled={busy}
                onClick={() => void run(() => api.deleteVaultLogin(login.id), onDeleted)}
              >
                Delete
              </button>
              <button
                type="button"
                className="btn btn-small btn-secondary"
                disabled={busy}
                onClick={() => setConfirming(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="row row-danger" onClick={() => setConfirming(true)}>
            Delete login
          </button>
        )}
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {activity.length > 0 && (
        <>
          <h3 className="group-title">Activity</h3>
          <ul className="group activity">
            {activity.slice(0, 20).map((e) => (
              <li key={e.id} className="row row-static">
                <span>{eventText(e)}</span>
                <time dateTime={e.at}>{when(e.at)}</time>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

/**
 * The saved username and password, for the person's own eyes: hidden until they press Show, and
 * editable. The assistant has no way to read these.
 */
function SignInDetails({
  login,
  onChanged,
}: {
  login: VaultLogin;
  onChanged: () => Promise<void>;
}) {
  const [shown, setShown] = useState<{ username: string; password: string } | null>(null);
  const [visible, setVisible] = useState(false);
  const [editing, setEditing] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function open() {
    if (shown) return shown;
    setBusy(true);
    setError(null);
    try {
      const l = await api.revealVaultLogin(login.id);
      setShown(l);
      return l;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't open this login. Try again.");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    const l = await open();
    if (!l) return;
    try {
      await navigator.clipboard.writeText(l.password);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Couldn't copy. Press Show and copy it yourself.");
    }
  }

  async function startEdit() {
    const l = await open();
    if (!l) return;
    setUsername(l.username);
    setPassword(l.password);
    setEditing(true);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.editVaultLogin(login.id, { username, password });
      setShown({ username: username.trim(), password });
      setEditing(false);
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't save. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const errorLine = error && (
    <p className="form-error" role="alert">
      {error}
    </p>
  );

  if (editing) {
    return (
      <>
        <form
          className="group"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="row row-static row-confirm">
            <label className="bsign-field">
              <span>Username or email</span>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                maxLength={1000}
              />
            </label>
            <label className="bsign-field">
              <span>Password</span>
              <span className="secret-input">
                <input
                  type={visible ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  spellCheck={false}
                  required
                  maxLength={1000}
                />
                <button type="button" className="bsign-alt" onClick={() => setVisible(!visible)}>
                  {visible ? "Hide" : "Show"}
                </button>
              </span>
            </label>
            <div className="row-actions">
              <button type="submit" className="btn btn-small btn-accent" disabled={busy}>
                {busy ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                className="btn btn-small btn-secondary"
                disabled={busy}
                onClick={() => setEditing(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        </form>
        {errorLine}
      </>
    );
  }

  return (
    <>
      <div className="group">
        <Detail label="Username" value={login.account || "None (password only)"} />
        <div className="row row-static row-secret">
          <span className="row-text">
            <span className="row-sub">Password</span>
            <span className={visible && shown ? "secret-value" : "secret-dots"}>
              {visible && shown ? shown.password : "••••••••••"}
            </span>
          </span>
          <span className="row-actions">
            <button
              type="button"
              className="bsign-alt"
              disabled={busy}
              onClick={async () => {
                if (visible) return setVisible(false);
                if (await open()) setVisible(true);
              }}
            >
              {visible ? "Hide" : "Show"}
            </button>
            <button type="button" className="bsign-alt" disabled={busy} onClick={() => void copy()}>
              {copied ? "Copied" : "Copy"}
            </button>
          </span>
        </div>
        <button
          type="button"
          className="row row-nav"
          disabled={busy}
          onClick={() => void startEdit()}
        >
          <span className="row-text">
            <span className="row-label">Edit username or password</span>
          </span>
          <ChevronRight />
        </button>
      </div>
      {errorLine}
    </>
  );
}

function Row({
  icon,
  label,
  sub,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  sub?: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className="row row-nav" onClick={onClick}>
      <span className="row-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="row-text">
        <span className="row-label">{label}</span>
        {sub && <span className="row-sub">{sub}</span>}
      </span>
      <ChevronRight />
    </button>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="row row-static row-detail">
      <span className="row-sub">{label}</span>
      <span>{value}</span>
    </div>
  );
}

/** The saved login's state, in the plan's three distinct wordings. */
function stateOf(l: VaultLogin): string | null {
  if (l.lastResult === "rejected") return "Rejected by the site last time";
  if (l.askBeforeUse) return "Asks before using";
  if (l.lastResult === "worked") return "Worked last time";
  return null;
}

/** "Used the saved login for github.com" */
export function eventText(e: VaultEvent): string {
  const site = e.site ?? "a site";
  switch (e.action) {
    case "saved":
      return `Saved a login for ${site}`;
    case "replaced":
      return `Replaced the login for ${site}`;
    case "used":
      return `Used the saved login for ${site}`;
    case "worked":
      return `${site} accepted the login`;
    case "rejected":
      return `${site} rejected the login`;
    case "deleted":
      return `Deleted the login for ${site}`;
    case "ask_on":
      return `${site} now asks before using its login`;
    case "ask_off":
      return `${site} fills in its login by itself`;
    case "imported":
      return e.detail ?? "Imported logins";
    case "code_saved":
      return `Saved the authenticator key for ${site}`;
    case "code_removed":
      return `Removed the authenticator key for ${site}`;
    case "code_used":
      return `Made a 2-step code for ${site}`;
    case "viewed":
      return `You viewed the login for ${site}`;
    case "edited":
      return `You changed the login for ${site}`;
  }
}

/** "9:43 PM" today, "Oct 20, 9:43 PM" otherwise. */
function when(iso: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString()
    ? time
    : `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

function SiteBadge({ site }: { site: string }) {
  return (
    <span className="site-badge">
      {site
        .replace(/^www\./, "")
        .charAt(0)
        .toUpperCase()}
    </span>
  );
}

const svg = (d: string) => (
  <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true">
    <path
      d={d}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
export const VaultIcon = () =>
  svg(
    "M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6l7-3ZM9.5 11.5h5v4h-5v-4ZM10.5 11.5V10a1.5 1.5 0 0 1 3 0v1.5",
  );
const ChevronRight = () => <span className="row-chevron">{svg("M9 6l6 6-6 6")}</span>;
const ChevronLeft = () => svg("M15 6l-6 6 6 6");
const CloseIcon = () => svg("M6 6l12 12M18 6 6 18");
