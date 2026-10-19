import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sql } from "postgres";

// Built from the module's own path (not `new URL("../migrations/", ...)`) so bundlers that
// include this package don't try to bundle the SQL folder.
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations") + "/";

export interface Migration {
  version: string;
  up: string;
  down: string;
}

/** Reads `NNNN_name.up.sql` / `NNNN_name.down.sql` pairs, in order. */
export function loadMigrations(dir = MIGRATIONS_DIR): Migration[] {
  const ups = readdirSync(dir)
    .filter((f) => f.endsWith(".up.sql"))
    .sort();
  return ups.map((f) => {
    const version = f.replace(/\.up\.sql$/, "");
    return {
      version,
      up: readFileSync(dir + f, "utf8"),
      down: readFileSync(dir + `${version}.down.sql`, "utf8"),
    };
  });
}

async function ensureTable(sql: Sql) {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`;
}

export async function appliedVersions(sql: Sql): Promise<string[]> {
  await ensureTable(sql);
  const rows = await sql<
    { version: string }[]
  >`SELECT version FROM schema_migrations ORDER BY version`;
  return rows.map((r) => r.version);
}

/** Applies every pending migration, each in its own transaction. Returns the versions applied. */
export async function migrateUp(sql: Sql): Promise<string[]> {
  const done = new Set(await appliedVersions(sql));
  const applied: string[] = [];
  for (const m of loadMigrations()) {
    if (done.has(m.version)) continue;
    await sql.begin(async (tx) => {
      await tx.unsafe(m.up);
      await tx`INSERT INTO schema_migrations (version) VALUES (${m.version})`;
    });
    applied.push(m.version);
  }
  return applied;
}

/** Rolls back the latest `steps` migrations (all of them when steps is Infinity). */
export async function migrateDown(sql: Sql, steps = 1): Promise<string[]> {
  const done = (await appliedVersions(sql)).reverse().slice(0, steps);
  const byVersion = new Map(loadMigrations().map((m) => [m.version, m]));
  const reverted: string[] = [];
  for (const version of done) {
    const m = byVersion.get(version);
    if (!m) throw new Error(`No migration file for applied version ${version}`);
    await sql.begin(async (tx) => {
      await tx.unsafe(m.down);
      await tx`DELETE FROM schema_migrations WHERE version = ${version}`;
    });
    reverted.push(version);
  }
  return reverted;
}
