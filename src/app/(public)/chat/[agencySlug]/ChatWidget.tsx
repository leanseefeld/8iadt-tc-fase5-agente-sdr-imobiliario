"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { WireBooking, WireProperty } from "@/app/api/chat/wire";
import MeetingCard from "./MeetingCard";
import PropertyCard from "./PropertyCard";
import styles from "./chat.module.css";

/**
 * Constitution X, before a single element was written.
 *
 * **Who is here.** One person, on a phone, who tapped an agency's link from an
 * ad or a message. They are not logged in, they have no account, and they will
 * decide in about ten seconds whether this is worth their evening — and, a
 * little later, whether it is worth their phone number.
 *
 * **What they came to do.** Say what they are looking for and be understood.
 * They did not come to fill a form, choose from a menu or read a policy.
 *
 * **The one interaction.** One thumb, one field, one bubble at a time. So: the
 * transcript is the whole screen, the composer is fixed under it, and the only
 * decision the page ever asks for outright is the consent — put first, in the
 * same voice as everything else, with a single button. Every state the lead
 * cannot see the cause of says so in words: sending, thinking, disconnected,
 * handed to a person, finished.
 *
 * Everything durable lives on the server. This component holds a session id in
 * `localStorage` (FR-020) and the transcript it has been told about — nothing
 * else. Reloading re-reads both from `GET /api/chat`, which is why SC-005 holds
 * without a single line here trying to make it hold.
 */

export interface ChatWidgetProps {
  agencySlug: string;
  agencyName: string;
  /** FR-018: rendered locally as the first bubble, never generated, never stored. */
  consentNotice: string;
  /** The script's first question, shown once "Aceito" is recorded (US2 scenario 4). */
  openingQuestion: string;
  /** Two missed pulses is the "Conexão perdida" threshold (FR-048). */
  pulseIntervalMs: number;
  /** The agency's IANA zone: a booked time reads the same here as in the reply above it. */
  timeZone: string;
}

type Role = "lead" | "agent" | "broker";

interface Bubble {
  key: string;
  /** Absent while the bubble is local or still streaming. */
  id?: string;
  role: Role;
  content: string;
  repliesToMessageId?: string;
  /** The catalog rows this reply put on the screen (FR-021). */
  propertyIds?: string[];
  /** The meeting this reply confirmed (spec 006 FR-006). */
  booking?: WireBooking;
  /** A lead bubble the server has not confirmed yet — "enviando" (FR-049). */
  pending?: boolean;
  /** Never persisted: the consent notice, the opening question, a template reply. */
  local?: boolean;
  /** Assembled from `chunk` events, replaced by the `message` event that follows. */
  streaming?: boolean;
}

interface WireMessage {
  id: string;
  role: Role;
  content: string;
  propertyIds?: string[];
  booking?: WireBooking;
  repliesToMessageId?: string;
  createdAt: string;
}

interface HistoryResponse {
  conversationId: string | null;
  status: "active" | "paused" | "closed";
  consented: boolean;
  messages: WireMessage[];
}

type Connection = "connecting" | "live" | "lost";

const SESSION_PREFIX = "sdr.chat.session.";

/** `localStorage` throws outright in some privacy modes; a chat must survive that. */
function readStoredSession(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStoredSession(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // In-memory for this visit only. Better than refusing to talk.
  }
}

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function toBubble(message: WireMessage): Bubble {
  return {
    key: message.id,
    id: message.id,
    role: message.role,
    content: message.content,
    repliesToMessageId: message.repliesToMessageId,
    propertyIds: message.propertyIds,
    booking: message.booking,
  };
}

/** FR-045: the WhatsApp-style quote is one line, so a long message is cut to one. */
function firstLine(text: string): string {
  const line = text.split("\n")[0].trim();
  return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}

