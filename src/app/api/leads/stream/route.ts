import { getSession } from "@/core/auth";
import { getConfig } from "@/core/config";
import { createLogger } from "@/core/logging";
import { getNotifier, type ConversationNotification } from "@/core/notifier";

/**
 * FR-023: the queue updates over one agency-scoped SSE stream, no polling.
 * Copies the shape of `api/chat/[conversationId]/events/route.ts` — pulse,
 * goodbye, cleanup on abort/cancel — but carries far less: a `changed` frame
 * names only the `conversationId` that moved, and the client's answer is
 * always the same, `router.refresh()`, which re-reads through the scoped
 * services. There is nothing to replay here (unlike the widget's stream):
 * a missed frame costs one stale render until the next one arrives, and the
 * dashboard is never the only place a broker learns something happened.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const log = createLogger("app", { module: "api/leads/stream" });

/** Every stream open in this process, so `SIGTERM` can say goodbye to all of them. */
const openStreams = new Set<() => void>();
let signalsInstalled = false;

function installShutdownGoodbye(): void {
  if (signalsInstalled) return;
  signalsInstalled = true;

  const goodbye = (signal: string) => {
    log.info({ signal, streams: openStreams.size }, "closing leads SSE streams");
    for (const close of [...openStreams]) close();
  };

  process.prependListener("SIGTERM", () => goodbye("SIGTERM"));
  process.prependListener("SIGINT", () => goodbye("SIGINT"));
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export async function GET(request: Request): Promise<Response> {
  const session = await getSession();
  if (session === null) return json({ error: "sessão inválida" }, 401);

  const { agencyId } = session;
  const pulseMs = getConfig().SSE_PULSE_INTERVAL_MS;
  installShutdownGoodbye();

  const encoder = new TextEncoder();
  let closed = false;
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (frame: string): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(frame));
        } catch {
          // The client vanished between the abort and this write.
          closed = true;
        }
      };

      const send = (event: string, data: unknown): void => {
        write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      const pulse = setInterval(() => {
        write(": ping\n\n");
        send("pulse", {});
      }, pulseMs);

      const deliver = (notification: ConversationNotification): void => {
        // A notification reaches every replica regardless of tenant; this is
        // where the wrong agency's is dropped.
        if (notification.agencyId !== agencyId) return;
        // Chunks are the widget's typing animation — nothing a queue row reads.
        if (notification.kind === "chunk") return;

        send("changed", { conversationId: notification.conversationId });
      };

      const unsubscribe = getNotifier().subscribeAgency(agencyId, deliver);

      const goodbye = () => {
        send("goodbye", {});
        cleanup();
      };
      openStreams.add(goodbye);

      cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(pulse);
        unsubscribe();
        openStreams.delete(goodbye);
        try {
          controller.close();
        } catch {
          // Already closed by the runtime.
        }
      };

      request.signal.addEventListener("abort", () => cleanup());

      write(`retry: 3000\n: open\n\n`);
      send("pulse", {});

      log.info({ agencyId }, "leads SSE stream opened");
    },

    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
