import type { NextConfig } from "next";

// The browser only ever talks to this site. Requests to /api/* are passed on to our backend
// (apps/api), so the session cookie stays first-party and no vendor key reaches the browser.
const apiUrl = process.env.API_URL ?? "http://localhost:4000";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiUrl}/:path*` }];
  },
};

export default config;
