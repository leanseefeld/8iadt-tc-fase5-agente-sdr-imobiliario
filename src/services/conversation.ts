/**
 * The turn's one door to the database — the conversation service's public
 * surface. Each part lives in `services/conversation/`:
 *
 *   types     what a turn reads and writes
 *   load      loading a turn (FR-007)
 *   state     the pending state a reply left on its metadata (ADR 22)
 *   claim     one turn per conversation at a time (FR-043)
 *   inbound   a lead's message arriving (FR-032, FR-035)
 *   commit    everything a turn produced, in one transaction (FR-033)
 *   outbound  a message sent outside a turn (spec 005)
 *   history   what the chat widget reads
 *
 * `agent/` computes and phrases; this reads what a turn needs and writes what
 * it produced, in a single transaction, so a failed turn leaves nothing behind.
 * Constitution IV: nothing above `services/` imports `db/`. Every query is
 * scoped by `agencyId` (ADR 10); `messages` is scoped transitively, through the
 * conversation resolved under an agency in the first place.
 */

export * from "./conversation/types.ts";
export * from "./conversation/load.ts";
export * from "./conversation/state.ts";
export * from "./conversation/claim.ts";
export * from "./conversation/inbound.ts";
export * from "./conversation/commit.ts";
export * from "./conversation/outbound.ts";
export * from "./conversation/history.ts";
