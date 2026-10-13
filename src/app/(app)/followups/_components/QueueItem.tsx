"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cancelQueuedAction, sendNowAction, sendOwnAction } from "../actions";
import styles from "../followups.module.css";

export interface QueueItemData {
  jobId: string;
  kind: "followup" | "reminder";
  /** "13:00" — when it really goes. */
  time: string;
  /** Set for rows beyond tomorrow: "qui 15/10". */
  day: string | null;
  leadId: string;
  leadName: string | null;
  /** "Follow-up 2 de 3" · "Lembrete". */
  label: string;
  /** The conversation's preview line, or the meeting a reminder announces. */
  detail: string | null;
  /** A follow-up due while the window is closed: when it will really go. */
  waitingNote: string | null;
  /** Already due: the worker picks it up at its next sweep. */
  overdue: boolean;
  /** Why *Enviar agora* is refused, in words. */
  blocker: string | null;
}

type Mode = "idle" | "writing" | "confirmCancel";

/**
 * One queued message, read the way the queue is checked: when, who, what kind.
 * *Enviar agora* is the primary action; for a follow-up, *Eu escrevo* opens a
 * box for the broker's own text instead of Sofia's; *Cancelar* asks once.
 * After a send the row says so and the page refreshes until the worker has
 * sent it and the row is gone.
 */
export function QueueItem({ row }: { row: QueueItemData }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [mode, setMode] = useState<Mode>("idle");
  const [text, setText] = useState("");
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const refreshes = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => () => refreshes.current.forEach(clearTimeout), []);

  function refreshSoon(): void {
    // The worker is rung at once; these catch the row leaving the queue.
    for (const ms of [1500, 4000, 10000]) refreshes.current.push(setTimeout(() => router.refresh(), ms));
  }

  function sendNow(): void {
    startTransition(async () => {
      const result = await sendNowAction(row.jobId);
      setMessage(result.ok ? { text: "Enviando…", error: false } : { text: result.message, error: true });
      if (result.ok) refreshSoon();
    });
  }

  function sendOwn(): void {
    startTransition(async () => {
      const result = await sendOwnAction(row.jobId, text);
      setMessage(result.ok ? { text: "Enviada.", error: false } : { text: result.message, error: true });
      if (result.ok) {
        setMode("idle");
        router.refresh();
      }
    });
  }

  function cancel(): void {
    startTransition(async () => {
      const result = await cancelQueuedAction(row.jobId);
      setMessage(result.ok ? { text: "Cancelado.", error: false } : { text: result.message, error: true });
      setMode("idle");
      if (result.ok) router.refresh();
    });
  }

  const busy = pending || message?.text === "Enviando…";
  const textId = `own-${row.jobId}`;

  return (
    <li className={styles.row} data-kind={row.kind}>
      <span className={styles.time}>
        {row.time}
        {row.day !== null && <span className={styles.dayHint}>{row.day}</span>}
      </span>
      <div className={styles.body}>
        <Link className={styles.lead} href={`/leads?mine=0&lead=${row.leadId}`}>
          {row.leadName ?? "Lead sem nome"}
        </Link>
        <span className={styles.kind} data-kind={row.kind}>
          {row.label}
        </span>
        {row.detail !== null && <span className={styles.detail}>{row.detail}</span>}
        {row.waitingNote !== null && <span className={styles.note}>{row.waitingNote}</span>}
        {row.waitingNote === null && row.overdue && row.blocker === null && (
          <span className={styles.note}>Na vez — sai na próxima varredura</span>
        )}
        {row.blocker !== null && <span className={styles.blocker}>{row.blocker}</span>}

        {mode === "writing" && (
          <div className={styles.own}>
            <label htmlFor={textId} className={styles.ownLabel}>
              Sua mensagem — sai com o seu nome e conta como este follow-up
            </label>
            <textarea
              id={textId}
              className={styles.ownText}
              value={text}
              onChange={(event) => setText(event.target.value)}
              rows={3}
              maxLength={1000}
              autoFocus
            />
            <div className={styles.actions}>
              <button type="button" className={styles.primary} disabled={pending || text.trim() === ""} onClick={sendOwn}>
                Enviar minha mensagem
              </button>
              <button type="button" className={styles.quiet} disabled={pending} onClick={() => setMode("idle")}>
                Voltar
              </button>
            </div>
          </div>
        )}
      </div>

      <div className={styles.side}>
        {mode === "confirmCancel" ? (
          <div className={styles.confirm} role="group" aria-label="Confirmar cancelamento">
            <span>{row.kind === "reminder" ? "Cancelar este lembrete?" : "Parar os follow-ups até o lead escrever?"}</span>
            <div className={styles.actions}>
              <button type="button" className={styles.danger} disabled={pending} onClick={cancel}>
                Sim, cancelar
              </button>
              <button type="button" className={styles.quiet} disabled={pending} onClick={() => setMode("idle")}>
                Não
              </button>
            </div>
          </div>
        ) : (
          mode === "idle" && (
            <div className={styles.actions}>
              <button type="button" className={styles.primary} disabled={busy || row.blocker !== null} onClick={sendNow}>
                Enviar agora
              </button>
              {row.kind === "followup" && (
                <button
                  type="button"
                  className={styles.quiet}
                  disabled={busy || row.blocker !== null}
                  onClick={() => setMode("writing")}
                >
                  Eu escrevo
                </button>
              )}
              <button type="button" className={styles.quiet} disabled={busy} onClick={() => setMode("confirmCancel")}>
                Cancelar
              </button>
            </div>
          )
        )}
        {message && (
          <span role="status" className={message.error ? styles.messageError : styles.message}>
            {message.text}
          </span>
        )}
      </div>
    </li>
  );
}
