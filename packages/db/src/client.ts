import postgres, { type Sql, type TransactionSql } from "postgres";

export type { Sql, TransactionSql };

export function connect(url = process.env.DATABASE_URL, { max = 10 }: { max?: number } = {}): Sql {
  if (!url) throw new Error("DATABASE_URL is not set");
  // Neon's pooled endpoint (PgBouncer, transaction mode) can't keep prepared statements.
  const pooled = /-pooler\./.test(url);
  return postgres(url, { max, prepare: !pooled, onnotice: () => {} });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runs `fn` inside a transaction as the given user. Row-level security then limits every
 * query to that user's rows, so a bug elsewhere cannot leak another user's data.
 */
export async function withUser<T>(
  sql: Sql,
  userId: string,
  fn: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  if (!UUID.test(userId)) throw new Error("withUser: userId must be a UUID");
  return sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE app_user`;
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

export interface SignedInUser {
  userId: string;
  travilaUserId: string;
}

/** Finds or creates the user for a sign-in subject (for example "passcode:andrew"). */
export async function signIn(
  sql: Sql,
  input: {
    authSubject: string;
    email?: string | null;
    displayName?: string | null;
    timezone?: string | null;
  },
): Promise<SignedInUser> {
  const [row] = await sql<{ user_id: string; travila_user_id: string }[]>`
    SELECT * FROM app_sign_in(${input.authSubject}, ${input.email ?? null},
                              ${input.displayName ?? null}, ${input.timezone ?? null})`;
  if (!row) throw new Error("sign-in failed");
  return { userId: row.user_id, travilaUserId: row.travila_user_id };
}
