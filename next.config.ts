import type { NextConfig } from "next";

/**
 * `next dev` refuses its own resources (the JS, hot reload) to any origin other
 * than localhost, so a phone on the same Wi-Fi loads the page and never runs
 * it. The Mac's `*.local` name is always allowed; a LAN IP comes from
 * `DEV_ALLOWED_ORIGINS`. Development only — a production build ignores it.
 */
const allowedDevOrigins = [
  "*.local",
  ...(process.env.DEV_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter((host) => host !== ""),
];

const nextConfig: NextConfig = {
  allowedDevOrigins,
  // pino, pg and drizzle are Node-only and must not be bundled into the
  // server build. Left to the bundler they are evaluated in Next's prerender
  // worker, which breaks the build.
  serverExternalPackages: ["pino", "pg", "drizzle-orm"],
};

export default nextConfig;
