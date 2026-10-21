// Usage: node dist/cli.js up | down [steps|all] | status
// Uses the direct (unpooled) connection when one is configured, as Neon recommends for migrations.
import { existsSync } from "node:fs";
import { connect } from "./client.js";
import { appliedVersions, loadMigrations, migrateDown, migrateUp } from "./migrate.js";

// Settings live in one .env file at the top of the repository. Values already set win.
const rootEnv = new URL("../../../.env", import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const [cmd = "status", arg] = process.argv.slice(2);
const sql = connect(process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL, { max: 1 });
try {
  if (cmd === "up") {
    const applied = await migrateUp(sql);
    console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Already up to date.");
  } else if (cmd === "down") {
    const steps = arg === "all" ? Infinity : Number(arg ?? 1);
    const reverted = await migrateDown(sql, steps);
    console.log(reverted.length ? `Rolled back: ${reverted.join(", ")}` : "Nothing to roll back.");
  } else {
    const done = new Set(await appliedVersions(sql));
    for (const m of loadMigrations())
      console.log(`${done.has(m.version) ? "applied" : "pending"}  ${m.version}`);
  }
} finally {
  await sql.end();
}
