# Data Model: Walking Skeleton

**This slice defines no persistent data.**

The database container runs and both processes connect to it, but no table,
migration or seed belongs to this feature. Readiness means the connection succeeds
— nothing queries a schema, because there is none.

`src/db/client.ts` ships a Drizzle instance over a `pg` pool so that
`services/health.ts` can run `SELECT 1` through the real data path. That is the
whole of the data layer here, and it exists to prove the `app → services → db`
chain rather than to store anything.

The schema — `leads`, `conversations`, `messages`, `properties`, `appointments`,
`events`, `followup_jobs` — is backlog item 2, along with migrations and the seeded
catalog.
