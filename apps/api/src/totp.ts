import { createHmac } from "node:crypto";

/**
 * 2-step codes from an authenticator key (TOTP, RFC 6238), the same codes Google Authenticator or
 * Authy show. The key is what the site gave when 2-step sign-in was turned on: a base32 "setup
 * key", or the otpauth:// link inside its QR code.
 */

export interface TotpKey {
  /** base32, upper case, no spaces or padding. */
  secret: string;
  digits: number;
  period: number;
  algorithm: "SHA1" | "SHA256" | "SHA512";
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(s: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of s) {
    const i = BASE32.indexOf(c);
    if (i < 0) throw new Error("not base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Reads a setup key or otpauth:// link; null if it isn't one. */
export function parseTotpKey(raw: string): TotpKey | null {
  const text = raw.trim();
  let secret = text;
  let digits = 6;
  let period = 30;
  let algorithm: TotpKey["algorithm"] = "SHA1";
  if (/^otpauth:/i.test(text)) {
    try {
      const u = new URL(text);
      if (u.host.toLowerCase() !== "totp") return null;
      secret = u.searchParams.get("secret") ?? "";
      digits = Number(u.searchParams.get("digits") ?? 6);
      period = Number(u.searchParams.get("period") ?? 30);
      const alg = (u.searchParams.get("algorithm") ?? "SHA1").toUpperCase();
      if (alg !== "SHA1" && alg !== "SHA256" && alg !== "SHA512") return null;
      algorithm = alg;
    } catch {
      return null;
    }
  }
  secret = secret.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  if (!/^[A-Z2-7]{16,128}$/.test(secret)) return null;
  if (![6, 7, 8].includes(digits) || !Number.isInteger(period) || period < 10 || period > 120) {
    return null;
  }
  return { secret, digits, period, algorithm };
}

export function totp(key: TotpKey, at: Date = new Date()): string {
  const counter = Math.floor(at.getTime() / 1000 / key.period);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac(key.algorithm.toLowerCase(), base32Decode(key.secret))
    .update(msg)
    .digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const n = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** key.digits;
  return String(n).padStart(key.digits, "0");
}

/** Seconds until the code changes; a code about to change is not worth typing. */
export function secondsLeft(key: TotpKey, at: Date = new Date()): number {
  return key.period - (Math.floor(at.getTime() / 1000) % key.period);
}
