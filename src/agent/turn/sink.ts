import { getConfig } from "../../core/config.ts";

/**
 * Where approved sentences go. The turn does not know whether it is feeding an
 * SSE stream, a test or nothing at all — spec 004's group C attaches the stream
 * to this interface without the orchestrator learning about HTTP.
 */
export interface ReplySink {
  chunk(text: string): void;
  done(): void;
}

/** The sink the tests use, and the one a turn with no listener gets. */
export function collectingSink(): ReplySink & { chunks: string[]; text(): string } {
  const chunks: string[] = [];
  return {
    chunks,
    text: () => chunks.join(" "),
    chunk: (text) => void chunks.push(text),
    done: () => {},
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * FR-017: the first thing a lead reads never lands faster than a person could
 * have typed it — including the replies no model wrote, or the opt-out would
 * arrive instantly and every other reply would not.
 */
export async function pauseBeforeFirstChunk(startedAt: number): Promise<void> {
  const { minMs, maxMs } = getConfig().CHAT_TYPING_DELAY_MS;
  const target = minMs + Math.random() * Math.max(0, maxMs - minMs);
  const remaining = target - (Date.now() - startedAt);
  if (remaining > 0) await sleep(remaining);
}
