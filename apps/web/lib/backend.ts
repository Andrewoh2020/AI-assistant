import "server-only";
import {
  BrowserUseHttp,
  buildApp,
  DeepSeekSearch,
  loadConfig,
  TravilaHttp,
} from "@ai-assistant/api";
import { connect } from "@ai-assistant/db";
import { waitUntil } from "@vercel/functions";
import type { FastifyInstance } from "fastify";

/**
 * Runs our backend (apps/api) inside this Next.js app, so the website and its backend deploy as
 * one Vercel project. Built once per server instance and reused across requests.
 */
let app: Promise<FastifyInstance> | null = null;

export function backend(): Promise<FastifyInstance> {
  app ??= (async () => {
    const config = loadConfig();
    const instance = buildApp({
      config,
      sql: connect(config.databaseUrl, { max: 3 }),
      travila: new TravilaHttp(config.travilaBase, config.travilaKey),
      search: new DeepSeekSearch(config.deepseekBase, config.deepseekKey),
      browser: new BrowserUseHttp(config.browserUseBase, config.browserUseKey),
      // Lets tool work finish after the poll's response is sent.
      defer: (work) => waitUntil(work),
      // On a computer that stays on (Andrew's Mac) check-ins and reminders run every minute. On
      // Vercel, functions sleep between requests: /api/cron/flights and app use drive it instead.
      scheduleEveryMs: process.env.VERCEL ? undefined : 60_000,
    });
    await instance.ready();
    return instance;
  })();
  // A failed start (say, a missing setting) is retried on the next request, not kept forever.
  app.catch(() => {
    app = null;
  });
  return app;
}
