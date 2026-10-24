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

const ALLOWED_TOOLS = new Set([
  "web_search",
  "fetch_page",
  "browse",
  "read_file",
  "memory_search",
  "list_trips",
  "save_flight",
  "save_hotel",
  "save_travel_details",
  "show_travel_details",
  "offer_gmail",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  // Reads only the person's own trips (row-level security); it takes nothing in.
  if (tool === "list_trips") return { decision: "allow" };
  // Adds to the person's own trips only; the shape is checked when it runs.
  if (tool === "save_flight" || tool === "save_hotel" || tool === "save_travel_details")
    return { decision: "allow" };
  // Show the person's own travel details, or offer to connect Gmail: cards in their own chat.
  if (tool === "show_travel_details" || tool === "offer_gmail") return { decision: "allow" };
  if (tool === "read_file") {
    // Row-level security keeps it to the user's own files; this only checks the shape.
    if (typeof args.file_id !== "string" || !UUID.test(args.file_id))
      return { decision: "deny", reason: "file_id must be a file id" };
    return { decision: "allow" };
  }
  if (tool === "browse") {
    const task = args.task;
    if (typeof task !== "string" || !task.trim())
      return { decision: "deny", reason: "task is required" };
    if (task.length > 4000) return { decision: "deny", reason: "task is too long" };
    // Email is read through the Gmail connection; the browser never signs in to someone's Google.
    if (/gmail|mail\.google\.com/i.test(`${args.title ?? ""} ${task} ${args.url ?? ""}`))
      return {
        decision: "deny",
        reason: "Gmail is read through the Gmail connection, not the browser: call list_trips",
      };
    if (args.title !== undefined && (typeof args.title !== "string" || args.title.length > 80))
      return { decision: "deny", reason: "title must be a short name" };
    const ids = args.file_ids ?? [];
    if (
      !Array.isArray(ids) ||
      ids.length > 10 ||
      !ids.every((id) => typeof id === "string" && UUID.test(id))
    ) {
      return { decision: "deny", reason: "file_ids must be a list of up to 10 file ids" };
    }
    if (args.url === undefined || args.url === null || args.url === "")
      return { decision: "allow" };
    // The browser runs in Browser Use's cloud, but private addresses are refused all the same.
    const start = await checkUrl(args.url, resolve);
    return start.ok ? { decision: "allow" } : { decision: "deny", reason: start.reason };
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
