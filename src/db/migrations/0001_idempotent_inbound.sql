-- FR-035: a repeated `clientMessageId` must not create a second lead message.
-- Hand-written rather than generated: drizzle-kit cannot express a partial index
-- over a jsonb expression, and the shared data model gains no column and no
-- table by it (specs/004-conversation/data-model.md §5).
CREATE UNIQUE INDEX IF NOT EXISTS "messages_client_message_id_uniq"
  ON "messages" ("conversation_id", ("metadata" ->> 'clientMessageId'))
  WHERE "metadata" ? 'clientMessageId';
