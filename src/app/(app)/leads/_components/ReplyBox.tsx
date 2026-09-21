"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { sendBrokerReplyAction } from "../actions";
import styles from "../leads.module.css";

/**
 * FR-034/FR-035: enabled only while the signed-in user holds the conversation;
 * disabled, it says why rather than just greying out (constitution X — every
 * state fed back in words).
 */
export function ReplyBox({
  leadId,
  enabled,
  disabledReason,
}: {
  leadId: string;
  enabled: boolean;
  disabledReason: string;
}) {
  const [text, setText] = useState("");
  const [feedback, setFeedback] = useState<{ text: string; error: boolean } | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  if (!enabled) {
    return <p className={styles.replyDisabledReason}>{disabledReason}</p>;
  }

  function submit(): void {
    const value = text.trim();
    if (value === "") return;
    startTransition(async () => {
      const result = await sendBrokerReplyAction(leadId, value);
      if (result.ok) {
        setText("");
        setFeedback(null);
        router.refresh();
      } else {
        setFeedback({ text: result.message, error: true });
      }
    });
  }

  return (
    <div className={styles.replyBox}>
      <textarea
        className={styles.replyTextarea}
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="Escreva a resposta para o lead…"
        disabled={pending}
        rows={3}
        aria-label="Resposta ao lead"
      />
      <button
        type="button"
        className={styles.primaryButton}
        onClick={submit}
        disabled={pending || text.trim() === ""}
      >
        {pending ? "Enviando…" : "Enviar"}
      </button>
      {feedback && (
        <p className={`${styles.actionMessage} ${feedback.error ? styles.actionMessageError : ""}`}>
          {feedback.text}
        </p>
      )}
    </div>
  );
}
