import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pino, pg and drizzle are Node-only and must not be bundled into the
  // server build. Left to the bundler they are evaluated in Next's prerender
  // worker, which breaks the build.
  serverExternalPackages: ["pino", "pg", "drizzle-orm"],
};

export default nextConfig;
