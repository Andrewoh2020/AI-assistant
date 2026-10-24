import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";

/**
 * An invite link. It remembers the invite for a week and opens the sign-in page, so the person
 * can create an account without typing a code. The backend checks the code when they sign in.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const res = NextResponse.redirect(new URL("/sign-in", req.url));
  res.cookies.set("aia_invite", code.slice(0, 100), {
    httpOnly: true,
    sameSite: "lax",
    secure: req.nextUrl.protocol === "https:",
    path: "/",
    maxAge: 7 * 86400,
  });
  return res;
}
