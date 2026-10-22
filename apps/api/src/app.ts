import { timingSafeEqual } from "node:crypto";
import cookie from "@fastify/cookie";
import { withUser, type ChatRow, type Sql } from "@ai-assistant/db";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import {
  hashPassword,
  signSession,
  verifyPassword,
  verifySession,
  type SessionPayload,
} from "./auth.js";
import { handBack, signIn, takeOver, viewOf } from "./browser.js";
import type { BrowserUse } from "./browseruse.js";
import type { Config } from "./config.js";
import { BadRequest } from "./errors.js";
import { cleanFileName, fileView, MAX_FILE_BYTES, readFile, saveFile } from "./files.js";
import { extractText } from "./extract.js";
import { DeepSeekBookingReader, type BookingReader } from "./bookings.js";
import {
  checkState,
  connectGmail,
  disconnectGmail,
  gmailStatus,
  signState,
  syncGmail,
  syncIfDue,
  type GmailDeps,
} from "./gmail.js";
import { GoogleAuthError, TravilaGmail, type Google } from "./google.js";
import {
  FlightAwareHttp,
  GoogleRoutesHttp,
  type FlightStatusSource,
  type RouteSource,
} from "./flightdata.js";
import {
  afterPrep,
  flightSecrets,
  flightViews,
  planFlights,
  planOf,
  stepFlight,
  tickAll,
  tickUser,
  upcomingFlightIds,
  airlineOf,
  type FlightDeps,
} from "./flights.js";
import {
  checkPrep,
  editProfile,
  profileView,
  readProfile,
  revealDocuments,
  savePrep,
} from "./travel.js";
import {
  advanceRun,
  Conflict,
  createSideChat,
  deleteChat,
  getChat,
  listChats,
  NotFound,
  sendMessage,
  stopRun,
  updateChat,
  type ChatListRow,
  type Deps,
  type Session,
} from "./orchestrator.js";
import type { Resolver } from "./policy.js";
import type { SearchBackend } from "./search.js";
import type { Travila } from "./travila.js";
import {
  deleteLogin,
  editLogin,
  existingLogins,
  importLogins,
  listLogins,
  revealLogin,
  setAskBeforeUse,
  setCodeKey,
  vaultActivity,
  vaultKeyFrom,
} from "./vault.js";
import { MANAGERS, readExport } from "./vault-import.js";

const COOKIE = "aia_session";
const SESSION_DAYS = 30;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AppDeps {
  config: Config;
  sql: Sql;
  travila: Travila;
  search: SearchBackend;
  browser: BrowserUse;
  defer?: (work: Promise<unknown>) => void;
  resolve?: Resolver;
  browserCheckGapMs?: number;
  /** Gmail through Travila's connected apps; built from the config when left out. */
  google?: Google;
  /** Reads bookings out of emails; DeepSeek when left out. */
  bookingReader?: BookingReader;
  /** Live flight status and travel times; built from the config when left out. */
  flightStatus?: FlightStatusSource;
  routes?: RouteSource;
  /**
   * Runs the flight scheduler in this process: it sleeps until a flight next needs something, and
   * wakes at least this often to look for new booking emails. Set on a computer that stays on;
   * left out on Vercel, where /cron/flights and opening the app drive it.
   */
  scheduleEveryMs?: number;
  now?: () => Date;
}

declare module "fastify" {
  interface FastifyRequest {
    session: Session | null;
  }
}

function isTimezone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Our backend. Clients only ever talk to this; it holds every vendor key.
 * Every chat and run id in a request is checked against the signed-in user (through row-level
 * security), and an id that isn't theirs gets 403 before anything is sent to Travila.
 */
