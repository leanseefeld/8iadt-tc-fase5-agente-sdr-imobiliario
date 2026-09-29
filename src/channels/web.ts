import { z } from "zod";
import { runTurn, type ReplySink } from "../agent/orchestrator.ts";
import { getConfig } from "../core/config.ts";
import { createLogger } from "../core/logging.ts";
import { CHUNK_CHANNEL, publishQuietly } from "../core/notifier.ts";
import { recordOutboundMessage } from "../services/conversation.ts";
import {
  InboundMessageError,
  type ChannelAdapter,
  type InboundMessage,
  type OutboundMessage,
} from "./types.ts";

/**
 * The web widget as a `ChannelAdapter` — the only implementation this slice
 * ships, which the constitution permits by name.
 *
 * It owns three things and no HTTP knowledge at all:
 *
 * 1. `receive` — the JSON body of `POST /api/chat` normalised into an
 *    `InboundMessage`, or a throw naming the field that was wrong.
 * 2. `scheduleTurn` — the debounce. FR-043 says a turn begins only after
 *    `CHAT_DEBOUNCE_MS` of silence, so the timer is restarted by every new lead
 *    message and a burst of three collapses into one reply that answers all
 *    three (FR-044).
 * 3. `send` — one outbound message persisted and announced, for a caller that
 *    is not a turn (spec 006's follow-up).
 *
 * **On the timer being process-local.** It is, and the constitution's "no
 * process-local state" is about the *orchestrator*, which still loads
 * everything it needs from rows and writes everything back. This timer is
 * scheduling, not state: if the process dies holding one, the lead message is
 * already committed and `jobs/unanswered-turns.ts` re-runs exactly the turn
 * this timer would have. The durable path is the backstop; this is only the
 * fast one.
 */

const log = createLogger("app", { module: "channels/web" });

/**
 * `contracts/chat-api.md` §2. `text` is optional because the "Aceito" tap is a
 * message with consent and no words — the one inbound that records something
 * without saying anything.
 */
const inboundSchema = z.object({
  agencySlug: z.string().min(1).max(120),
  sessionId: z.string().min(1).max(120),
  clientMessageId: z.string().min(1).max(120),
  text: z.string().default(""),
  consent: z.boolean().optional(),
});

/** Chunks published to the stream, so a widget held by another replica hears them. */
export function notifyingSink(conversationId: string, agencyId: string): ReplySink {
  return {
    chunk(text: string) {
      publishQuietly(CHUNK_CHANNEL, { conversationId, agencyId, text });
    },
    done() {
      // Nothing: `commitTurn` ends its transaction with the `message`
      // notification, so the final bubble is announced by the write that made
      // it durable rather than by the process that happened to phrase it.
    },
  };
}

/** Conversations with a turn waiting on the debounce, in this process. */
const debounced = new Map<string, ReturnType<typeof setTimeout>>();

async function runDebouncedTurn(conversationId: string, agencyId: string): Promise<void> {
  try {
    const result = await runTurn({
      conversationId,
      sink: notifyingSink(conversationId, agencyId),
    });
    log.info({ conversationId, status: result.status }, "debounced turn finished");
  } catch (error) {
    // Nothing was committed, so the lead messages are still unanswered and the
    // worker's sweep will answer them. A thrown turn must not take the process.
    log.error({ conversationId, err: (error as Error).message }, "debounced turn failed");
  }
}

/**
 * Starts — or restarts — the wait before this conversation's next turn.
 * Restarting is what coalesces a burst: the turn runs `CHAT_DEBOUNCE_MS` after
 * the *last* lead message, not the first.
 */
export function scheduleTurn(conversationId: string, agencyId: string): void {
  clearTimeout(debounced.get(conversationId));

  const timer = setTimeout(() => {
    debounced.delete(conversationId);
    void runDebouncedTurn(conversationId, agencyId);
  }, getConfig().CHAT_DEBOUNCE_MS);

  // A pending reply must never be the reason a process refuses to shut down;
  // the sweep picks it up on the other side of the restart.
  timer.unref?.();
  debounced.set(conversationId, timer);
}

/** Test and shutdown seam — cancels every wait without running the turns. */
export function cancelScheduledTurns(): void {
  for (const timer of debounced.values()) clearTimeout(timer);
  debounced.clear();
}

export const webChannel: ChannelAdapter = {
  receive(raw: unknown): InboundMessage {
    const parsed = inboundSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new InboundMessageError(issue.path.join(".") || "body");
    }

    return {
      channel: "web",
      agencySlug: parsed.data.agencySlug,
      // The widget's anonymous session id *is* the lead's identity on this
      // channel (FR-020) — the same field a Telegram adapter would fill with a
      // chat id.
      externalId: parsed.data.sessionId,
      clientMessageId: parsed.data.clientMessageId,
      text: parsed.data.text,
      consent: parsed.data.consent,
      receivedAt: new Date(),
    };
  },

  async send(message: OutboundMessage): Promise<void> {
    const written = await recordOutboundMessage({
      conversationId: message.conversationId,
      content: message.text,
      propertyIds: message.propertyIds,
      paused: message.paused,
      isFollowUp: message.isFollowUp,
    });

    if (written === null) {
      log.warn({ conversationId: message.conversationId }, "send to an unknown conversation");
    }
    // No return value on purpose: the widget is reached by the SSE stream the
    // write just rang, not by whoever called this.
  },
};
