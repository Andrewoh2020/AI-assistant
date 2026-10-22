/**
 * The API's request and response shapes, plus a small client. Shared by the web app now and the
 * Expo app later, so both talk to the backend the same way.
 */

export type RunStatus =
  "queued" | "running" | "awaiting_tools" | "completed" | "failed" | "cancelled";

export interface SourceView {
  n: number;
  title: string | null;
  url: string;
  siteName: string | null;
  date: string | null;
  /** The page contained text that tried to give the assistant instructions. */
  flagged: boolean;
}

export interface FileView {
  id: string;
  name: string;
  mime: string;
  bytes: number;
  /** "upload": the person attached it. "download": the browser got it for them. */
  kind: "upload" | "download";
}

export type BrowserStatus =
  "starting" | "running" | "needs_user" | "user_control" | "done" | "failed" | "stopped";

export interface BrowserTabView {
  url: string;
  title: string | null;
  /** The tab the browser was showing. */
  active: boolean;
}

/** A browser job the assistant ran, live or finished. Only ever sent to its owner. */
export interface BrowserView {
  id: string;
  /** needs_user: the agent asked the person to do something. user_control: they took over. */
  status: BrowserStatus;
  /**
   * The status in Muse's words: Working on it, Browsing, Waiting for you, You're in control,
   * Done, Site blocked, Couldn't finish, Stopped.
   */
  label: string;
  /** A short name for the job, like "Check GitHub notifications". */
  title: string;
  /** The site it is on, like "github.com". */
  site: string | null;
  tabs: BrowserTabView[];
  step: string | null;
  needsUser: string | null;
  /**
   * The browser is asking for the person's sign-in (or a one-time code) for this site. It can be
   * given in the secure sign-in box; it is typed only into that site and never seen by the AI.
   */
  ask: {
    kind: "sign_in" | "code";
    site: string;
    /** The site turned down the last sign-in: the saved login, or the one just typed. */
    problem: "saved_rejected" | "typed_rejected" | "saved_code_rejected" | null;
    /** A saved login set to "Ask before using": its account ('' if none), offered in the box. */
    savedAccount: string | null;
  } | null;
  /** How it signed in, like "Signed in to github.com with your saved login". */
  note: string | null;
  /** The live browser. Works like a password while the browser is open; never share it. */
  liveUrl: string | null;
  /** The last picture of the page, if there is one (see fileViewUrl). */
  screenshotId: string | null;
  /** The browser has closed; only the last picture is left. */
  closed: boolean;
  /** It failed, was blocked or was stopped (the card's globe turns red). */
  failed: boolean;
}

export interface MessageView {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  reasoning: string | null;
  sources: SourceView[];
  files: FileView[];
  /** Browser jobs behind this answer, shown as cards above it. */
  browsers: BrowserView[];
  /** A trip card for a flight, shown under the text (live: it changes as the flight nears). */
  flight: FlightView | null;
  createdAt: string;
  runId: string | null;
  clientMessageId: string | null;
}

export interface RunView {
  id: string;
  chatId: string;
  status: RunStatus;
  statusLine: string | null;
  error: string | null;
  message: MessageView | null;
  /** Browser jobs in this run so far, oldest first. */
  browsers: BrowserView[];
}

export interface ChatSummary {
  id: string;
  kind: "main" | "side" | "group";
  title: string | null;
  cleanRoom: boolean;
  pinned: boolean;
  archived: boolean;
  /** When the chat last had a message (or was created, if it has none). */
  updatedAt: string;
  /** The reply still being worked on in this chat, if any. Only set in the chat list. */
  activeRunId: string | null;
}

/** A saved login on the Vault page. Never holds the username or password themselves. */
export interface VaultLogin {
  id: string;
  /** The only site it is ever typed into, like "github.com". */
  site: string;
  /** The account as it was typed ('' when only a password was saved). */
  account: string;
  /** Asks in the sign-in box instead of filling in by itself. */
  askBeforeUse: boolean;
  /** Whether the site took it the last time it was used. */
  lastResult: "worked" | "rejected" | null;
  /** An authenticator key is saved, so the browser makes 2-step codes itself. */
  hasCodeKey: boolean;
  source: "typed" | "imported";
  /** The password manager it was imported from. */
  importedFrom: string | null;
  savedAt: string;
  lastUsedAt: string | null;
  lastResultAt: string | null;
}

export type PasswordManager =
  | "Apple Passwords"
  | "Chrome"
  | "Google Password Manager"
  | "Edge"
  | "Firefox"
  | "Safari"
  | "1Password"
  | "Bitwarden"
  | "LastPass"
  | "Dashlane"
  | "Proton Pass"
  | "Other";

