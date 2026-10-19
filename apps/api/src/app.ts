import Fastify, { type FastifyInstance } from "fastify";

/**
 * Our backend. Clients only ever talk to this; it holds every vendor key.
 * Step 1a ships just the health check; sign-in, chats and the orchestrator arrive in 1b.
 */
export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });

  app.get("/health", async () => ({ ok: true, service: "api" }));

  return app;
}
