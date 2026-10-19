import type { NextRequest } from "next/server";
import { backend } from "@/lib/backend";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Hands /api/* requests to the backend and returns its answer unchanged. */
async function handle(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const app = await backend();
  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.text();
  const res = await app.inject({
    method: req.method as "GET" | "POST",
    url: "/" + path.map(encodeURIComponent).join("/") + req.nextUrl.search,
    headers,
    payload: body,
  });
  const out = new Headers();
  for (const [key, value] of Object.entries(res.headers)) {
    if (value === undefined || key === "content-length" || key === "connection") continue;
    for (const v of Array.isArray(value) ? value : [String(value)]) out.append(key, v);
  }
  return new Response(new Uint8Array(res.rawPayload), { status: res.statusCode, headers: out });
}

export { handle as GET, handle as POST };
