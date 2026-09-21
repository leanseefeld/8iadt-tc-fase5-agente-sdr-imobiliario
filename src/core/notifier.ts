import { Client, type Notification } from "pg";
import { getPool } from "../db/client.ts";
import { getConfig } from "./config.ts";
import { createLogger } from "./logging.ts";

/**
 * The pub/sub seam of `visao-geral.md` §8, behind the `Notifier` interface
 * FR-047 names.
 *
 * **One `LISTEN` connection per replica, not per client.** That is the whole
 * scaling argument: a thousand open SSE streams cost a thousand HTTP
 * connections and exactly one database connection. Streams register here by
 * conversation id and are woken by a notification carrying nothing but ids;
 * the route handler then re-reads the row through `services/conversation.ts`,
 * scoped by agency and conversation, before writing anything to a client. The
 * database is the truth, the notification is a doorbell.
 *
 * Two channels, and the difference between them is durability:
 *
 * - `conversation_message` — rung inside `commitTurn`'s transaction, ids only.
 *   The row exists, so a listener that missed the notification recovers it by
 *   replaying from `Last-Event-ID`.
 * - `conversation_chunk` — the sentences of a reply as the guards clear them
 *   (FR-017). There is no row yet, so this payload *does* carry text. It is
 *   deliberately lossy: a dropped chunk costs a little typing animation, and
 *   the final `message` event delivers the same sentences as one persisted
 *   whole. Nothing is ever recovered from a chunk.
 *
 * This module is the one place outside `db/` and `services/` that opens a
 * Postgres connection, and it does so on purpose. `LISTEN` needs a connection
 * held open for the life of the process, which is exactly what a pool must not
 * give away, and this connection never reads a row: it carries ids in and ids
 * out. Constitution IV's rule — services own the queries, UI never reaches past
 * them — is untouched, because there are no queries here.
 *
 * Swapping Postgres for Redis or a managed bus is a second implementation of
 * `Notifier` and no other change, which is the trade `visao-geral.md` §8 writes
 * down as the exit from `NOTIFY`'s fan-out to every tenant's replicas.
 */

const log = createLogger("app", { module: "core/notifier" });

/** Written by `commitTurn` inside its transaction. Ids only. */
export const MESSAGE_CHANNEL = "conversation_message";

/** Written by the turn's `ReplySink`, sentence by sentence. Ephemeral. */
export const CHUNK_CHANNEL = "conversation_chunk";

/**
 * A conversation changed hands or changed state without producing a message
 * (spec 005): a broker assumed it, handed it back, or a summary landed. Ids and
 * a status only — both the widget's stream and the dashboard's re-read the rows.
 *
 * It exists because the other two channels are message-shaped, and a takeover
 * sends no message. Without it the widget would only learn it is being answered
 * by a person once that person typed something (FR-034, SC-008).
 */
export const STATE_CHANNEL = "conversation_state";

export interface MessageNotification {
  kind: "message";
  conversationId: string;
  agencyId: string;
  messageId: string;
}

export interface ChunkNotification {
  kind: "chunk";
  conversationId: string;
  agencyId: string;
  text: string;
}

export interface StateNotification {
  kind: "state";
  conversationId: string;
  agencyId: string;
  status: "active" | "paused" | "closed";
}

export type ConversationNotification = MessageNotification | ChunkNotification | StateNotification;

export type NotificationListener = (notification: ConversationNotification) => void;

export interface Notifier {
  /** Fire-and-forget by contract: a failed publish must never fail a turn. */
  publish(channel: string, payload: Record<string, unknown>): Promise<void>;
  /** Returns the unsubscribe function. Call it on client disconnect. */
  subscribe(conversationId: string, listener: NotificationListener): () => void;
  /**
   * Every notification of one agency, for the broker dashboard: it watches a
   * list, not a conversation, and cannot know in advance which conversation is
   * about to move. Same contract — ids in, ids out, the row is re-read scoped
   * before anything reaches a browser.
   */
  subscribeAgency(agencyId: string, listener: NotificationListener): () => void;
}

/**
 * Postgres caps a `NOTIFY` payload at 8000 bytes and raises on anything larger,
 * which would abort the transaction it was sent from. Sentences are two orders
 * of magnitude under this; the check exists so that a pathological one is
 * dropped rather than allowed to take a turn down.
 */
const MAX_PAYLOAD_BYTES = 7_000;

const RECONNECT_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;

function parse(channel: string, raw: string | undefined): ConversationNotification | null {
  if (raw === undefined || raw === "") return null;
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;

  const record = payload as Record<string, unknown>;
  const conversationId = record.conversationId;
  const agencyId = record.agencyId;
  if (typeof conversationId !== "string" || typeof agencyId !== "string") return null;

  if (channel === MESSAGE_CHANNEL) {
    return typeof record.messageId === "string"
      ? { kind: "message", conversationId, agencyId, messageId: record.messageId }
      : null;
  }
  if (channel === CHUNK_CHANNEL) {
    return typeof record.text === "string"
      ? { kind: "chunk", conversationId, agencyId, text: record.text }
      : null;
  }
  if (channel === STATE_CHANNEL) {
    const status = record.status;
    return status === "active" || status === "paused" || status === "closed"
      ? { kind: "state", conversationId, agencyId, status }
      : null;
  }
  return null;
}