export function buildApp(deps: AppDeps): FastifyInstance {
  const { config, sql } = deps;
  const vaultKey = vaultKeyFrom(config.vaultMasterKey, config.sessionSecret);
  const orchestratorDeps: Deps = {
    sql,
    travila: deps.travila,
    search: deps.search,
    browser: deps.browser,
    secret: config.sessionSecret,
    vaultKey,
    defer: deps.defer,
    resolve: deps.resolve,
    browserCheckGapMs: deps.browserCheckGapMs,
  };
  const gmailDeps: GmailDeps = {
    sql,
    google: deps.google ?? new TravilaGmail(config.travilaBase, config.travilaKey),
    reader:
      deps.bookingReader ?? new DeepSeekBookingReader(config.deepseekBase, config.deepseekKey),
    vaultKey,
    secret: config.sessionSecret,
  };
  const flightDeps: FlightDeps = {
    sql,
    browser: deps.browser,
    secret: config.sessionSecret,
    vaultKey,
    status: deps.flightStatus ?? new FlightAwareHttp(config.flightAwareKey),
    routes: deps.routes ?? new GoogleRoutesHttp(config.googleMapsKey),
    now: deps.now,
    checkGapMs: deps.browserCheckGapMs,
  };
  // Work that carries on after the response (on Vercel, waitUntil keeps the function alive).
  const later = (work: Promise<unknown>) => {
    const safe = work.catch((err) => app.log.error(err));
    if (deps.defer) deps.defer(safe);
  };
  const app = Fastify({ logger: process.env.NODE_ENV !== "test", bodyLimit: 64 * 1024 });

  app.register(cookie);
  // File uploads arrive as the file's own bytes, sent as application/octet-stream with the real
  // type in X-File-Type (so text and JSON files aren't parsed as a request body).
  app.addContentTypeParser(
    "*",
    { parseAs: "buffer", bodyLimit: MAX_FILE_BYTES },
    (_req, body, done) => done(null, body),
  );
  app.decorateRequest("session", null);

  app.addHook("preHandler", async (req) => {
    const payload = verifySession(req.cookies?.[COOKIE], config.sessionSecret);
    req.session = payload
      ? { userId: payload.uid, travilaUserId: payload.tid, timezone: payload.tz }
      : null;
  });

  function requireSession(req: FastifyRequest, reply: FastifyReply): Session | null {
    if (!req.session) {
      reply.code(401).send({ error: "Please sign in." });
      return null;
    }
    return req.session;
  }

  function setSession(
    reply: FastifyReply,
    user: { userId: string; travilaUserId: string },
    timezone: string,
  ) {
    const payload: SessionPayload = {
      uid: user.userId,
      tid: user.travilaUserId,
      tz: timezone,
      exp: Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400,
    };
    reply.setCookie(COOKIE, signSession(payload, config.sessionSecret), {
      httpOnly: true,
      sameSite: "lax",
      secure: config.secureCookies,
      path: "/",
      maxAge: SESSION_DAYS * 86400,
    });
  }

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof NotFound)
      return reply.code(403).send({ error: "That isn't yours, or it doesn't exist." });
    if (err instanceof Conflict) return reply.code(409).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: (err as Error).message });
    app.log.error(err);
    return reply.code(500).send({ error: "Something went wrong on our side." });
  });

  app.get("/health", async () => ({ ok: true, service: "api" }));

  // Sign-in ------------------------------------------------------------------

  app.post("/auth/sign-up", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
    const password = typeof b.password === "string" ? b.password : "";
    if (!config.signupCode || b.inviteCode !== config.signupCode) {
      return reply.code(403).send({ error: "That invite code isn't right." });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return reply.code(400).send({ error: "Enter a valid email." });
    if (password.length < 10)
      return reply.code(400).send({ error: "Use a password of at least 10 characters." });
    const timezone = isTimezone(b.timezone) ? b.timezone : "UTC";
    const displayName =
      typeof b.displayName === "string" ? b.displayName.trim().slice(0, 80) || null : null;
    try {
      const [row] = await sql<{ user_id: string; travila_user_id: string }[]>`
        SELECT * FROM app_local_sign_up(${email}, ${await hashPassword(password)}, ${displayName}, ${timezone})`;
      setSession(reply, { userId: row!.user_id, travilaUserId: row!.travila_user_id }, timezone);
      return { ok: true };
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        return reply.code(409).send({ error: "There's already an account with that email." });
      }
      throw err;
    }
  });

  app.post("/auth/sign-in", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
    const password = typeof b.password === "string" ? b.password : "";
    const [row] = await sql<{ user_id: string; travila_user_id: string; password_hash: string }[]>`
      SELECT * FROM app_local_account(${email})`;
    if (!row || !(await verifyPassword(password, row.password_hash))) {
      return reply.code(401).send({ error: "Email or password is wrong." });
    }
    const [user] = await sql<
      { timezone: string }[]
    >`SELECT timezone FROM users WHERE id = ${row.user_id}`;
    const timezone = isTimezone(b.timezone) ? b.timezone : (user?.timezone ?? "UTC");
    setSession(reply, { userId: row.user_id, travilaUserId: row.travila_user_id }, timezone);
    return { ok: true };
  });

  app.post("/auth/sign-out", async (_req, reply) => {
    reply.clearCookie(COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/me", async (req, reply) => {
    const s = requireSession(req, reply);
    if (!s) return;
    const [me] = await withUser(
      sql,
      s.userId,
      (tx) => tx<{ display_name: string | null; email: string | null }[]>`
      SELECT display_name, email FROM users WHERE id = ${s.userId}`,
    );
    return {
      userId: s.userId,
      displayName: me?.display_name ?? null,
      email: me?.email ?? null,
      timezone: s.timezone,
    };
  });

  // Chats ----------------------------------------------------------------------

  const chatSummary = (c: ChatRow | ChatListRow) => ({
    id: c.id,
    kind: c.kind,
    title: c.title,
    cleanRoom: c.clean_room,
    pinned: c.pinned,
    archived: c.archived_at !== null,
    updatedAt: new Date("last_active_at" in c ? c.last_active_at : c.updated_at).toISOString(),
    activeRunId: "active_run_id" in c ? c.active_run_id : null,
  });

  app.get("/chats", async (req, reply) => {
    const s = requireSession(req, reply);
    if (!s) return;
    // Opening the app is when new booking emails are looked for (at most every 15 minutes), and
    // when this person's flights get looked at if nothing else is running the scheduler.
    later(syncIfDue(gmailDeps, s.userId).then(() => tickUser(flightDeps, s.userId)));
    return { chats: (await listChats(sql, s)).map(chatSummary) };
  });

  app.post("/chats", async (req, reply) => {
    const s = requireSession(req, reply);
    if (!s) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const chat = await createSideChat(sql, s, {
      title: typeof b.title === "string" ? b.title : undefined,
      cleanRoom: b.cleanRoom === true,
    });
    return { chat: chatSummary(chat) };
  });

  app.patch<{ Params: { id: string } }>("/chats/:id", async (req, reply) => {
    const s = requireSession(req, reply);
    if (!s) return;
    if (!UUID.test(req.params.id)) throw new NotFound("chat");
    const b = (req.body ?? {}) as Record<string, unknown>;
    let title: string | undefined;
    if (b.title !== undefined) {
      title = typeof b.title === "string" ? b.title.replace(/\s+/g, " ").trim() : "";
      if (!title) return reply.code(400).send({ error: "Give the chat a name." });
      if (title.length > 120)
        return reply.code(400).send({ error: "That name is too long (120 characters max)." });
    }
    const chat = await updateChat(sql, s, req.params.id, {
      pinned: typeof b.pinned === "boolean" ? b.pinned : undefined,
      archived: typeof b.archived === "boolean" ? b.archived : undefined,
      title,
    });
    return { chat: chatSummary(chat) };
  });

  app.delete<{ Params: { id: string } }>("/chats/:id", async (req, reply) => {
    const s = requireSession(req, reply);
    if (!s) return;
    if (!UUID.test(req.params.id)) throw new NotFound("chat");
    await deleteChat(sql, s, req.params.id);
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>("/chats/:id", async (req, reply) => {
    const s = requireSession(req, reply);
    if (!s) return;
    if (!UUID.test(req.params.id)) throw new NotFound("chat");
    const { chat, messages, activeRun, endedRuns } = await getChat(
      orchestratorDeps,
      s,
      req.params.id,
    );
    return { chat: chatSummary(chat), messages, activeRun, endedRuns };
  });

  app.post<{ Params: { id: string } }>("/chats/:id/messages", async (req, reply) => {
    const s = requireSession(req, reply);
    if (!s) return;
    if (!UUID.test(req.params.id)) throw new NotFound("chat");
    const b = (req.body ?? {}) as Record<string, unknown>;
    const text = typeof b.text === "string" ? b.text.trim() : "";
    const clientMessageId =
      typeof b.clientMessageId === "string" ? b.clientMessageId.slice(0, 64) : "";
    if (!text) return reply.code(400).send({ error: "Type a message first." });
    if (text.length > 8000)
      return reply.code(400).send({ error: "That message is too long (8,000 characters max)." });
    if (!clientMessageId) return reply.code(400).send({ error: "clientMessageId is required" });
    const fileIds = Array.isArray(b.fileIds) ? b.fileIds : [];
    if (fileIds.length > 10 || !fileIds.every((id) => typeof id === "string" && UUID.test(id))) {
      return reply.code(400).send({ error: "Attach at most 10 files." });
    }
    return sendMessage(orchestratorDeps, s, req.params.id, {
      text,
      clientMessageId,
      fileIds: fileIds as string[],
    });
  });

  // Runs -------------------------------------------------------------------------

  app.get<{ Params: { id: string } }>("/runs/:id", async (req, reply) => {
    const s = requireSession(req, reply);
    if (!s) return;
    if (!UUID.test(req.params.id)) throw new NotFound("run");
    return { run: await advanceRun(orchestratorDeps, s, req.params.id) };
  });

  app.post<{ Params: { id: string } }>("/runs/:id/stop", async (req, reply) => {
    const s = requireSession(req, reply);
    if (!s) return;
    if (!UUID.test(req.params.id)) throw new NotFound("run");
    return { run: await stopRun(orchestratorDeps, s, req.params.id) };
  });

  // Files -------------------------------------------------------------------------

  app.post<{ Querystring: { chatId?: string } }>(
    "/files",
    { bodyLimit: MAX_FILE_BYTES },
    async (req, reply) => {
      const s = requireSession(req, reply);
      if (!s) return;
      const data = req.body;
      if (!Buffer.isBuffer(data) || !data.byteLength) {
        return reply.code(400).send({ error: "Choose a file to upload." });
      }
      const chatId = req.query.chatId;
      if (chatId) {
        if (!UUID.test(chatId)) throw new NotFound("chat");
        const [chat] = await withUser(
          sql,
          s.userId,
          (tx) => tx`SELECT 1 FROM chats WHERE id = ${chatId}`,
        );
        if (!chat) throw new NotFound("chat");
      }
      let name = "file";
      try {
        name = decodeURIComponent(String(req.headers["x-file-name"] ?? "file"));
      } catch {
        // Keep the default name.
      }
      const mime = uploadType(req.headers);
      const { text, pages } = await extractText(name, mime, data);
      const file = await saveFile(sql, s.userId, {
        kind: "upload",
        name: cleanFileName(name),
        mime,
        data,
        chatId: chatId ?? null,
        text,
        pages,
      });
      return { file: fileView(file) };
    },
  );

  app.get<{ Params: { id: string } }>("/files/:id/download", async (req, reply) => {
    const s = requireSession(req, reply);
    if (!s) return;
    if (!UUID.test(req.params.id)) throw new NotFound("file");
    const stored = await readFile(sql, s.userId, req.params.id);
    if (!stored) throw new NotFound("file");
    const name = stored.file.name ?? "file";
    const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
    return reply
      .header("Content-Type", stored.file.mime ?? "application/octet-stream")
      .header(
        "Content-Disposition",
        `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      )
      .header("X-Content-Type-Options", "nosniff")
      .header("Cache-Control", "private, no-store")
      .send(stored.data);
  });

  // Pictures shown in the page (the browser's last page). Only safe image types are shown
  // inline; anything else must be downloaded.
  app.get<{ Params: { id: string } }>("/files/:id/view", async (req, reply) => {
    const s = requireSession(req, reply);
    if (!s) return;
    if (!UUID.test(req.params.id)) throw new NotFound("file");
    const stored = await readFile(sql, s.userId, req.params.id);
    if (!stored || !INLINE_IMAGES.has(stored.file.mime ?? "")) throw new NotFound("file");
    return (
      reply
        .header("Content-Type", stored.file.mime!)
        .header("Content-Disposition", "inline")
        .header("X-Content-Type-Options", "nosniff")
        // A file never changes, so the browser may keep it (it's private to this person).
        .header("Cache-Control", "private, max-age=86400, immutable")
        .send(stored.data)
    );
  });

  // Browser ---------------------------------------------------------------------------

  const browserDeps = () => ({
    sql,
    browser: deps.browser,
    secret: config.sessionSecret,
    checkGapMs: deps.browserCheckGapMs,
    vaultKey,
    // A check-in that is handed back or signed in to keeps its passport details.
    extraSecrets: flightSecrets(flightDeps),
  });

  app.post<{ Params: { id: string } }>("/browser-sessions/:id/take-over", async (req, reply) => {
    const s = requireSession(req, reply);
    if (!s) return;
    if (!UUID.test(req.params.id)) throw new NotFound("browser session");
    const row = await takeOver(browserDeps(), s.userId, req.params.id);
    return { browser: viewOf(row, config.sessionSecret) };
  });

  app.post<{ Params: { id: string } }>("/browser-sessions/:id/hand-back", async (req, reply) => {
    const s = requireSession(req, reply);
    if (!s) return;
    if (!UUID.test(req.params.id)) throw new NotFound("browser session");
    const row = await handBack(browserDeps(), s.userId, req.params.id);
    return { browser: viewOf(row, config.sessionSecret) };
  });

  // The secure sign-in box. The body holds a password: it is passed straight on to Browser Use
  // (and, when saved, sealed in the vault) and never logged, stored elsewhere or echoed back.
  app.post<{
    Params: { id: string };
    Body: {
      username?: string;
      password?: string;
      code?: string;
      save?: boolean;
      useSaved?: boolean;
    };
  }>(
    "/browser-sessions/:id/sign-in",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            username: { type: "string", maxLength: 1000 },
            password: { type: "string", maxLength: 1000 },
            code: { type: "string", maxLength: 64 },
            save: { type: "boolean" },
            useSaved: { type: "boolean" },
          },
        },
      },
    },
    async (req, reply) => {
      const s = requireSession(req, reply);
      if (!s) return;
      if (!UUID.test(req.params.id)) throw new NotFound("browser session");
      const row = await signIn(browserDeps(), s.userId, req.params.id, req.body ?? {});
      reply.header("Cache-Control", "no-store");
      return { browser: viewOf(row, config.sessionSecret) };
    },
  );

  // Vault page -------------------------------------------------------------------------
  // Saved logins as the person manages them in Settings: never the usernames or passwords.

  app.get("/vault", async (req, reply) => {
    const s = requireSession(req, reply);
    if (!s) return;
    const [logins, activity] = await Promise.all([
      listLogins(sql, s.userId),
      vaultActivity(sql, s.userId),
    ]);
    reply.header("Cache-Control", "no-store");
    return { logins, activity };
  });

  app.patch<{ Params: { id: string }; Body: { askBeforeUse: boolean } }>(
    "/vault/logins/:id",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["askBeforeUse"],
          properties: { askBeforeUse: { type: "boolean" } },
        },
      },
    },
    async (req, reply) => {
      const s = requireSession(req, reply);
      if (!s) return;
      if (!UUID.test(req.params.id)) throw new NotFound("saved login");
      if (!(await setAskBeforeUse(sql, s.userId, req.params.id, req.body.askBeforeUse))) {
        throw new NotFound("saved login");
      }
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string } }>("/vault/logins/:id", async (req, reply) => {
    const s = requireSession(req, reply);
    if (!s) return;
    if (!UUID.test(req.params.id)) throw new NotFound("saved login");
    if (!(await deleteLogin(sql, s.userId, req.params.id))) throw new NotFound("saved login");
    return { ok: true };
  });

  // The person's own login, shown on the Vault page so they can check or change it. The assistant
  // has no way to call these.
  app.post<{ Params: { id: string } }>("/vault/logins/:id/reveal", async (req, reply) => {
    const s = requireSession(req, reply);
    if (!s) return;
    if (!UUID.test(req.params.id)) throw new NotFound("saved login");
    let login;
    try {
      login = await revealLogin(sql, vaultKey, s.userId, req.params.id);
    } catch (err) {
      throw new Conflict(err instanceof Error ? err.message : "This login can't be opened.");
    }
    if (!login) throw new NotFound("saved login");
    reply.header("Cache-Control", "no-store");
    return login;
  });

  app.put<{ Params: { id: string }; Body: { username: string; password: string } }>(
    "/vault/logins/:id/login",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["username", "password"],
          properties: {
            username: { type: "string", maxLength: 1000 },
            password: { type: "string", minLength: 1, maxLength: 1000 },
          },
        },
      },
    },
    async (req, reply) => {
      const s = requireSession(req, reply);
      if (!s) return;
      if (!UUID.test(req.params.id)) throw new NotFound("saved login");
      let result;
      try {
        result = await editLogin(sql, vaultKey, s.userId, req.params.id, {
          username: req.body.username.trim(),
          password: req.body.password,
        });
      } catch (err) {
        throw new Conflict(err instanceof Error ? err.message : "This login can't be opened.");
      }
      if (result === "missing") throw new NotFound("saved login");
      if (result === "taken") {
        throw new Conflict("You already have a saved login with that username for this site.");
      }
      reply.header("Cache-Control", "no-store");
      return { ok: true };
    },
  );

  // A login's authenticator key, for 2-step codes. Write-only: it is never sent back.
  app.post<{ Params: { id: string }; Body: { key: string } }>(
    "/vault/logins/:id/code-key",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["key"],
          properties: { key: { type: "string", minLength: 1, maxLength: 1000 } },
        },
      },
    },
    async (req, reply) => {
      const s = requireSession(req, reply);
      if (!s) return;
      if (!UUID.test(req.params.id)) throw new NotFound("saved login");
      let ok;
      try {
        ok = await setCodeKey(sql, vaultKey, s.userId, req.params.id, req.body.key);
      } catch (err) {
        throw new BadRequest((err as Error).message);
      }
      if (!ok) throw new NotFound("saved login");
      reply.header("Cache-Control", "no-store");
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string } }>("/vault/logins/:id/code-key", async (req, reply) => {
    const s = requireSession(req, reply);
    if (!s) return;
    if (!UUID.test(req.params.id)) throw new NotFound("saved login");
    if (!(await setCodeKey(sql, vaultKey, s.userId, req.params.id, null))) {
      throw new NotFound("saved login");
    }
    return { ok: true };
  });

  // Import from a password manager's export file. The file holds passwords: it is read in
  // memory, never stored or logged, and only the ticked logins go into the vault.
  const IMPORT_LIMIT = 8 * 1024 * 1024;
  const readOrRefuse = (csv: string) => {
    try {
      return readExport(csv);
    } catch (err) {
      throw new BadRequest((err as Error).message);
    }
  };

  app.post<{ Body: { csv: string } }>(
    "/vault/import/preview",
    {
      bodyLimit: IMPORT_LIMIT,
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["csv"],
          properties: { csv: { type: "string", maxLength: IMPORT_LIMIT } },
        },
      },
    },
    async (req, reply) => {
      const s = requireSession(req, reply);
      if (!s) return;
      const { logins, skipped } = readOrRefuse(req.body.csv);
      const saved = await existingLogins(sql, s.userId);
      reply.header("Cache-Control", "no-store");
      return {
        logins: logins.map((l) => ({
          index: l.index,
          site: l.site,
          account: l.username,
          alreadySaved: saved.has(`${l.site}\n${l.username}`),
        })),
        skipped: skipped.length,
      };
    },
  );

  app.post<{ Body: { csv: string; manager: string; indices: number[] } }>(
    "/vault/import",
    {
      bodyLimit: IMPORT_LIMIT,
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["csv", "manager", "indices"],
          properties: {
            csv: { type: "string", maxLength: IMPORT_LIMIT },
            manager: { type: "string", enum: [...MANAGERS] },
            indices: { type: "array", items: { type: "integer", minimum: 0 }, maxItems: 5000 },
          },
        },
      },
    },
    async (req, reply) => {
      const s = requireSession(req, reply);
      if (!s) return;
      const picked = new Set(req.body.indices);
      const { logins } = readOrRefuse(req.body.csv);
      const result = await importLogins(
        sql,
        vaultKey,
        s.userId,
        req.body.manager,
        logins.filter((l) => picked.has(l.index)),
      );
      reply.header("Cache-Control", "no-store");
      return result;
    },
  );

  // Gmail ---------------------------------------------------------------------------------------
  // Connected on Travila's hosted connect page (Pipedream), then the app reads booking emails to
  // find trips.

  const gmailCallback = (req: FastifyRequest, state: string, outcome: "ok" | "error") => {
    const base =
      config.publicUrl ||
      `${config.secureCookies ? "https" : String(req.headers["x-forwarded-proto"] ?? "http").split(",")[0]}://${req.headers["x-forwarded-host"] ?? req.headers.host}`;
    return `${base}/api/connectors/gmail/callback?${new URLSearchParams({ state, outcome })}`;
  };

  /** Back to the Main chat with Settings open on Connected accounts. */
  const backToSettings = async (s: Session, reply: FastifyReply, result: string) => {
    const [main] = (await listChats(sql, s)).filter((c) => c.kind === "main");
    const q = `settings=connections&gmail=${result}`;
    return reply.redirect(main ? `/chat/${main.id}?${q}` : `/?${q}`);
  };

  app.get("/connectors/gmail", async (req, reply) => {
    const s = requireSession(req, reply);
    if (!s) return;
    reply.header("Cache-Control", "no-store");
    return gmailStatus(gmailDeps, s.userId);
  });

  app.get("/connectors/gmail/start", async (req, reply) => {
    const s = req.session;
    if (!s) return reply.redirect("/sign-in");
    const state = signState(s.userId, config.sessionSecret);
    let url;
    try {
      url = await gmailDeps.google.connectUrl(
        s.travilaUserId,
        gmailCallback(req, state, "ok"),
        gmailCallback(req, state, "error"),
      );
    } catch (err) {
      app.log.error(err);
      return backToSettings(s, reply, "unavailable");
    }
    return reply.redirect(url);
  });

  app.get<{ Querystring: { state?: string; outcome?: string } }>(
    "/connectors/gmail/callback",
    async (req, reply) => {
      const s = req.session;
      if (!s) return reply.redirect("/sign-in");
      const { state, outcome } = req.query;
      if (!state || !checkState(state, s.userId, config.sessionSecret)) {
        return backToSettings(s, reply, "failed");
      }
      if (outcome !== "ok") return backToSettings(s, reply, "cancelled");
      try {
        await connectGmail(gmailDeps, s.userId, s.travilaUserId);
      } catch (err) {
        if (!(err instanceof GoogleAuthError)) app.log.error(err);
        return backToSettings(s, reply, err instanceof GoogleAuthError ? "cancelled" : "failed");
      }
      later(syncGmail(gmailDeps, s.userId).then(() => planFlights(flightDeps, s.userId)));
      return backToSettings(s, reply, "connected");
    },
  );

  app.delete("/connectors/gmail", async (req, reply) => {
    const s = requireSession(req, reply);
    if (!s) return;
    await disconnectGmail(gmailDeps, s.userId, s.travilaUserId);
    return { ok: true };
  });

  // Flights ---------------------------------------------------------------------------
  // Trip cards: check-in, arrival cards, live status and time to leave. Plan:
  // /mnt/project-files/design/checkin-plan.html.

  const today = () => (deps.now?.() ?? new Date()).toISOString().slice(0, 10);
  const flightView = async (userId: string, id: string) => {
    const view = (
      await flightViews(sql, userId, [id], config.sessionSecret, {
        liveAvailable: flightDeps.status.available,
        now: deps.now?.(),
      })
    ).get(id);
    if (!view) throw new NotFound("flight");
    return view;
  };

  app.get("/flights", async (req, reply) => {
    const s = requireSession(req, reply);
    if (!s) return;
    reply.header("Cache-Control", "no-store");
    later(tickUser(flightDeps, s.userId));
    const ids = await upcomingFlightIds(sql, s.userId);
    const views = await flightViews(sql, s.userId, ids, config.sessionSecret, {
      liveAvailable: flightDeps.status.available,
      now: deps.now?.(),
    });
    return { flights: ids.map((id) => views.get(id)).filter(Boolean) };
  });

  app.get<{ Params: { id: string } }>("/flights/:id", async (req, reply) => {
    const s = requireSession(req, reply);
    if (!s) return;
    if (!UUID.test(req.params.id)) throw new NotFound("flight");
    reply.header("Cache-Control", "no-store");
    // A card being watched moves its check-in along (the browser is looked at now and then).
    const plan = await planOf(sql, s.userId, req.params.id);
    if (!plan) throw new NotFound("flight");
    const now = deps.now?.() ?? new Date();
    if (plan.next_due_at && new Date(plan.next_due_at) <= now) {
      later(stepFlight(flightDeps, s.userId, req.params.id));
    }
    return { flight: await flightView(s.userId, req.params.id) };
  });

  const str = (max: number) => ({ type: "string", maxLength: max });
  const nullableStr = (max: number) => ({ type: ["string", "null"], maxLength: max });
  const prepProps = {
    firstName: str(60),
    middleName: str(60),
    lastName: str(60),
    dateOfBirth: str(10),
    gender: { type: "string", enum: ["female", "male", "x"] },
    nationality: str(2),
    passportNumber: str(30),
    passportExpiry: str(10),
    passportCountry: str(2),
    knownTravelerNumber: nullableStr(30),
    frequentFlyerNumber: nullableStr(40),
    seatSide: { type: "string", enum: ["window", "aisle", "any"] },
    seatZone: { type: "string", enum: ["front", "middle", "back", "any"] },
    seatEmptyNearby: { type: "boolean" },
    seatAvoidWashroom: { type: "boolean" },
    homeAddress: str(300),
    answer: str(500),
  };

  // The Trip prep card. The body can hold a passport number: it goes straight into the vault and
  // is never logged or sent back.
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/flights/:id/prep",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: { ...prepProps, noBannedItems: { type: "boolean" } },
        },
      },
    },
    async (req, reply) => {
      const s = requireSession(req, reply);
      if (!s) return;
      if (!UUID.test(req.params.id)) throw new NotFound("flight");
      const plan = await planOf(sql, s.userId, req.params.id);
      if (!plan || plan.details.kind !== "flight") throw new NotFound("flight");
      const { noBannedItems, ...input } = (req.body ?? {}) as Record<string, unknown> & {
        noBannedItems?: boolean;
      };
      checkPrep(input, today());
      const question = plan.checkin_question ?? plan.arrival_question;
      await savePrep(sql, vaultKey, s.userId, input, {
        airline: airlineOf(plan.details),
        question,
      });
      await afterPrep(flightDeps, s.userId, req.params.id, {
        noBannedItems,
        answered: typeof input.answer === "string" && !!input.answer.trim(),
      });
      later(stepFlight(flightDeps, s.userId, req.params.id));
      reply.header("Cache-Control", "no-store");
      return { flight: await flightView(s.userId, req.params.id) };
    },
  );

  app.patch<{
    Params: { id: string };
    Body: { autoCheckin?: boolean; arrivalConfirmed?: boolean };
  }>(
    "/flights/:id",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: { autoCheckin: { type: "boolean" }, arrivalConfirmed: { type: "boolean" } },
        },
      },
    },
    async (req, reply) => {
      const s = requireSession(req, reply);
      if (!s) return;
      if (!UUID.test(req.params.id)) throw new NotFound("flight");
      const plan = await planOf(sql, s.userId, req.params.id);
      if (!plan) throw new NotFound("flight");
      await afterPrep(flightDeps, s.userId, req.params.id, req.body ?? {});
      later(stepFlight(flightDeps, s.userId, req.params.id));
      return { flight: await flightView(s.userId, req.params.id) };
    },
  );

  app.get("/travel-profile", async (req, reply) => {
    const s = requireSession(req, reply);
    if (!s) return;
    reply.header("Cache-Control", "no-store");
    return { profile: profileView(await readProfile(sql, s.userId)) };
  });

  app.patch<{ Body: Record<string, unknown> }>(
    "/travel-profile",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            ...prepProps,
            knownTravelerNumber: nullableStr(30),
            frequentFlyer: {
              type: "object",
              maxProperties: 5,
              additionalProperties: { type: ["string", "null"], maxLength: 40 },
              propertyNames: { pattern: "^[A-Z0-9]{2}$" },
            },
            removeAnswer: str(200),
          },
        },
      },
    },
    async (req, reply) => {
      const s = requireSession(req, reply);
      if (!s) return;
      reply.header("Cache-Control", "no-store");
      const profile = await editProfile(sql, vaultKey, s.userId, req.body ?? {}, today());
      // A detail added in Settings can unblock a flight that was waiting for it.
      for (const id of await upcomingFlightIds(sql, s.userId)) {
        await afterPrep(flightDeps, s.userId, id, {});
      }
      return { profile };
    },
  );

  app.post("/travel-profile/reveal", async (req, reply) => {
    const s = requireSession(req, reply);
    if (!s) return;
    reply.header("Cache-Control", "no-store");
    return { documents: await revealDocuments(sql, vaultKey, s.userId) };
  });

  // The scheduler: every flight that is due, for everyone, plus new booking emails.
  let ticking = false;
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      const users = await sql<{ user_id: string }[]>`SELECT * FROM app_gmail_users(${50})`.catch(
        () => [],
      );
      for (const u of users) {
        await syncIfDue(gmailDeps, u.user_id);
        await planFlights(flightDeps, u.user_id).catch((err) => app.log.error(err));
      }
      await tickAll(flightDeps);
    } finally {
      ticking = false;
    }
  };

  // Vercel Cron calls this with "Authorization: Bearer <CRON_SECRET>".
  app.get("/cron/flights", async (req, reply) => {
    const want = Buffer.from(`Bearer ${config.cronSecret}`);
    const got = Buffer.from(String(req.headers.authorization ?? ""));
    if (!config.cronSecret || got.length !== want.length || !timingSafeEqual(got, want)) {
      return reply.code(401).send({ error: "Not allowed." });
    }
    await tick();
    return { ok: true };
  });

  // On a computer that stays on: wake when the next flight needs something, and at least every
  // `scheduleEveryMs` to look for new booking emails. A wake-up with nothing due costs nothing.
  if (deps.scheduleEveryMs) {
    const most = deps.scheduleEveryMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const arm = async () => {
      if (closed) return;
      let wait = most;
      try {
        const [row] = await sql<{ at: Date | null }[]>`SELECT app_next_flight_due() AS at`;
        const now = (deps.now?.() ?? new Date()).getTime();
        if (row?.at) wait = Math.min(most, Math.max(5000, new Date(row.at).getTime() - now));
      } catch (err) {
        app.log.error(err);
      }
      timer = setTimeout(() => {
        void tick()
          .catch((err) => app.log.error(err))
          .finally(() => void arm());
      }, wait);
      timer.unref();
    };
    void arm();
    app.addHook("onClose", async () => {
      closed = true;
      clearTimeout(timer);
    });
  }

  return app;
}

const INLINE_IMAGES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

/** The uploaded file's type: X-File-Type when it looks like a media type, else Content-Type. */
function uploadType(headers: Record<string, string | string[] | undefined>): string {
  const given = String(headers["x-file-type"] ?? "").trim();
  if (/^[\w.+-]+\/[\w.+-]+$/.test(given)) return given.toLowerCase();
  return String(headers["content-type"] ?? "application/octet-stream").split(";")[0]!;
}
