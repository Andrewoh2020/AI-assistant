import { auth, clerkClient } from "@clerk/nextjs/server";
import { loadConfig, signIdentity } from "@ai-assistant/api";
import type { NextRequest } from "next/server";
import { backend } from "@/lib/backend";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Checks who Clerk signed in, then asks the backend to start our own session for them. The
 * backend only trusts this because the identity is signed with the session secret.
 */
export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "Please sign in." }, { status: 401 });
  const user = await (await clerkClient()).users.getUser(userId);
  const primary = user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId);
  const email = primary?.verification?.status === "verified" ? primary.emailAddress : null;
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ") || null;
  const identity = signIdentity(
    { clerkId: userId, email, name, exp: Math.floor(Date.now() / 1000) + 60 },
    loadConfig().sessionSecret,
  );
  const app = await backend();
  const res = await app.inject({
    method: "POST",
    url: "/auth/clerk",
    headers: {
      "content-type": "application/json",
      cookie: req.headers.get("cookie") ?? "",
      "x-clerk-identity": identity,
    },
    payload: await req.text(),
  });
  const out = new Headers();
  for (const [key, value] of Object.entries(res.headers)) {
    if (value === undefined || key === "content-length" || key === "connection") continue;
    for (const v of Array.isArray(value) ? value : [String(value)]) out.append(key, v);
  }
  return new Response(new Uint8Array(res.rawPayload), { status: res.statusCode, headers: out });
}
