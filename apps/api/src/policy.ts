import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * The policy gate. Every tool call the model asks for passes through `decide` before it runs.
 * Unknown tools are denied. Phase 3 adds "ask" (approval cards) for action tools.
 */
export type Decision = { decision: "allow" } | { decision: "deny"; reason: string };

export type Resolver = (host: string) => Promise<string[]>;

const defaultResolver: Resolver = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((r) => r.address);

const ALLOWED_TOOLS = new Set(["web_search", "fetch_page", "memory_search"]);

export async function decide(
  tool: string,
  args: Record<string, unknown>,
  resolve: Resolver = defaultResolver,
): Promise<Decision> {
  if (!ALLOWED_TOOLS.has(tool)) return { decision: "deny", reason: `Unknown tool "${tool}"` };
  if (tool === "web_search" || tool === "memory_search") {
    const q = args.query;
    if (typeof q !== "string" || !q.trim())
      return { decision: "deny", reason: "query is required" };
    if (tool === "web_search" && looksPrivate(q)) {
      return {
        decision: "deny",
        reason: "The query contains private details (email, phone or card number)",
      };
    }
    return { decision: "allow" };
  }
  // fetch_page
  const check = await checkUrl(args.url, resolve);
  return check.ok ? { decision: "allow" } : { decision: "deny", reason: check.reason };
}

/** Discretion check: personal identifiers never go to the search engine. */
export function looksPrivate(query: string): boolean {
  return (
    /[\w.+-]+@[\w-]+\.[\w.]+/.test(query) || // email
    /\b(?:\d[ -]?){13,19}\b/.test(query) || // card-like number
    /\+?\d[\d ()-]{8,}\d/.test(query) // phone-like number
  );
}

/** True for loopback, private, link-local, carrier-grade NAT, multicast and reserved ranges. */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x.startsWith("::ffff:")) return isPrivateAddress(x.slice(7));
    return (
      x === "::" ||
      x === "::1" ||
      x.startsWith("fc") ||
      x.startsWith("fd") ||
      x.startsWith("fe8") ||
      x.startsWith("fe9") ||
      x.startsWith("fea") ||
      x.startsWith("feb") ||
      x.startsWith("ff")
    );
  }
  return true;
}

/**
 * SSRF block: only public http(s) URLs. The host is resolved first and every address it
 * resolves to must be public, so a name pointing at 169.254.169.254 or 10.x is refused.
 */
export async function checkUrl(
  raw: unknown,
  resolve: Resolver = defaultResolver,
): Promise<{ ok: true; url: URL } | { ok: false; reason: string }> {
  if (typeof raw !== "string") return { ok: false, reason: "url is required" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "Not a valid URL" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: "Only http and https pages can be read" };
  }
  if (url.username || url.password)
    return { ok: false, reason: "URLs with credentials are refused" };
  if (url.port && url.port !== "80" && url.port !== "443") {
    return { ok: false, reason: "Only standard web ports are allowed" };
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return { ok: false, reason: "Private network address refused" };
  }
  if (isIP(host)) {
    return isPrivateAddress(host)
      ? { ok: false, reason: "Private network address refused" }
      : { ok: true, url };
  }
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    return { ok: false, reason: "The site's address could not be found" };
  }
  if (!addresses.length || addresses.some(isPrivateAddress)) {
    return { ok: false, reason: "Private network address refused" };
  }
  return { ok: true, url };
}
