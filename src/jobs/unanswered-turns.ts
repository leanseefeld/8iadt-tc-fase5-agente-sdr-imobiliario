import { runTurn } from "../agent/orchestrator.ts";
import { findUnansweredConversations } from "../services/conversation.ts";
import type { SweepConsumer } from "./consumers.ts";

/**
 * The backstop for a replica that died mid-turn (FR-046).
 *
 * The normal path is the route handler: it stores the lead message and, after
 * `CHAT_DEBOUNCE_MS`, runs the turn. That timer lives in a process, and a process
 * can go away — the widget would then sit on a message nobody ever answers. This
 * consumer re-runs exactly that turn, from the rows, which is the only place the
 * truth was.
 *
 * It re-runs nothing that is alive: `findUnansweredConversations` skips a
 * conversation with a `processingSince` newer than `MODEL_TIMEOUT_MS × 2`, and
 * `claimTurn` refuses a second time inside the turn itself. Both checks are the
 * same row, so two replicas sweeping at once still produce one turn.
 */

/** A bad turn must not take the sweep down with it, nor the other conversations. */
const BATCH = 25;

export const unansweredTurns: SweepConsumer = {
  name: "unanswered-turns",

  async run({ now, log }) {
    const pending = await findUnansweredConversations(now, BATCH);
    if (pending.length === 0) return;

    log.info({ count: pending.length }, "re-running unanswered turns");

    for (const conversation of pending) {
      try {
        const result = await runTurn({ conversationId: conversation.id, now });
        log.info(
          { conversationId: conversation.id, status: result.status },
          "unanswered turn re-run",
        );
      } catch (error) {
        log.error(
          { conversationId: conversation.id, err: (error as Error).message },
          "unanswered turn failed",
        );
      }
    }
  },
};
