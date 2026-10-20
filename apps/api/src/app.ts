import cookie from "@fastify/cookie";
import { withUser, type Sql } from "@ai-assistant/db";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import {
  hashPassword,
  signSession,
  verifyPassword,
  verifySession,
  type SessionPayload,
} from "./auth.js";
import type { Config } from "./config.js";
import {
  advanceRun,
  Conflict,
  createSideChat,
  getChat,
  listChats,
  NotFound,
  sendMessage,
  stopRun,
  updateChat,
  type Deps,
  type Session,
} from "./orchestrator.js";
import type { Resolver } from "./policy.js";
import type { SearchBackend } from "./search.js";
import type { Travila } from "./travila.js";

const COOKIE = "aia_session";
const SESSION_DAYS = 30;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AppDeps {
  config: Config;
  sql: Sql;
  travila: Travila;
  search: SearchBackend;
  defer?: (work: Promise<unknown>) => void;
  resolve?: Resolver;
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
  const orchestratorDeps: Deps = {
    sql,
    travila: deps.travila,
    search: deps.search,
    defer: deps.defer,
    resolve: deps.resolve,
  };
  const app = Fastify({ logger: process.env.NODE_ENV !== "test", bodyLimit: 64 * 1024 });

  app.register(cookie);
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

  const chatSummary = (c: Awaited<ReturnType<typeof listChats>>[number]) => ({
    id: c.id,
    kind: c.kind,
    title: c.title,
    cleanRoom: c.clean_room,
    pinned: c.pinned,
    archived: c.archived_at !== null,
    updatedAt: new Date(c.updated_at).toISOString(),
  });

  app.get("/chats", async (req, reply) => {
    const s = requireSession(req, reply);
    if (!s) return;
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
    const b = (req.body ?? {}) as Record<string, unknown>;
    const chat = await updateChat(sql, s, req.params.id, {
      pinned: typeof b.pinned === "boolean" ? b.pinned : undefined,
      archived: typeof b.archived === "boolean" ? b.archived : undefined,
    });
    return { chat: chatSummary(chat) };
  });

  app.get<{ Params: { id: string } }>("/chats/:id", async (req, reply) => {
    const s = requireSession(req, reply);
    if (!s) return;
    if (!UUID.test(req.params.id)) throw new NotFound("chat");
    const { chat, messages, activeRun, endedRuns } = await getChat(sql, s, req.params.id);
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
    return sendMessage(orchestratorDeps, s, req.params.id, { text, clientMessageId });
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

  return app;
}