/** What an export file holds, before anything is saved. Never the passwords. */
export interface ImportPreview {
  logins: { index: number; site: string; account: string; alreadySaved: boolean }[];
  /** Entries left out: notes, cards, app-only logins, entries without a password. */
  skipped: number;
}

/** One line of the vault's activity log. */
export interface VaultEvent {
  id: string;
  action:
    | "saved"
    | "replaced"
    | "used"
    | "worked"
    | "rejected"
    | "deleted"
    | "imported"
    | "ask_on"
    | "ask_off"
    | "code_saved"
    | "code_removed"
    | "code_used"
    | "viewed"
    | "edited";
  site: string | null;
  account: string | null;
  detail: string | null;
  at: string;
}

/** A flight or hotel stay the assistant found (today: in Gmail). */
export type Booking =
  | {
      kind: "flight";
      airline: string | null;
      /** Like "NH 7". */
      flightNumber: string | null;
      fromCode: string | null;
      fromCity: string | null;
      toCode: string | null;
      toCity: string | null;
      /** Local time at the airport, like "2026-11-03T10:30". */
      departAt: string | null;
      arriveAt: string | null;
      confirmation: string | null;
    }
  | {
      kind: "hotel";
      name: string | null;
      city: string | null;
      address: string | null;
      /** Like "2026-11-03". */
      checkIn: string | null;
      checkOut: string | null;
      confirmation: string | null;
    };

export interface TripView {
  id: string;
  title: string;
  startsOn: string | null;
  endsOn: string | null;
  bookings: (Booking & { id: string })[];
}

/** Gmail as Settings shows it. Never holds the sign-in token. */
export interface GmailStatus {
  connected: boolean;
  /** The connection stopped working (expired or removed); connecting again fixes it. */
  needsReconnect: boolean;
  email: string | null;
  lastCheckedAt: string | null;
  /** Upcoming trips found in the mail, soonest first. */
  trips: TripView[];
}

/** Something a flight may need from the person before check-in. Asked once, then kept. */
export type PrepKey =
  | "name"
  | "dateOfBirth"
  | "gender"
  | "nationality"
  | "passportNumber"
  | "passportExpiry"
  | "knownTraveler"
  | "frequentFlyer"
  | "seatStyle"
  | "homeAddress";

/** The person's travel details, as Settings shows them. Hidden numbers are only flagged. */
export interface TravelProfileView {
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  /** "1990-04-12" */
  dateOfBirth: string | null;
  gender: "female" | "male" | "x" | null;
  /** ISO country code, like "US". */
  nationality: string | null;
  passportCountry: string | null;
  passportExpiry: string | null;
  homeAddress: string | null;
  seatSide: "window" | "aisle" | "any" | null;
  seatZone: "front" | "middle" | "back" | "any" | null;
  seatEmptyNearby: boolean | null;
  seatAvoidWashroom: boolean | null;
  hasPassportNumber: boolean;
  hasKnownTraveler: boolean;
  /** Airline codes with a saved frequent flyer number, like ["UA"]. */
  frequentFlyerAirlines: string[];
  /** Answers given to questions airlines or arrival forms asked. */
  answers: { question: string; answer: string }[];
}

/** The hidden travel numbers, for the person's own eyes in Settings. */
export interface TravelDocumentsView {
  passportNumber?: string;
  knownTravelerNumber?: string;
  frequentFlyer?: Record<string, string>;
}

/** Answers from the Trip prep card. Every field is optional. */
export interface PrepAnswers {
  firstName?: string;
  middleName?: string;
  lastName?: string;
  dateOfBirth?: string;
  gender?: "female" | "male" | "x";
  nationality?: string;
  passportNumber?: string;
  passportExpiry?: string;
  passportCountry?: string;
  /** Empty or null: "I don't have one". */
  knownTravelerNumber?: string | null;
  frequentFlyerNumber?: string | null;
  seatSide?: "window" | "aisle" | "any";
  seatZone?: "front" | "middle" | "back" | "any";
  seatEmptyNearby?: boolean;
  seatAvoidWashroom?: boolean;
  homeAddress?: string;
  /** The answer to the question the airline or arrival form asked. */
  answer?: string;
  /** "I'm not carrying any banned items" for this trip. */
  noBannedItems?: boolean;
}

export type CheckinStatus =
  "scheduled" | "waiting_for_you" | "running" | "done" | "airport" | "backup" | "off" | "past";

export type ArrivalStatus =
  "not_needed" | "scheduled" | "ready" | "running" | "done" | "waiting_for_you" | "backup";

