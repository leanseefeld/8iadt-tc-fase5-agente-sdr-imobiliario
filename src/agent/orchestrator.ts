import { createLogger } from "../core/logging.ts";
import { withTurnTrace } from "../core/langfuse.ts";
import { nextQuestion } from "../domain/slots.ts";
import { claimTurn, loadTurn, releaseTurn } from "../services/conversation.ts";
import { PRE_CONSENT_REPLY } from "./prompts/fallback.ts";
import { unansweredText } from "./turn/messages.ts";
import { run } from "./turn/run.ts";
import { collectingSink } from "./turn/sink.ts";
import type { RunTurnOptions, TurnResult } from "./turn/types.ts";

export { collectingSink, type ReplySink } from "./turn/sink.ts";
export type { RunTurnOptions, SkipReason, TurnOutcomeName, TurnResult } from "./turn/types.ts";

/**
 * The turn's entry point: who may run one, and inside which trace.
 *
 * One turn is stateless (FR-007): everything it needs is loaded at the start
 * and written back at the end, in `services/conversation.commitTurn`'s one
 * transaction. Nothing survives between turns except rows. What happens inside
 * a turn is the pipeline in `turn/run.ts`.
 */

const log = createLogger("app", { module: "agent/orchestrator" });

export async function runTurn(options: RunTurnOptions): Promise<TurnResult> {
  const sink = options.sink ?? collectingSink();
  const now = options.now ?? new Date();
  const startedAt = Date.now();

  const loaded = await loadTurn({ conversationId: options.conversationId });
  if (loaded === null) return { status: "skipped", reason: "noConversation" };

  // FR-028: a broker owns a paused conversation and the agent stays quiet.
  if (loaded.conversation.status !== "active") {
    return { status: "skipped", reason: "notActive" };
  }
  if (loaded.unanswered.length === 0) {
    return { status: "skipped", reason: "nothingUnanswered" };
  }

  // FR-018/019, and the one gate that must sit ahead of the model call: text
  // typed before "Aceito" gets the fixed template, costs nothing and is not a
  // turn. `recordLeadMessage` refuses it earlier too — this is the second lock,
  // because the worker's consumer can reach a turn without passing through it.
  if (loaded.lead.consentAt === null) {
    sink.chunk(PRE_CONSENT_REPLY);
    sink.done();
    return { status: "skipped", reason: "preConsent", reply: PRE_CONSENT_REPLY };
  }

  // FR-043: at most one turn per conversation, decided by the row.
  if (!(await claimTurn(loaded.conversation.id, now))) {
    return { status: "skipped", reason: "alreadyRunning" };
  }

  // The whole turn, inside its `conversation.turn` trace (contract §1). With
  // Langfuse unconfigured `withTurnTrace` is `fn(no trace)` and the turn is
  // identical, down to the `null` trace id every event row then carries
  // (FR-050). The skipped turns above are deliberately outside it: they answer
  // nothing and are not turns.
  try {
    return await withTurnTrace(
      {
        agencyId: loaded.agency.id,
        leadId: loaded.lead.id,
        conversationId: loaded.conversation.id,
        channel: loaded.lead.channel,
        intent: loaded.lead.intent,
        leadName: loaded.conversation.slots.name,
        leadText: unansweredText(loaded),
        // Recomputed here rather than read out of `run`: `nextQuestion` is pure,
        // and the trace wants the slot the script was on *before* the turn.
        pendingSlot:
          nextQuestion(
            { intent: loaded.lead.intent, slots: loaded.conversation.slots },
            true,
          )?.slot ?? null,
      },
      async (trace) => {
        const result = await run(loaded, {
          ...options,
          sink,
          now,
          startedAt,
          traceId: options.traceId ?? trace.traceId,
        });
        if (result.status === "committed") {
          trace.finish({
            score: result.score,
            stage: result.stage,
            outcome: result.outcome,
            reply: result.reply,
          });
        }
        return result;
      },
    );
  } catch (error) {
    // Nothing was committed, so the same lead messages are still unanswered and
    // the next sweep answers them. Only the claim has to be given back.
    await releaseTurn(loaded.conversation.id);
    log.error({ err: (error as Error).message }, "turn failed before commit");
    throw error;
  }
}
