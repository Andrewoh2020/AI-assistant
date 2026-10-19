// Usage: node dist/cli.js up | down [steps|all] | status
import { connect } from "./client.js";
import { appliedVersions, loadMigrations, migrateDown, migrateUp } from "./migrate.js";

const [cmd = "status", arg] = process.argv.slice(2);
const sql = connect();
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