export default function ChatWidget({
  agencySlug,
  agencyName,
  consentNotice,
  openingQuestion,
  pulseIntervalMs,
  timeZone,
}: ChatWidgetProps) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [status, setStatus] = useState<HistoryResponse["status"]>("active");
  const [consented, setConsented] = useState(false);
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [draft, setDraft] = useState("");
  const [typing, setTyping] = useState(false);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [notice, setNotice] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  /** The cards behind every `propertyIds` seen so far, by id (FR-021). */
  const [properties, setProperties] = useState<Record<string, WireProperty>>({});

  const endRef = useRef<HTMLDivElement | null>(null);
  const lastPulseRef = useRef<number>(Date.now());

  // 1 · the session id, and the transcript it names --------------------------

  useEffect(() => {
    const key = `${SESSION_PREFIX}${agencySlug}`;
    const existing = readStoredSession(key);
    const id = existing ?? newId();
    if (existing === null) writeStoredSession(key, id);
    setSessionId(id);
  }, [agencySlug]);

  useEffect(() => {
    if (sessionId === null) return;
    let cancelled = false;

    void (async () => {
      try {
        const response = await fetch(
          `/api/chat?agencySlug=${encodeURIComponent(agencySlug)}&sessionId=${encodeURIComponent(sessionId)}`,
        );
        if (!response.ok) throw new Error(String(response.status));
        const history = (await response.json()) as HistoryResponse;
        if (cancelled) return;

        setConversationId(history.conversationId);
        setStatus(history.status);
        setConsented(history.consented);
        setBubbles(history.messages.map(toBubble));
        // A transcript ending on the lead's own words means a turn is on its
        // way — the reload landed mid-answer, and the widget should look like it.
        setTyping(history.messages.at(-1)?.role === "lead");
      } catch {
        if (!cancelled) setNotice("Não consegui carregar a conversa. Tente recarregar a página.");
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [agencySlug, sessionId]);

  // 2 · the one open connection ---------------------------------------------

  const resync = useCallback(async (): Promise<void> => {
    if (sessionId === null) return;
    try {
      const response = await fetch(
        `/api/chat?agencySlug=${encodeURIComponent(agencySlug)}&sessionId=${encodeURIComponent(sessionId)}`,
      );
      if (!response.ok) return;
      const history = (await response.json()) as HistoryResponse;
      setStatus(history.status);
      setConsented(history.consented);
    } catch {
      // The stream is the important connection; a failed status check is not
      // worth a word to the lead.
    }
  }, [agencySlug, sessionId]);

  useEffect(() => {
    if (conversationId === null) return;

    const source = new EventSource(`/api/chat/${conversationId}/events`);
    const alive = () => {
      lastPulseRef.current = Date.now();
      setConnection("live");
    };

    source.addEventListener("pulse", alive);

    source.addEventListener("chunk", (event) => {
      alive();
      setTyping(false);
      const { text } = JSON.parse((event as MessageEvent<string>).data) as { text: string };
      setBubbles((current) => {
        const last = current.at(-1);
        // Sentences of one reply join into one bubble, so the lead reads a
        // message being written rather than a burst of fragments.
        if (last?.streaming === true) {
          return [...current.slice(0, -1), { ...last, content: `${last.content} ${text}`.trim() }];
        }
        return [...current, { key: newId(), role: "agent", content: text, streaming: true }];
      });
    });

    // Spec 005: a broker assuming the conversation writes no message, so the
    // status is pushed on its own. `resync` stays for the message path, which
    // also carries `consented` — this only moves the badge, and immediately.
    source.addEventListener("status", (event) => {
      alive();
      const payload = JSON.parse((event as MessageEvent<string>).data) as {
        status: HistoryResponse["status"];
      };
      setStatus(payload.status);
      if (payload.status === "paused") setTyping(false);
    });

    source.addEventListener("message", (event) => {
      alive();
      setTyping(false);
      const message = JSON.parse((event as MessageEvent<string>).data) as WireMessage;

      setBubbles((current) => {
        // A replay after a reconnect re-sends what was already shown.
        if (current.some((bubble) => bubble.id === message.id)) return current;
        return [
          // The streamed draft is thrown away in favour of the stored row: the
          // database is the truth, here as everywhere else.
          ...current.filter((bubble) => bubble.streaming !== true),
          toBubble(message),
        ].map((bubble) =>
          bubble.role === "lead" && bubble.pending === true ? { ...bubble, pending: false } : bubble,
        );
      });

      // The event contract carries no conversation status, and FR-022 needs one:
      // a handoff pauses the conversation mid-turn and the badge has to appear.
      // One request per completed turn, triggered by the stream — not a poll.
      if (message.role !== "lead") void resync();
    });

    source.addEventListener("goodbye", () => {
      // The server is going down on purpose. `EventSource` reconnects on its
      // own with the last id it saw; this only makes the wait visible.
      setConnection("lost");
    });

    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) setConnection("lost");
    };

    // Two missed pulses, plus a second of slack for a slow phone (FR-048).
    const watchdog = setInterval(() => {
      if (Date.now() - lastPulseRef.current > pulseIntervalMs * 2 + 1_000) setConnection("lost");
    }, Math.max(1_000, Math.floor(pulseIntervalMs / 2)));

    return () => {
      clearInterval(watchdog);
      source.close();
    };
    // The stream is torn down and rebuilt only when the conversation itself
    // changes — `resync` is memoised on the session, which does not.
  }, [conversationId, pulseIntervalMs, resync]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [bubbles, typing]);

  // The wire carries ids, never the catalog rows themselves (`contracts/chat-api.md`
  // §3 and §4), so a bubble with cards resolves them once — on mount for a loaded
  // transcript, and again when a turn pushes a new set. Ids already resolved are
  // never asked for twice.
  useEffect(() => {
    const missing = [
      ...new Set(
        bubbles.flatMap((bubble) => bubble.propertyIds ?? []).filter((id) => !(id in properties)),
      ),
    ];
    if (missing.length === 0) return;

    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(
          `/api/chat/properties?agencySlug=${encodeURIComponent(agencySlug)}&ids=${missing.map(encodeURIComponent).join(",")}`,
        );
        if (!response.ok) return;
        const body = (await response.json()) as { properties: WireProperty[] };
        if (cancelled) return;
        setProperties((current) => {
          const next = { ...current };
          for (const property of body.properties) next[property.id] = property;
          return next;
        });
      } catch {
        // The reply itself is on the screen; a card that failed to load is a
        // missing picture, not a broken conversation.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [agencySlug, bubbles, properties]);

  // 3 · sending --------------------------------------------------------------

  const post = useCallback(
    async (text: string, consent?: boolean): Promise<void> => {
      if (sessionId === null) return;
      const clientMessageId = newId();
      const key = newId();

      if (text !== "") {
        setBubbles((current) => [...current, { key, role: "lead", content: text, pending: true }]);
      }
      setNotice(null);

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agencySlug, sessionId, clientMessageId, text, consent }),
        });

        const body = (await response.json()) as {
          conversationId?: string;
          text?: string;
          error?: string;
        };

        setBubbles((current) =>
          current.map((bubble) => (bubble.key === key ? { ...bubble, pending: false } : bubble)),
        );

        if (response.status === 200 && body.text !== undefined) {
          // A refusal that costs no model call and is not part of the
          // transcript: pre-consent text, the budget, a message too long. The
          // lead's own words are marked local too — nothing was stored, so
          // claiming "recebido" under them would be a small lie, and they will
          // not be there after a reload.
          setBubbles((current) => [
            ...current.map((bubble) => (bubble.key === key ? { ...bubble, local: true } : bubble)),
            { key: newId(), role: "agent", content: body.text as string, local: true },
          ]);
          return;
        }

        if (response.status !== 202) {
          setNotice("Não consegui enviar sua mensagem. Pode tentar de novo?");
          return;
        }

        if (body.conversationId !== undefined) setConversationId(body.conversationId);
        if (consent === true) setConsented(true);
        // FR-049: the turn has started, and it starts by thinking.
        if (text !== "") setTyping(true);
      } catch {
        setBubbles((current) =>
          current.map((bubble) => (bubble.key === key ? { ...bubble, pending: false } : bubble)),
        );
        setNotice("Não consegui enviar sua mensagem. Pode tentar de novo?");
      }
    },
    [agencySlug, sessionId],
  );

  const accept = useCallback(async (): Promise<void> => {
    await post("", true);
  }, [post]);

  const submit = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      const text = draft.trim();
      if (text === "") return;
      setDraft("");
      void post(text);
    },
    [draft, post],
  );

  /**
   * FR-004c: "Interessado" on a card says what the lead would have typed, and
   * says it as the lead — the same send path, the same bubble, the same turn.
   */
  const interested = useCallback(
    (code: string) => {
      void post(`Interessado em ${code}`);
    },
    [post],
  );

  // 4 · rendering ------------------------------------------------------------

  /**
   * FR-045: quote only when a lead message exists *after* the one this reply
   * answered — the WhatsApp rule, and the reason a reply that answered the last
   * thing said carries no quote at all. Comparing against "the newest lead
   * bubble" was not the same test: a bubble the server has not confirmed yet
   * carries no id, so on a fresh conversation every reply looked like it had
   * skipped something.
   */
  const quotedFor = (bubble: Bubble, index: number): string | null => {
    if (bubble.role === "lead" || bubble.repliesToMessageId === undefined) return null;
    const quotedIndex = bubbles.findIndex(
      (candidate) => candidate.id === bubble.repliesToMessageId,
    );
    if (quotedIndex === -1) return null;
    const newerLeadMessage = bubbles
      .slice(quotedIndex + 1, index)
      .some((candidate) => candidate.role === "lead" && candidate.local !== true);
    return newerLeadMessage ? firstLine(bubbles[quotedIndex].content) : null;
  };

  const closed = status === "closed";
  const sendingDisabled = connection === "lost" || closed || sessionId === null;

  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.avatar} aria-hidden="true">
          S
        </div>
        <div className={styles.identity}>
          <p className={styles.agency}>{agencyName}</p>
          <p className={styles.persona}>
            {status === "paused" ? "Falando com um corretor" : "Sofia · assistente virtual"}
          </p>
        </div>
        {status === "paused" ? <span className={styles.badge}>Corretor</span> : null}
      </header>

      {connection === "lost" ? (
        <p className={styles.strip} role="status">
          Conexão perdida. Reconectando…
        </p>
      ) : null}

      <div className={styles.transcript}>
        {/* The transcript is not empty, it is unknown: showing the consent
            notice before the history has answered would flash it at a lead who
            accepted weeks ago. */}
        {!loaded ? (
          <p className={styles.loading} role="status">
            Carregando a conversa…
          </p>
        ) : null}

        {/* FR-018: the consent notice is the first agent message *on open*, and
            it is said by the widget — nothing is generated and nothing is stored
            until the lead accepts. It stays after acceptance, without its
            button: what someone agreed to should not vanish the moment they
            agree to it. */}
        {loaded ? (
          <div className={`${styles.bubble} ${styles.agentBubble} ${styles.consent}`}>
            <p className={styles.text}>{consentNotice}</p>
            {consented ? (
              <p className={styles.accepted}>Você aceitou.</p>
            ) : (
              <button type="button" className={styles.accept} onClick={() => void accept()}>
                Aceito
              </button>
            )}
          </div>
        ) : null}

        {/* US2 scenario 4: accepting starts the script, and the script's first
            question is the intent. It is rendered, not generated — the same
            deterministic question `domain/slots.ts` would choose — and it is
            derived from state rather than appended on the tap, so it is still
            there after a reload and gone the moment a real turn exists. */}
        {loaded && consented && !bubbles.some((bubble) => bubble.id !== undefined) ? (
          <div className={`${styles.bubble} ${styles.agentBubble}`}>
            <p className={styles.text}>{openingQuestion}</p>
          </div>
        ) : null}

        {bubbles.map((bubble, index) => {
          const quote = quotedFor(bubble, index);
          const cards = (bubble.propertyIds ?? [])
            .map((id) => properties[id])
            .filter((property) => property !== undefined);
          return (
            <div
              key={bubble.key}
              className={`${styles.bubble} ${
                bubble.role === "lead" ? styles.leadBubble : styles.agentBubble
              }`}
            >
              {/* FR-034: a message a person typed must not read as the agent's.
                  The name is deliberately absent — the lead was told "um
                  corretor", and the panel is where a name belongs. */}
              {bubble.role === "broker" ? (
                <span className={styles.author}>Corretor</span>
              ) : null}
              {quote === null ? null : (
                <p className={styles.quote}>
                  <span className={styles.quoteLabel}>Você</span>
                  {quote}
                </p>
              )}
              <p className={styles.text}>{bubble.content}</p>
              {/* FR-021: the cards are built from catalog rows, never from the
                  reply's own words — which is why they hang off `propertyIds`
                  and not off anything the model wrote. */}
              {cards.length === 0 ? null : (
                <div className={styles.cards}>
                  {cards.map((property) => (
                    <PropertyCard
                      key={property.id}
                      property={property}
                      onInterested={sendingDisabled ? undefined : interested}
                    />
                  ))}
                </div>
              )}
              {bubble.booking === undefined ? null : (
                <MeetingCard booking={bubble.booking} timeZone={timeZone} />
              )}
              {bubble.role === "lead" && bubble.local !== true ? (
                <span className={styles.state}>
                  {bubble.pending === true ? "enviando" : "recebido"}
                </span>
              ) : null}
            </div>
          );
        })}

        {typing ? (
          <div
            className={`${styles.bubble} ${styles.agentBubble} ${styles.typing}`}
            aria-label="Sofia está digitando"
            role="status"
          >
            <span />
            <span />
            <span />
          </div>
        ) : null}

        <div ref={endRef} />
      </div>

      {notice === null ? null : (
        <p className={styles.strip} role="alert">
          {notice}
        </p>
      )}

      <form className={styles.composer} onSubmit={submit}>
        <input
          className={styles.input}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={closed ? "Conversa encerrada" : "Escreva sua mensagem…"}
          aria-label="Sua mensagem"
          disabled={sendingDisabled}
          autoComplete="off"
        />
        <button
          type="submit"
          className={styles.send}
          disabled={sendingDisabled || draft.trim() === ""}
          aria-label="Enviar"
        >
          Enviar
        </button>
      </form>
    </main>
  );
}