/** A flight's trip card. Only ever sent to its owner. */
export interface FlightView {
  /** The trip item (booking) id. */
  id: string;
  airline: string | null;
  airlineName: string;
  flightNumber: string | null;
  fromCode: string | null;
  fromCity: string | null;
  toCode: string | null;
  toCity: string | null;
  /** Booked times, local at each airport: "2026-11-03T10:30". */
  departLocal: string | null;
  arriveLocal: string | null;
  /** The booked departure as a real moment (ISO). */
  departAt: string | null;
  confirmation: string | null;
  international: boolean;
  /** Within 6 hours of leaving, until it lands: the card shows live status and leave time. */
  today: boolean;
  past: boolean;
  /** Live flight status is set up (a FlightAware key). */
  liveAvailable: boolean;
  live: {
    status: "on_time" | "delayed" | "cancelled" | "departed" | "landed";
    delayMinutes: number;
    departLocal: string | null;
    arriveLocal: string | null;
    terminal: string | null;
    gate: string | null;
    arrivalTerminal: string | null;
    baggageClaim: string | null;
    checkedAt: string | null;
  } | null;
  checkin: {
    status: CheckinStatus;
    /** When check-in opens (or the next try). */
    opensAt: string | null;
    /** Automatic check-in is on for this flight. */
    auto: boolean;
    /** The airline asked something we didn't know. */
    question: string | null;
    /** Why it's at the airport desk or the backup link. */
    note: string | null;
    seat: string | null;
    group: string | null;
    terminal: string | null;
    /** The boarding pass doesn't match the booking (flight, date or name). */
    mismatch: string | null;
    /** Paid extras it said no to. */
    skipped: string[];
    /** The airline's site, like "united.com". */
    site: string | null;
    boardingPass: FileView | null;
    browser: BrowserView | null;
  };
  prep: {
    /** Needed before check-in. */
    required: PrepKey[];
    /** Asked once; check-in works without them. */
    optional: PrepKey[];
    /** What we already have ("name", "passport"...). */
    have: string[];
    warnings: string[];
    noBannedItems: boolean;
    airlineCode: string | null;
  };
  arrival: {
    form: string;
    country: string;
    /** The official site. */
    site: string;
    status: ArrivalStatus;
    /** When it can first be filed. */
    opensAt: string | null;
    /** The person tapped OK on the health and customs answers. */
    confirmed: boolean;
    question: string | null;
    note: string | null;
    /** Where they're staying, from their hotel booking. */
    stay: string | null;
    file: FileView | null;
    browser: BrowserView | null;
  } | null;
  leave: {
    leaveBy: string;
    leaveLocal: string | null;
    mode: "car" | "train" | null;
    minutes: number | null;
    otherMode: "car" | "train" | null;
    otherMinutes: number | null;
    beAtLocal: string | null;
  } | null;
  /** No home address yet: the leave time can't use traffic. */
  needsHomeAddress: boolean;
}

export interface Me {
  userId: string;
  displayName: string | null;
  email: string | null;
  timezone: string;
}

