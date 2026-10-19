import { existsSync } from "node:fs";
import path from "node:path";
import type { NextConfig } from "next";

// Settings live in one .env file at the top of the repository. Values already set win.
const rootEnv = path.join(import.meta.dirname, "../../.env");
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

// The browser only ever talks to this site. /api/* is our backend (apps/api), run inside this app
// by app/api/[...path]/route.ts, so the session cookie stays first-party and no vendor key reaches
// the browser. Set API_URL to send /api/* to a separately running backend instead.
const apiUrl = process.env.API_URL;

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
  serverExternalPackages: [
    "@ai-assistant/api",
    "@ai-assistant/db",
    "fastify",
    "postgres",
    "@fastify/cookie",
  ],
  async rewrites() {
    return apiUrl
      ? {
          beforeFiles: [{ source: "/api/:path*", destination: `${apiUrl}/:path*` }],
          afterFiles: [],
          fallback: [],
        }
      : [];
  },
};

export default config;
