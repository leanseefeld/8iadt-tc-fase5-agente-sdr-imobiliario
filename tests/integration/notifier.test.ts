import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  CHUNK_CHANNEL,
  MESSAGE_CHANNEL,
  closeNotifier,
  getNotifier,
  type ConversationNotification,
} from "../../src/core/notifier.ts";

/**
 * INTEGRATION=1 — needs a live Postgres, and nothing else: no model, no schema
 * beyond a connection, because `LISTEN/NOTIFY` touches no table.
 *
 * The claim under test is the one that makes `visao-geral.md` §8's arithmetic
 * work: **one** connection serving **many** streams. Two subscribers on the same
 * conversation and one publish must wake both — that is the fan-out a second
 * replica would otherwise need a second connection for. The negative half
 * matters just as much: a subscriber on another conversation must stay asleep,
 * or every widget in every agency would be woken by every turn.
 */
const integration = process.env.INTEGRATION === "1";

/** Notifications cross the database and come back; nothing here is synchronous. */
function collector(expected: number): {
  seen: ConversationNotification[];
  listener: (notification: ConversationNotification) => void;
  wait: (ms?: number) => Promise<void>;
} {
  const seen: ConversationNotification[] = [];
  let resolve: (() => void) | undefined;
  return {
    seen,
    listener: (notification) => {
      seen.push(notification);
      if (seen.length >= expected) resolve?.();
    },
    wait: (ms = 5_000) =>
      new Promise<void>((done, fail) => {
        if (seen.length >= expected) return done();
        resolve = done;
        const timer = setTimeout(
          () => fail(new Error(`waited ${ms}ms for ${expected}, saw ${seen.length}`)),
          ms,
        );
        const original = resolve;
        resolve = () => {
          clearTimeout(timer);
          original();
        };
      }),
  };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 300));

test("the notifier fans one publish out to every stream on that conversation", {
  skip: !integration,
}, async (t) => {
  const notifier = getNotifier();
  const conversationId = randomUUID();
  const otherConversationId = randomUUID();
  const agencyId = randomUUID();
  const messageId = randomUUID();

  const first = collector(1);
  const second = collector(1);
  const bystander = collector(1);

  const unsubscribes = [
    notifier.subscribe(conversationId, first.listener),
    notifier.subscribe(conversationId, second.listener),
    notifier.subscribe(otherConversationId, bystander.listener),
  ];

  // The LISTEN is issued on the first subscribe and is asynchronous; publishing
  // before it lands would test nothing but a race.
  await settle();
  await notifier.publish(MESSAGE_CHANNEL, { conversationId, agencyId, messageId });

  await Promise.all([first.wait(), second.wait()]);

  await t.test("both subscribers saw the same message notification", () => {
    for (const seen of [first.seen, second.seen]) {
      assert.equal(seen.length, 1);
      assert.deepEqual(seen[0], { kind: "message", conversationId, agencyId, messageId });
    }
  });

  await t.test("a stream on another conversation is not woken", () => {
    assert.equal(bystander.seen.length, 0);
  });

  await t.test("a chunk notification carries its text, since no row exists yet", async () => {
    const chunks = collector(1);
    unsubscribes.push(notifier.subscribe(conversationId, chunks.listener));
    await notifier.publish(CHUNK_CHANNEL, {
      conversationId,
      agencyId,
      text: "Que bacana que você está focada na Zona Sul!",
    });
    await chunks.wait();
    assert.deepEqual(chunks.seen[0], {
      kind: "chunk",
      conversationId,
      agencyId,
      text: "Que bacana que você está focada na Zona Sul!",
    });
  });

  await t.test("unsubscribing stops delivery", async () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
    const late = collector(1);
    const stillListening = notifier.subscribe(conversationId, late.listener);
    await settle();

    const beforeCount = first.seen.length;
    await notifier.publish(MESSAGE_CHANNEL, {
      conversationId,
      agencyId,
      messageId: randomUUID(),
    });
    await late.wait();

    assert.equal(first.seen.length, beforeCount, "the unsubscribed listener stayed quiet");
    stillListening();
  });

  await t.after(async () => {
    await closeNotifier();
  });
});
