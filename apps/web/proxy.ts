import { clerkMiddleware } from "@clerk/nextjs/server";

// Clerk only has a say on the pages that sign people in and the one route that turns a Clerk
// sign-in into our own session. Everything else uses our session cookie, as before.
export default clerkMiddleware();

export const config = {
  matcher: ["/sign-in(.*)", "/signed-in", "/api/auth/clerk"],
};