export const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function createClient(baseUrl: string, fetchImpl: typeof fetch = fetch) {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      credentials: "include",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`);
    return data as T;
  }

  return {
    signUp: (input: {
      email: string;
      password: string;
      displayName?: string;
      inviteCode: string;
      timezone: string;
    }) => call<{ ok: true }>("POST", "/auth/sign-up", input),
    signIn: (input: { email: string; password: string; timezone: string }) =>
      call<{ ok: true }>("POST", "/auth/sign-in", input),
    signOut: () => call<{ ok: true }>("POST", "/auth/sign-out", {}),
    me: () => call<Me>("GET", "/me"),
    listChats: () => call<{ chats: ChatSummary[] }>("GET", "/chats"),
    createSideChat: (input: { title?: string; cleanRoom?: boolean }) =>
      call<{ chat: ChatSummary }>("POST", "/chats", input),
    updateChat: (id: string, input: { pinned?: boolean; archived?: boolean; title?: string }) =>
      call<{ chat: ChatSummary }>("PATCH", `/chats/${id}`, input),
    deleteChat: (id: string) => call<{ ok: true }>("DELETE", `/chats/${id}`),
    getChat: (id: string) =>
      call<{
        chat: ChatSummary;
        messages: MessageView[];
        activeRun: RunView | null;
        endedRuns: RunView[];
      }>("GET", `/chats/${id}`),
    sendMessage: (
      chatId: string,
      input: { text: string; clientMessageId: string; fileIds?: string[] },
    ) => call<{ message: MessageView; run: RunView }>("POST", `/chats/${chatId}/messages`, input),
    pollRun: (id: string) => call<{ run: RunView }>("GET", `/runs/${id}`),
    stopRun: (id: string) => call<{ run: RunView }>("POST", `/runs/${id}/stop`, {}),
    /** Sends the file's bytes as they are; the name travels in a header. */
    uploadFile: async (file: Blob & { name: string }, chatId?: string) => {
      const q = chatId ? `?chatId=${encodeURIComponent(chatId)}` : "";
      const res = await fetchImpl(`${baseUrl}/files${q}`, {
        method: "POST",
        credentials: "include",
        headers: {
          // Always raw bytes; the real type goes in X-File-Type so text and JSON files aren't
          // mistaken for a request body.
          "Content-Type": "application/octet-stream",
          "X-File-Type": file.type || "application/octet-stream",
          "X-File-Name": encodeURIComponent(file.name),
        },
        body: file,
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; file?: FileView };
      if (!res.ok) throw new ApiError(res.status, data.error ?? `Upload failed (${res.status})`);
      return data as { file: FileView };
    },
    vault: () => call<{ logins: VaultLogin[]; activity: VaultEvent[] }>("GET", "/vault"),
    updateVaultLogin: (id: string, input: { askBeforeUse: boolean }) =>
      call<{ ok: true }>("PATCH", `/vault/logins/${id}`, input),
    deleteVaultLogin: (id: string) => call<{ ok: true }>("DELETE", `/vault/logins/${id}`),
    /** The saved username and password, for the person's own eyes on the Vault page. */
    revealVaultLogin: (id: string) =>
      call<{ username: string; password: string }>("POST", `/vault/logins/${id}/reveal`),
    editVaultLogin: (id: string, login: { username: string; password: string }) =>
      call<{ ok: true }>("PUT", `/vault/logins/${id}/login`, login),
    /** Saves the site's authenticator key (setup key or otpauth:// link) with the login. */
    saveVaultCodeKey: (id: string, key: string) =>
      call<{ ok: true }>("POST", `/vault/logins/${id}/code-key`, { key }),
    removeVaultCodeKey: (id: string) =>
      call<{ ok: true }>("DELETE", `/vault/logins/${id}/code-key`),
    /** Reads a password manager's export file; nothing is saved yet. */
    previewVaultImport: (csv: string) =>
      call<ImportPreview>("POST", "/vault/import/preview", { csv }),
    /** Saves the ticked logins (by index) from the export file. */
    importVault: (input: { csv: string; manager: PasswordManager; indices: number[] }) =>
      call<{ imported: number; replaced: number }>("POST", "/vault/import", input),
    gmail: () => call<GmailStatus>("GET", "/connectors/gmail"),
    /** Where the browser goes to connect Gmail (the hosted connect page, then back to the app). */
    gmailConnectUrl: () => `${baseUrl}/connectors/gmail/start`,
    disconnectGmail: () => call<{ ok: true }>("DELETE", "/connectors/gmail"),
    /** Upcoming flights' trip cards, soonest first. Also moves along any check-in in progress. */
    flights: () => call<{ flights: FlightView[] }>("GET", "/flights"),
    flight: (id: string) => call<{ flight: FlightView }>("GET", `/flights/${id}`),
    /** The Trip prep card: saves the answers (secret numbers go to the vault). */
    saveFlightPrep: (id: string, input: PrepAnswers) =>
      call<{ flight: FlightView }>("POST", `/flights/${id}/prep`, input),
    updateFlight: (id: string, input: { autoCheckin?: boolean; arrivalConfirmed?: boolean }) =>
      call<{ flight: FlightView }>("PATCH", `/flights/${id}`, input),
    travelProfile: () => call<{ profile: TravelProfileView }>("GET", "/travel-profile"),
    /** Settings edits, one field at a time. Empty removes it. */
    editTravelProfile: (
      input: PrepAnswers & { frequentFlyer?: Record<string, string | null>; removeAnswer?: string },
    ) => call<{ profile: TravelProfileView }>("PATCH", "/travel-profile", input),
    revealTravelDocuments: () =>
      call<{ documents: TravelDocumentsView }>("POST", "/travel-profile/reveal", {}),
    fileUrl: (id: string) => `${baseUrl}/files/${id}/download`,
    /** Shows an image file in the page (browser pictures). */
    fileViewUrl: (id: string) => `${baseUrl}/files/${id}/view`,
    takeOverBrowser: (id: string) =>
      call<{ browser: BrowserView }>("POST", `/browser-sessions/${id}/take-over`, {}),
    handBackBrowser: (id: string) =>
      call<{ browser: BrowserView }>("POST", `/browser-sessions/${id}/hand-back`, {}),
    /** The secure sign-in box. The values go to the browser only; nothing keeps them. */
    signInBrowser: (
      id: string,
      input: {
        username?: string;
        password?: string;
        code?: string;
        /** Save the login in the vault for next time (the default). */
        save?: boolean;
        /** Fill the saved login instead. */
        useSaved?: boolean;
      },
    ) => call<{ browser: BrowserView }>("POST", `/browser-sessions/${id}/sign-in`, input),
  };
}

export type ApiClient = ReturnType<typeof createClient>;
