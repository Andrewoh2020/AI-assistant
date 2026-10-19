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
  const sessionSecret = env.SESSION_SECRET ?? "";
  if (env.NODE_ENV === "production" && sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET must be at least 32 characters in production");
  }
  return {
    databaseUrl: env.DATABASE_URL ?? "",
    travilaBase: env.TRAVILA_API_BASE ?? "https://api.travila.ai",
    travilaKey: env.TRAVILA_API_KEY ?? "",
    deepseekBase: env.DEEPSEEK_API_BASE ?? "https://api.deepseek.com",
    deepseekKey: env.DEEPSEEK_API_KEY ?? "",
    sessionSecret: sessionSecret || "dev-only-session-secret-change-me-0000",
    signupCode: env.SIGNUP_CODE ?? "",
    secureCookies: env.NODE_ENV === "production",
  };
}
