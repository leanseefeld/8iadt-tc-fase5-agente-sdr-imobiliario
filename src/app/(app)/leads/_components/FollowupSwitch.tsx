"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { UserRole } from "@/core/auth";
import { setFollowupEnabledAction } from "../actions";
import styles from "../leads.module.css";

/**
 * Spec 006 FR-019, constitution X: the manager came to stop or restart the
 * agency's automatic messages. One labelled switch, its state in words, saved
 * on press with a word of feedback. A broker sees the same words, and no
 * control — the state is theirs to know, not to change.
 */
export function FollowupSwitch({ enabled, role }: { enabled: boolean; role: UserRole }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<{ text: string; error: boolean } | null>(null);
  const state = enabled ? "ligado" : "desligado";

  if (role !== "salesManager") {
    return (
      <p className={styles.followupSwitch}>
        Follow-up automático: <strong>{state}</strong>
      </p>
    );
  }

  function toggle(): void {
    startTransition(async () => {
      const result = await setFollowupEnabledAction(!enabled);
      setFeedback(
        result.ok
          ? { text: enabled ? "Desligado. Nenhum follow-up sai até ligar de novo." : "Ligado.", error: false }
          : { text: result.message, error: true },
      );
      if (result.ok) router.refresh();
    });
  }

  return (
    <div className={styles.followupSwitch}>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        className={styles.switchButton}
        data-on={enabled}
        onClick={toggle}
        disabled={pending}
      >
        <span className={styles.switchTrack} aria-hidden="true">
          <span className={styles.switchThumb} />
        </span>
        Follow-up automático: <strong>{state}</strong>
      </button>
      {feedback && (
        <span role="status" className={`${styles.actionMessage} ${feedback.error ? styles.actionMessageError : ""}`}>
          {feedback.text}
        </span>
      )}
    </div>
  );
}
