"use client";

import {
  ApiError,
  type CalendarStatus,
  type GmailStatus,
  type VaultEvent,
  type VaultLogin,
} from "@ai-assistant/api-client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { api } from "@/lib/client";
import { Menu, MenuItem } from "./Menu";
import { TravelPage } from "./TravelSettings";

/**
 * Settings, Muse style: a sheet over the chat with grouped white lists, a centered title and a
 * round close button. Rows push to a detail page with a back chevron. For now it holds the
 * Secure credentials store (the vault); the other rows arrive with their features.
 */

type Page =
  | { name: "home" }
  | { name: "vault" }
  | { name: "login"; id: string }
  | { name: "connections" }
  | { name: "travel" };

/** How connecting Gmail or Google Calendar went, from Google's sign-in coming back to the app. */
export interface GmailResult {
  app: "gmail" | "calendar";
  outcome: "connected" | "cancelled" | "failed" | "unavailable";
}

export function Settings({
  start = "home",
  gmailResult = null,
  onClose,
  onSignOut,
}: {
  start?: "home" | "vault" | "connections";
  gmailResult?: GmailResult | null;
  onClose: () => void;
  onSignOut: () => void;
}) {
  const [page, setPage] = useState<Page>({ name: start } as Page);
  const [gmail, setGmail] = useState<GmailStatus | null>(null);
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

  const loadGmail = useCallback(async () => {
    try {
      setGmail(await api.gmail());
    } catch {
      // The row just shows "Gmail" until it loads.
    }
  }, []);

  useEffect(() => {
    void load();
    void loadGmail();
  }, [load, loadGmail]);

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
    page.name === "vault" || page.name === "connections" || page.name === "travel"
      ? { name: "home" }
      : page.name === "home"
        ? null
        : { name: "vault" };
  const title =
    page.name === "home"
      ? "Settings"
      : page.name === "vault"
        ? "Secure credentials store"
        : page.name === "connections"
          ? "Connected accounts"
          : page.name === "travel"
            ? "Travel details"
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
                <Row
                  icon={<MailIcon />}
                  label="Connected accounts"
                  sub={
                    gmail?.needsReconnect || gmail?.calendar.needsReconnect
                      ? "Needs reconnecting"
                      : gmail?.connected && gmail.calendar.connected
                        ? "Gmail and Google Calendar connected"
                        : gmail?.connected
                          ? "Gmail connected"
                          : gmail?.calendar.connected
                            ? "Google Calendar connected"
                            : "Gmail, Google Calendar"
                  }
                  onClick={() => setPage({ name: "connections" })}
                />
                <Row
                  icon={<PlaneIcon />}
                  label="Travel details"
                  sub="Passport, seat style, for automatic check-in"
                  onClick={() => setPage({ name: "travel" })}
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
          {page.name === "connections" && (
            <ConnectionsPage gmail={gmail} result={gmailResult} onChanged={loadGmail} />
          )}
          {page.name === "travel" && <TravelPage />}
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

function resultText({ app, outcome }: GmailResult): string {
  const name = app === "calendar" ? "Google Calendar" : "Gmail";
  if (outcome === "connected") return `${name} is connected.`;
  if (outcome === "cancelled") return `${name} wasn't connected.`;
  if (outcome === "failed") return `${name} couldn't be connected. Try again.`;
  return `${name} can't be connected right now. Try again later.`;
}

/**
 * Apps Ability can use, one row each: Connect when it isn't, or a "Connected" pill whose menu
 * disconnects it. Bookings found in Gmail or the calendar show up in the chat, not here.
 */
function ConnectionsPage({
  gmail,
  result,
  onChanged,
}: {
  gmail: GmailStatus | null;
  result: GmailResult | null;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function disconnect(app: "gmail" | "calendar") {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await (app === "gmail" ? api.disconnectGmail() : api.disconnectCalendar());
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p className="group-intro">
        Connect Gmail and Google Calendar and Ability finds your flights and hotel stays by itself.
        It only reads them. It never sends, changes or deletes anything.
      </p>
      {result && (
        <p className={result.outcome === "connected" ? "group-note" : "form-error"} role="status">
          {resultText(result)}
        </p>
      )}
      <div className="group">
        <AccountRow
          label="Gmail"
          icon={<MailIcon />}
          status={gmail}
          connectUrl={api.gmailConnectUrl()}
          onDisconnect={() => void disconnect("gmail")}
        />
        <AccountRow
          label="Google Calendar"
          icon={<CalendarIcon />}
          status={gmail?.calendar ?? null}
          connectUrl={api.calendarConnectUrl()}
          onDisconnect={() => void disconnect("calendar")}
        />
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

function AccountRow({
  label,
  icon,
  status,
  connectUrl,
  onDisconnect,
}: {
  label: string;
  icon: ReactNode;
  status: CalendarStatus | null;
  connectUrl: string;
  onDisconnect: () => void;
}) {
  return (
    <div className="row row-static row-account">
      <span className="row-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="row-text">
        <span className="row-label">{label}</span>
        {status && (status.email || status.needsReconnect) && (
          <span className="row-sub">
            {status.needsReconnect && !status.connected ? "Stopped working" : status.email}
          </span>
        )}
      </span>
      {status?.connected ? (
        <Menu
          label={`${label} connection`}
          className="row-menu"
          buttonClassName="connected-pill"
          trigger={
            <>
              <span className="connected-dot" aria-hidden="true" />
              Connected
              <ChevronDownIcon />
            </>
          }
        >
          {(close) => (
            <MenuItem
              danger
              onSelect={() => {
                close();
                onDisconnect();
              }}
            >
              Disconnect
            </MenuItem>
          )}
        </Menu>
      ) : (
        status && (
          <a className="btn btn-small" href={connectUrl}>
            {status.needsReconnect ? "Reconnect" : "Connect"}
          </a>
        )
      )}
    </div>
  );
}

function ChevronDownIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="m7 10 5 5 5-5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
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
              sub={[l.account || "Password only", stateOf(l)].filter(Boolean).join(" · ")}
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
 * The saved username and password, edited in place like Apple's Passwords app: click a field,
 * type, and it saves when you leave it (Enter saves too, Escape undoes). The password stays as
 * dots until it is shown or being edited. The assistant has no way to read these.
 */
function SignInDetails({
  login,
  onChanged,
}: {
  login: VaultLogin;
  onChanged: () => Promise<void>;
}) {
  // What is saved, once opened; null until the password is first needed.
  const [saved, setSaved] = useState<{ username: string; password: string } | null>(null);
  const [username, setUsername] = useState(login.account);
  const [password, setPassword] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const [editingPassword, setEditingPassword] = useState(false);
  const [status, setStatus] = useState<"saving" | "saved" | "copied" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const opening = useRef<Promise<{ username: string; password: string } | null> | null>(null);

  function open() {
    if (saved) return Promise.resolve(saved);
    opening.current ??= api
      .revealVaultLogin(login.id)
      .then((l) => {
        setSaved(l);
        setPassword((p) => p ?? l.password);
        return l;
      })
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : "Couldn't open this login. Try again.");
        opening.current = null;
        return null;
      });
    return opening.current;
  }

  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  function flash(next: "saved" | "copied") {
    setStatus(next);
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setStatus(null), 1500);
  }

  async function save() {
    const current = await open();
    if (!current) return;
    const next = { username: username.trim(), password: password ?? current.password };
    if (next.username === current.username && next.password === current.password) return;
    if (!next.password) {
      setError("The password can't be empty.");
      setPassword(current.password);
      return;
    }
    setStatus("saving");
    setError(null);
    try {
      await api.editVaultLogin(login.id, next);
      setSaved(next);
      setUsername(next.username);
      flash("saved");
      await onChanged();
    } catch (err) {
      setStatus(null);
      setError(err instanceof ApiError ? err.message : "That didn't save. Try again.");
    }
  }

  function undo(field: "username" | "password") {
    setError(null);
    if (field === "username") setUsername(saved?.username ?? login.account);
    else setPassword(saved?.password ?? null);
  }

  const keys = (field: "username" | "password") => (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") e.currentTarget.blur();
    if (e.key === "Escape") {
      // Escape undoes the edit here instead of closing Settings.
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation();
      const input = e.currentTarget;
      undo(field);
      // Leave after the undone value is in place, so leaving doesn't save the edit.
      setTimeout(() => input.blur());
    }
  };

  async function copy() {
    const l = await open();
    if (!l) return;
    try {
      await navigator.clipboard.writeText(password ?? l.password);
      flash("copied");
    } catch {
      setError("Couldn't copy. Press Show and copy it yourself.");
    }
  }

  const showText = visible || editingPassword;
  return (
    <>
      <div className="group">
        <label className="row row-static row-detail row-field">
          <span className="row-sub">Username</span>
          <input
            className="field-inline"
            value={username}
            placeholder="None (password only)"
            onChange={(e) => setUsername(e.target.value)}
            onBlur={() => void save()}
            onKeyDown={keys("username")}
            autoComplete="off"
            spellCheck={false}
            maxLength={1000}
          />
        </label>
        <div className="row row-static row-secret">
          <label className="row-text row-field">
            <span className="row-sub">Password</span>
            <input
              className={`field-inline ${showText ? "secret-value" : "secret-dots"}`}
              type={showText ? "text" : "password"}
              value={password ?? "••••••••••"}
              readOnly={password === null}
              onFocus={() => {
                setEditingPassword(true);
                void open();
              }}
              onChange={(e) => setPassword(e.target.value)}
              onBlur={() => {
                setEditingPassword(false);
                void save();
              }}
              onKeyDown={keys("password")}
              autoComplete="new-password"
              spellCheck={false}
              maxLength={1000}
            />
          </label>
          <span className="row-actions">
            <button
              type="button"
              className="bsign-alt"
              onClick={async () => {
                if (visible) return setVisible(false);
                if (await open()) setVisible(true);
              }}
            >
              {visible ? "Hide" : "Show"}
            </button>
            <button type="button" className="bsign-alt" onClick={() => void copy()}>
              Copy
            </button>
          </span>
        </div>
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : (
        status && (
          <p className="field-status" role="status">
            {status === "saving" ? "Saving…" : status === "saved" ? "Saved" : "Password copied"}
          </p>
        )
      )}
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
const MailIcon = () => svg("M3.5 6.5h17v11h-17v-11ZM3.5 7l8.5 6.5L20.5 7");
const CalendarIcon = () => svg("M4.5 6h15v13.5h-15V6ZM4.5 10h15M8.5 4v4M15.5 4v4");
const PlaneIcon = () =>
  svg(
    "M21 15.5v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V8.5l-8 5v2l8-2.5V18l-2 1.5V21l3.5-1 3.5 1v-1.5L13 18v-5z",
  );
const ChevronRight = () => <span className="row-chevron">{svg("M9 6l6 6-6 6")}</span>;
const ChevronLeft = () => svg("M15 6l-6 6 6 6");
const CloseIcon = () => svg("M6 6l12 12M18 6 6 18");
