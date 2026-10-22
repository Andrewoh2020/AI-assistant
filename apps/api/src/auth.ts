import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

/** scrypt$<salt hex>$<hash hex> */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(actual, expected);
}

export interface SessionPayload {
  uid: string; // our user id
  tid: string; // Travila end-user id
  tz: string;
  exp: number; // unix seconds
}

const b64 = (s: string) => Buffer.from(s).toString("base64url");

/** A signed, tamper-proof session cookie value. */
export function signSession(payload: SessionPayload, secret: string): string {
  const body = b64(JSON.stringify(payload));
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifySession(
  token: string | undefined,
  secret: string,
  nowSec = Date.now() / 1000,
): SessionPayload | null {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", secret).update(body).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as SessionPayload;
    return payload.exp > nowSec ? payload : null;
  } catch {
    return null;
  }
}

/**
 * Who Clerk says is signing in, checked by the website (which holds Clerk's keys) and handed to
 * the backend signed with the session secret, so nothing else can claim to be someone.
 */
export interface ClerkIdentity {
  clerkId: string;
  /** Only an email Clerk has verified. */
  email: string | null;
  name: string | null;
  exp: number; // unix seconds
}

export function signIdentity(identity: ClerkIdentity, secret: string): string {
  const body = b64(JSON.stringify(identity));
  const sig = createHmac("sha256", secret).update(`clerk:${body}`).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyIdentity(
  token: string | undefined,
  secret: string,
  nowSec = Date.now() / 1000,
): ClerkIdentity | null {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", secret).update(`clerk:${body}`).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const identity = JSON.parse(Buffer.from(body, "base64url").toString()) as ClerkIdentity;
    return identity.exp > nowSec && typeof identity.clerkId === "string" ? identity : null;
  } catch {
    return null;
  }
}

/** Encrypts a short secret (such as a live browser link) before it is stored. AES-256-GCM. */
export function sealSecret(plain: string, secret: string): string {
  const key = createHash("sha256").update(`seal:${secret}`).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64url")).join(".");
}

/** Returns null if the value can't be opened (for example, the secret changed since). */
export function openSecret(sealed: string, secret: string): string | null {
  try {
    const [iv, tag, data] = sealed.split(".").map((p) => Buffer.from(p, "base64url"));
    const key = createHash("sha256").update(`seal:${secret}`).digest();
    const decipher = createDecipheriv("aes-256-gcm", key, iv!);
    decipher.setAuthTag(tag!);
    return Buffer.concat([decipher.update(data!), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
