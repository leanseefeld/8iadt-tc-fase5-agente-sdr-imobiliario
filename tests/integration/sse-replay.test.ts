import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chatSessionCookie, newChatSession, signChatSession } from "../../src/core/auth.ts";
import { getConfig } from "../../src/core/config.ts";
import { closePool, getPool } from "../../src/db/client.ts";
import { closeNotifier } from "../../src/core/notifier.ts";
import {
  loadChatHistory,
  readMessagesAfter,
  recordLeadMessage,
  recordOutboundMessage,
} from "../../src/services/conversation.ts";

/**
 * INTEGRATION=1 — needs a live Postgres and, for the last test, the dev server.
 * It needs **no model**: every message here is written directly, because what is
 * under test is the cursor, not the reply.
 *
 * FR-048's claim is that the database is the source of truth and the
 * notification only a wake-up. The test of that claim is a client that missed
 * everything: it reconnects with the id of the last event it saw and must
 * receive precisely what came after, from the rows, with the notification long
 * gone.
 */
const integration = process.env.INTEGRATION === "1";

const AGENCY = "demo";
const sessionId = `test-sse-${randomUUID()}`;

async function removeSession(): Promise<void> {
  const pool = getPool();
  await pool.query(
    `with dead as (select id from leads where external_id = $1),
          conv as (select id from conversations where lead_id in (select id from dead))
     delete from messages where conversation_id in (select id from conv)`,
    [sessionId],
  );
  await pool.query(
    `delete from events where lead_id in (select id from leads where external_id = $1)`,
    [sessionId],
  );
  await pool.query(
    `delete from conversations where lead_id in (select id from leads where external_id = $1)`,
    [sessionId],
  );
  await pool.query(`delete from leads where external_id = $1`, [sessionId]);
}

test("a reconnecting stream replays from Last-Event-ID out of the rows", {
  skip: !integration,
}, async (t) => {
  const accepted = await recordLeadMessage({
    agencySlug: AGENCY,
    externalId: sessionId,
    clientMessageId: randomUUID(),
    text: "Estou procurando apartamento na zona sul",
    consent: true,
  });
  assert.equal(accepted.status, "stored");
  if (accepted.status !== "stored") return;

  const conversationId = accepted.conversationId;
  const leadMessageId = accepted.messageId;
  assert.ok(leadMessageId !== null);

  // Two agent messages, written the way a turn and then a broker would.
  const first = await recordOutboundMessage({
    conversationId,
    content: "Qual faixa de preço você tem em mente?",
  });
  const second = await recordOutboundMessage({
    conversationId,
    content: "Posso te mostrar algumas opções na Zona Sul.",
  });
  assert.ok(first !== null && second !== null);

  await t.test("replay from the lead message returns both agent messages, in order", async () => {
    const missed = await readMessagesAfter(conversationId, leadMessageId as string);
    assert.deepEqual(
      missed.map((message) => message.id),
      [first?.messageId, second?.messageId],
    );
  });

  await t.test("replay from the last one seen returns nothing", async () => {
    const missed = await readMessagesAfter(conversationId, second?.messageId as string);
    assert.deepEqual(missed, []);
  });

  await t.test("an id the client invented replays nothing, not everything", async () => {
    const missed = await readMessagesAfter(conversationId, randomUUID());
    assert.deepEqual(missed, []);
  });

  await t.test("an id from another conversation is not a cursor into this one", async () => {
    const other = await recordLeadMessage({
      agencySlug: AGENCY,
      externalId: `${sessionId}-other`,
      clientMessageId: randomUUID(),
      text: "oi",
      consent: true,
    });
    assert.equal(other.status, "stored");
    if (other.status !== "stored" || other.messageId === null) return;

    const missed = await readMessagesAfter(conversationId, other.messageId);
    assert.deepEqual(missed, []);

    const pool = getPool();
    await pool.query(
      `delete from messages where conversation_id = $1`,
      [other.conversationId],
    );
    await pool.query(`delete from events where conversation_id = $1`, [other.conversationId]);
    await pool.query(`delete from conversations where id = $1`, [other.conversationId]);
    await pool.query(`delete from leads where external_id = $1`, [`${sessionId}-other`]);
  });

  await t.test("the whole transcript survives a reload (SC-005)", async () => {
    const history = await loadChatHistory({ agencySlug: AGENCY, externalId: sessionId });
    assert.equal(history?.conversationId, conversationId);
    assert.equal(history?.consented, true);
    assert.deepEqual(
      history?.messages.map((message) => message.role),
      ["lead", "agent", "agent"],
    );
  });

  // The HTTP half. It needs the dev server, so it says so and skips rather than
  // failing when the suite is run against a database alone.
  await t.test("the SSE route replays those rows to a reconnecting client", async () => {
    const base = `http://localhost:${getConfig().APP_PORT}`;
    const reachable = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2_000) })
      .then((response) => response.ok)
      .catch(() => false);
    if (!reachable) {
      t.diagnostic(`no app server on ${base}; skipping the HTTP half`);
      return;
    }

    const cookie = chatSessionCookie(
      await signChatSession(newChatSession({ agencySlug: AGENCY, sessionId })),
    );

    const response = await fetch(`${base}/api/chat/${conversationId}/events`, {
      headers: {
        cookie: cookie.split(";")[0],
        "last-event-id": leadMessageId as string,
        accept: "text/event-stream",
      },
      signal: AbortSignal.timeout(10_000),
    });

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);

    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let seen = "";
    try {
      // Read until both replayed messages have arrived, or the stream stalls.
      while (!seen.includes(second?.messageId as string)) {
        const { value, done } = await reader.read();
        if (done) break;
        seen += decoder.decode(value, { stream: true });
      }
    } finally {
      await reader.cancel().catch(() => {});
    }

    assert.ok(seen.includes(`id: ${first?.messageId}`), "the first missed message was replayed");
    assert.ok(seen.includes(`id: ${second?.messageId}`), "the second one too");
    assert.ok(seen.includes("event: message"), "replayed as message events");
    // `id: ` and not a bare id: the lead message is *named* by both replayed
    // bubbles' `repliesToMessageId`, which is FR-044 working, not a re-send.
    assert.ok(!seen.includes(`id: ${leadMessageId}`), "the cursor itself is not replayed");
  });

  await t.after(async () => {
    await removeSession();
    await closeNotifier();
    await closePool();
  });
});
