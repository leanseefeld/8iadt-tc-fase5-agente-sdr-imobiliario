import { CHAT_SESSION_COOKIE, verifyChatSession } from "@/core/auth";
import { getConfig } from "@/core/config";
import { createLogger } from "@/core/logging";
import { getNotifier, type ConversationNotification } from "@/core/notifier";
import { loadChatHistory, readMessages, readMessagesAfter } from "@/services/conversation";
import { toWireMessage } from "../../wire";

/**
 * The one open connection a widget holds — `contracts/chat-api.md` §4 and
 * `visao-geral.md` §8.
 *
 * **What authorises it is the cookie, never the URL.** The `conversationId` in
 * the path is checked against the conversation the *signed session* resolves
 * to, and a mismatch is a 403; guessing another lead's conversation id
 * therefore buys nothing without the HMAC. That is the whole of FR-047's
 * "signed widget session" — a scoping guard, not an account.
 *
 * The database is the truth and the notification is a doorbell: a `message`
 * notification carries an id, and this handler re-reads the row scoped by
 * conversation before a single byte reaches the client. `chunk` is the one
 * exception and it is ephemeral by design — see `core/notifier.ts`.
 *
 * Event ids are message ids, so `Last-Event-ID` is a cursor into `messages` and
 * a reconnect replays from the rows rather than from anything held in memory.
 * Nothing on this path survives a restart, and nothing needs to.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const log = createLogger("app", { module: "api/chat/events" });

/** Every stream open in this process, so `SIGTERM` can say goodbye to all of them. */
const openStreams = new Set<() => void>();
let signalsInstalled = false;

function installShutdownGoodbye(): void {
  if (signalsInstalled) return;
  signalsInstalled = true;

  const goodbye = (signal: string) => {
    log.info({ signal, streams: openStreams.size }, "closing SSE streams");
    for (const close of [...openStreams]) close();
  };

  // `prependListener`, not `on`: the server's own handler may close its sockets
  // and exit, and a `goodbye` written after that is a `goodbye` nobody reads.
  // Ours goes first so the frame is at least queued before the shutdown starts.
  process.prependListener("SIGTERM", () => goodbye("SIGTERM"));
  process.prependListener("SIGINT", () => goodbye("SIGINT"));
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ conversationId: string }> },
): Promise<Response> {
  const { conversationId } = await context.params;

  const cookie = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${CHAT_SESSION_COOKIE}=`))
    ?.slice(CHAT_SESSION_COOKIE.length + 1);

  const session = await verifyChatSession(cookie);
  if (session === null) return json({ error: "sessão inválida" }, 401);

  // The session names an agency and a session id; the conversation is derived
  // from those two, never taken from the URL. `limit: 1` because only the
  // conversation's identity is wanted here — the transcript came from
  // `GET /api/chat` before this stream was ever opened.
  const resolved = await loadChatHistory({
    agencySlug: session.agencySlug,
    externalId: session.sessionId,
    limit: 1,
  });
  if (resolved === null) return json({ error: "conversa não encontrada" }, 404);
  if (resolved.conversationId !== conversationId) {
    log.warn({ conversationId, sessionId: session.sessionId }, "stream asked for another conversation");
    return json({ error: "conversa não pertence a esta sessão" }, 403);
  }

  const { agencyId } = resolved;
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
          // The client vanished between the abort and this write. Not an error:
          // stop, and let `cleanup` do the rest.
          closed = true;
        }
      };

      const send = (event: string, data: unknown, id?: string): void => {
        write(
          `${id === undefined ? "" : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
        );
      };

      const pulse = setInterval(() => {
        // The comment keeps a proxy's idle timer honest; the event is what the
        // widget counts, and two missed ones trip "Conexão perdida" (FR-048).
        write(": ping\n\n");
        send("pulse", {});
      }, pulseMs);

      const deliver = (notification: ConversationNotification): void => {
        // A notification reaches every replica regardless of tenant; this is
        // where the wrong agency's is dropped.
        if (notification.agencyId !== agencyId) return;

        if (notification.kind === "chunk") {
          send("chunk", { text: notification.text });
          return;
        }

        // A broker assumed the conversation or handed it back. No message was
        // written, so there is nothing to re-read and nothing to replay — the
        // status itself is the whole event, and the widget needs it to show
        // "Falando com um corretor" (spec 005 FR-034, SC-008).
        if (notification.kind === "state") {
          send("status", { status: notification.status });
          return;
        }

        // Ids only: the row is re-read, scoped by conversation, before anything
        // is written to the client (FR-047).
        void readMessages(conversationId, [notification.messageId])
          .then(([message]) => {
            if (message === undefined || message.role === "system") return;
            send("message", toWireMessage(message), message.id);
          })
          .catch((error: unknown) => {
            log.warn({ err: (error as Error).message }, "re-read for a stream failed");
          });
      };

      const unsubscribe = getNotifier().subscribe(conversationId, deliver);

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
          // Already closed by the runtime; nothing to do.
        }
      };

      // A closed tab, a navigation, a widget unmounting: the request aborts and
      // the listener has to go with it, or a long-lived process accumulates
      // subscribers for conversations nobody is watching.
      request.signal.addEventListener("abort", () => cleanup());

      // `retry` sets the browser's own reconnect delay; the comment flushes the
      // headers so the widget knows it is connected before the first pulse.
      write(`retry: 3000\n: open\n\n`);
      send("pulse", {});

      // FR-048: everything written after the last event this client saw. An id
      // it invented finds no cursor and replays nothing.
      const lastEventId = request.headers.get("last-event-id");
      if (lastEventId !== null && lastEventId !== "") {
        void readMessagesAfter(conversationId, lastEventId)
          .then((missed) => {
            for (const message of missed) {
              if (message.role === "system") continue;
              send("message", toWireMessage(message), message.id);
            }
            if (missed.length > 0) {
              log.info({ conversationId, replayed: missed.length }, "replayed from Last-Event-ID");
            }
          })
          .catch((error: unknown) => {
            log.warn({ err: (error as Error).message }, "replay failed");
          });
      }

      log.info({ conversationId, replay: lastEventId !== null }, "SSE stream opened");
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
      // Nginx and friends buffer a response body by default, which turns a
      // stream into one very late document.
      "x-accel-buffering": "no",
    },
  });
}
