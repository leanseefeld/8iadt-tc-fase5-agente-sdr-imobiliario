import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit configuration for `npm run db:generate`.
 *
 * Runtime migration application does not use this file — `src/db/migrate.ts`
 * calls the `drizzle-orm` migrator directly against the committed output in
 * `src/db/migrations`. This file only drives the CLI.
 */
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
});
