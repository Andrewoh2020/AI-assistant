import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  connect,
  migrateDown,
  migrateUp,
  appliedVersions,
  loadMigrations,
  signIn,
  withUser,
} from "./index.js";

// Needs a disposable Postgres: DATABASE_URL=postgres://postgres:postgres@localhost:5432/ai_assistant_test
const url = process.env.DATABASE_URL;
const sql = url ? connect(url) : null;

describe.skipIf(!sql)("migrations and row-level security", () => {
  beforeAll(async () => {
    await migrateDown(sql!, Infinity);
  });
  afterAll(async () => {
    await sql!.end();
  });

  it("runs every migration up, all the way down, and up again", async () => {
    const all = loadMigrations().map((m) => m.version);
    expect(await migrateUp(sql!)).toEqual(all);
    expect(await migrateDown(sql!, Infinity)).toEqual([...all].reverse());
    const [{ count }] = await sql!`SELECT count(*)::int AS count FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'chats'`;
    expect(count).toBe(0);
    expect(await migrateUp(sql!)).toEqual(all);
    expect(await appliedVersions(sql!)).toEqual(all);
  });

  it("keeps each user's rows invisible to every other user", async () => {
    const a = await signIn(sql!, { authSubject: "test:a", displayName: "A" });
    const b = await signIn(sql!, { authSubject: "test:b", displayName: "B" });
    expect(a.userId).not.toBe(b.userId);
    expect(a.travilaUserId).toMatch(/^aia_/);

    const chatId = await withUser(sql!, a.userId, async (tx) => {
      const [row] = await tx`INSERT INTO chats (user_id, kind, title)
        VALUES (${a.userId}, 'main', 'A main') RETURNING id`;
      return row!.id as string;
    });

    // B sees nothing of A's.
    const seenByB = await withUser(sql!, b.userId, (tx) => tx`SELECT id FROM chats`);
    expect(seenByB).toHaveLength(0);
    const usersSeenByB = await withUser(sql!, b.userId, (tx) => tx`SELECT id FROM users`);
    expect(usersSeenByB.map((r) => r.id)).toEqual([b.userId]);

    // B cannot write rows owned by A, or touch A's chat.
    await expect(
      withUser(
        sql!,
        b.userId,
        (tx) => tx`INSERT INTO chats (user_id, kind) VALUES (${a.userId}, 'side')`,
      ),
    ).rejects.toThrow(/row-level security/);
    const updated = await withUser(
      sql!,
      b.userId,
      (tx) => tx`UPDATE chats SET title = 'hijacked' WHERE id = ${chatId}`,
    );
    expect(updated.count).toBe(0);

    // A still sees its own chat.
    const seenByA = await withUser(sql!, a.userId, (tx) => tx`SELECT title FROM chats`);
    expect(seenByA.map((r) => r.title)).toEqual(["A main"]);
  });

  it("allows only one Main chat per user", async () => {
    const a = await signIn(sql!, { authSubject: "test:a" });
    await expect(
      withUser(
        sql!,
        a.userId,
        (tx) => tx`INSERT INTO chats (user_id, kind) VALUES (${a.userId}, 'main')`,
      ),
    ).rejects.toThrow(/chats_one_main_per_user/);
  });

  it("keeps the vault schema closed to the app role", async () => {
    const a = await signIn(sql!, { authSubject: "test:a" });
    await expect(
      withUser(sql!, a.userId, (tx) => tx`SELECT * FROM vault.credentials`),
    ).rejects.toThrow(/permission denied/);
  });

  it("refuses a request with no user set", async () => {
    const rows = await sql!.begin(async (tx) => {
      await tx`SET LOCAL ROLE app_user`;
      return tx`SELECT id FROM chats`;
    });
    expect(rows).toHaveLength(0);
  });
});
