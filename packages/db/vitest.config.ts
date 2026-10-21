import { defineConfig } from "vitest/config";

// Database tests share one Postgres database, so run test files one at a time.
export default defineConfig({ test: { fileParallelism: false, testTimeout: 20000 } });
