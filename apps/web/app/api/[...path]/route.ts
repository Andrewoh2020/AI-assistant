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
    // Only app/api/auth/clerk/route.ts may say who Clerk signed in.
    if (key === "x-clerk-identity") return;
    headers[key] = value;
  });
  // Raw bytes, so file uploads arrive unchanged.
  const body =
    req.method === "GET" || req.method === "HEAD"
      ? undefined
      : Buffer.from(await req.arrayBuffer());
  const res = await app.inject({
    method: req.method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
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

export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE };
