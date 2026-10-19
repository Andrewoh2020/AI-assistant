// Applies database migrations during a Vercel production build, and only then: preview builds
// would otherwise change the production database.
import { execFileSync } from "node:child_process";

if (process.env.VERCEL_ENV !== "production") {
  console.log(`Skipping migrations (VERCEL_ENV=${process.env.VERCEL_ENV ?? "unset"}).`);
} else {
  execFileSync("pnpm", ["--filter", "@ai-assistant/db", "migrate", "up"], { stdio: "inherit" });
}
