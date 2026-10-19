export interface Config {
  databaseUrl: string;
  travilaBase: string;
  /** Empty in the cloud environment, where the network proxy adds the key. */
  travilaKey: string;
  deepseekBase: string;
  deepseekKey: string;
  sessionSecret: string;
  /** People need this code to create an account. Empty disables sign-up. */
  signupCode: string;
  secureCookies: boolean;
}

export function loadConfig(env = process.env): Config {
  // On Vercel (the hosted site) we insist on a real secret and https-only cookies. On a computer
  // (localhost, plain http) neither is needed, so local testing works with no extra setup.
  const hosted = !!env.VERCEL;
  const sessionSecret = env.SESSION_SECRET ?? "";
  if (hosted && sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET must be at least 32 characters on the hosted site");
  }
  return {
    databaseUrl: env.DATABASE_URL ?? "",
    travilaBase: env.TRAVILA_API_BASE ?? "https://api.travila.ai",
    travilaKey: env.TRAVILA_API_KEY ?? "",
    deepseekBase: env.DEEPSEEK_API_BASE ?? "https://api.deepseek.com",
    deepseekKey: env.DEEPSEEK_API_KEY ?? "",
    sessionSecret: sessionSecret || "dev-only-session-secret-change-me-0000",
    signupCode: env.SIGNUP_CODE ?? "",
    secureCookies: hosted,
  };
}
