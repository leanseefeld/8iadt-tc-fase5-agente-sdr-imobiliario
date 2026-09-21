-- Two indexes, each because a query spec 005 writes needs it
-- (specs/005-broker-surface/data-model.md). No column, no table.
--
-- Hand-written rather than generated: both are for queries, not for the schema,
-- and the first is partial over a jsonb-free predicate drizzle-kit would not
-- infer from the model.

-- The summariser's select-then-claim: unprocessed turn events, oldest first,
-- grouped by conversation. Without this it is a sequential scan over the whole
-- append-only trail, which only grows.
CREATE INDEX IF NOT EXISTS "events_pending_turns_idx"
  ON "events" ("conversation_id", "created_at")
  WHERE "type" = 'conversation.turn' AND "processed_at" IS NULL;

-- The queue's scope and ordering: agency, then the "Meus leads" filter, then
-- score descending (SC-003).
CREATE INDEX IF NOT EXISTS "leads_queue_idx"
  ON "leads" ("agency_id", "assigned_broker_id", "score" DESC, "updated_at" DESC);