class PostgresNotifier implements Notifier {
  private readonly listeners = new Map<string, Set<NotificationListener>>();
  private readonly agencyListeners = new Map<string, Set<NotificationListener>>();
  private client: Client | undefined;
  private connecting: Promise<Client> | undefined;
  private reconnectDelay = RECONNECT_DELAY_MS;
  private closed = false;

  subscribe(conversationId: string, listener: NotificationListener): () => void {
    return this.register(this.listeners, conversationId, listener);
  }

  subscribeAgency(agencyId: string, listener: NotificationListener): () => void {
    return this.register(this.agencyListeners, agencyId, listener);
  }

  private register(
    into: Map<string, Set<NotificationListener>>,
    key: string,
    listener: NotificationListener,
  ): () => void {
    let set = into.get(key);
    if (set === undefined) {
      set = new Set();
      into.set(key, set);
    }
    set.add(listener);

    // Opened on the first subscriber and kept for the life of the process: one
    // connection is cheap, and reconnecting per stream is not.
    void this.connection().catch((error: unknown) => {
      log.warn({ err: (error as Error).message }, "listen connection unavailable");
    });

    return () => {
      const current = into.get(key);
      if (current === undefined) return;
      current.delete(listener);
      if (current.size === 0) into.delete(key);
    };
  }

  async publish(channel: string, payload: Record<string, unknown>): Promise<void> {
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body, "utf8") > MAX_PAYLOAD_BYTES) {
      log.warn({ channel, bytes: body.length }, "notification payload too large, dropped");
      return;
    }
    // Through the pool, deliberately, not through the `LISTEN` connection.
    //
    // Publishing needs a connection for the length of one statement; listening
    // needs one for the life of the process. Tying them together meant any
    // process that merely published — the worker's sweep, a Server Action —
    // opened a long-lived socket it would never use, and Node then refused to
    // exit while that socket was open. An integration run sat for twenty-six
    // minutes after its last assertion for exactly this reason.
    await getPool().query("select pg_notify($1, $2)", [channel, body]);
  }

  /** The one connection, built lazily and rebuilt after a drop. */
  private connection(): Promise<Client> {
    if (this.client !== undefined) return Promise.resolve(this.client);
    this.connecting ??= this.connect();
    return this.connecting;
  }

  private async connect(): Promise<Client> {
    const client = new Client({ connectionString: getConfig().DATABASE_URL });

    client.on("notification", (message: Notification) => {
      const parsed = parse(message.channel, message.payload);
      if (parsed === null) return;
      const listeners = [
        ...(this.listeners.get(parsed.conversationId) ?? []),
        ...(this.agencyListeners.get(parsed.agencyId) ?? []),
      ];
      for (const listener of listeners) {
        // One bad listener must not cost the other streams their notification.
        try {
          listener(parsed);
        } catch (error) {
          log.warn({ err: (error as Error).message }, "stream listener threw");
        }
      }
    });

    // A dropped connection is normal — a database restart, a redeploy, an idle
    // timeout in front of it. It is not an error to report to anybody: the
    // streams stay open, the client is rebuilt, and whatever was missed is
    // replayed from the rows on the next `Last-Event-ID`.
    client.on("error", (error: Error) => {
      log.warn({ err: error.message }, "listen connection lost, reconnecting");
      this.drop();
    });

    try {
      await client.connect();
      await client.query(`listen ${MESSAGE_CHANNEL}`);
      await client.query(`listen ${CHUNK_CHANNEL}`);
      await client.query(`listen ${STATE_CHANNEL}`);
    } catch (error) {
      this.connecting = undefined;
      await client.end().catch(() => {});
      this.scheduleReconnect();
      throw error;
    }

    this.client = client;
    this.connecting = undefined;
    this.reconnectDelay = RECONNECT_DELAY_MS;
    log.info(
      { channels: [MESSAGE_CHANNEL, CHUNK_CHANNEL, STATE_CHANNEL] },
      "listening for conversation events",
    );
    return client;
  }

  private drop(): void {
    const dying = this.client;
    this.client = undefined;
    this.connecting = undefined;
    if (dying !== undefined) void dying.end().catch(() => {});
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed || (this.listeners.size === 0 && this.agencyListeners.size === 0)) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(delay * 2, RECONNECT_MAX_DELAY_MS);
    const timer = setTimeout(() => {
      void this.connection().catch(() => {});
    }, delay);
    // The reconnect must not be the reason the process refuses to exit.
    timer.unref?.();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.listeners.clear();
    this.agencyListeners.clear();
    const dying = this.client;
    this.client = undefined;
    this.connecting = undefined;
    if (dying !== undefined) await dying.end().catch(() => {});
  }
}

let notifier: PostgresNotifier | undefined;

/** One per process, built on first use — never at import (Next builds this file). */
export function getNotifier(): Notifier {
  notifier ??= new PostgresNotifier();
  return notifier;
}

export async function closeNotifier(): Promise<void> {
  const closing = notifier;
  notifier = undefined;
  if (closing !== undefined) await closing.close();
}

/**
 * The publish side used by a turn: never awaited, never able to throw into the
 * caller. A reply that reached the guards must not be lost because a doorbell
 * did not ring.
 */
export function publishQuietly(channel: string, payload: Record<string, unknown>): void {
  void getNotifier()
    .publish(channel, payload)
    .catch((error: unknown) => {
      log.warn({ channel, err: (error as Error).message }, "publish failed");
    });
}
