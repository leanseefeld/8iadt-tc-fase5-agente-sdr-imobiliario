"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { allowedTransitions, type LeadStage } from "@/domain/lead-status";
import type { UserRole } from "@/core/auth";
import {
  assumeConversationAction,
  returnToAgentAction,
  setLeadStatusAction,
  reassignLeadAction,
  triggerFollowupAction,
} from "../actions";
import { STAGE_LABEL } from "./labels";
import styles from "../leads.module.css";

interface Props {
  leadId: string;
  currentUserId: string;
  heldByUserId: string | null;
  conversationStatus: "active" | "paused" | "closed";
  stage: LeadStage;
  role: UserRole;
  /** The agency's brokers; empty for anyone who cannot reassign. */
  brokers: Array<{ id: string; name: string }>;
  /** Spec 006 FR-017: why the follow-up can't be sent now, or null when it can. */
  followupBlocker: string | null;
}

type Feedback = { text: string; error: boolean } | null;

/**
 * FR-032 to FR-037, constitution X: Assumir/Devolver is the one primary
 * action; the stage move and the reassignment are secondary. The reassignment
 * picks from the agency's brokers by name (`listAgencyBrokers`), and the
 * authorization check still runs server-side in `reassignLeadAction` — the
 * select decides what is easy to ask for, never what is allowed.
 */
export function ActionsRow({
  leadId,
  currentUserId,
  heldByUserId,
  conversationStatus,
  stage,
  role,
  brokers,
  followupBlocker,
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [primaryMessage, setPrimaryMessage] = useState<Feedback>(null);
  const [stageMessage, setStageMessage] = useState<Feedback>(null);
  const [reassignMessage, setReassignMessage] = useState<Feedback>(null);
  const [followupMessage, setFollowupMessage] = useState<Feedback>(null);
  const [nextStage, setNextStage] = useState<LeadStage | "">("");
  const [brokerId, setBrokerId] = useState("");

  const isHeldByMe = heldByUserId === currentUserId;
  const isClosed = conversationStatus === "closed";
  const transitions = allowedTransitions(stage);

  function runPrimary(): void {
    startTransition(async () => {
      const result = isHeldByMe
        ? await returnToAgentAction(leadId)
        : await assumeConversationAction(leadId);
      setPrimaryMessage(result.ok ? null : { text: result.message, error: true });
      if (result.ok) router.refresh();
    });
  }

  function runStageChange(): void {
    if (nextStage === "") return;
    startTransition(async () => {
      const result = await setLeadStatusAction(leadId, nextStage);
      setStageMessage(result.ok ? null : { text: result.message, error: true });
      if (result.ok) {
        setNextStage("");
        router.refresh();
      }
    });
  }

  function runFollowupNow(): void {
    startTransition(async () => {
      const result = await triggerFollowupAction(leadId);
      setFollowupMessage(
        result.ok
          ? { text: "Na fila: sai na próxima varredura do worker, dentro do horário de envio.", error: false }
          : { text: result.message, error: true },
      );
      if (result.ok) router.refresh();
    });
  }

  function runReassign(): void {
    const target = brokerId.trim();
    if (target === "") return;
    startTransition(async () => {
      const result = await reassignLeadAction(leadId, target);
      setReassignMessage(
        result.ok ? { text: "Lead transferido.", error: false } : { text: result.message, error: true },
      );
      if (result.ok) {
        setBrokerId("");
        router.refresh();
      }
    });
  }

  return (
    <div className={styles.actionsRow}>
      <div className={styles.actionsPrimary}>
        <button
          type="button"
          className={styles.primaryButton}
          onClick={runPrimary}
          disabled={pending || (isClosed && !isHeldByMe)}
        >
          {isHeldByMe ? "Devolver ao agente" : "Assumir conversa"}
        </button>
        {primaryMessage && (
          <p className={`${styles.actionMessage} ${primaryMessage.error ? styles.actionMessageError : ""}`}>
            {primaryMessage.text}
          </p>
        )}
      </div>

      <div className={styles.actionsSecondary}>
        {transitions.length > 0 ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              runStageChange();
            }}
          >
            <select
              className={styles.select}
              value={nextStage}
              onChange={(event) => setNextStage(event.target.value as LeadStage)}
              aria-label="Mover para etapa"
            >
              <option value="">Mover para…</option>
              {transitions.map((option) => (
                <option key={option} value={option}>
                  {STAGE_LABEL[option]}
                </option>
              ))}
            </select>
            <button type="submit" className={styles.secondaryButton} disabled={pending || nextStage === ""}>
              Mover
            </button>
          </form>
        ) : (
          <p className={styles.helperText}>Etapa final: não há para onde avançar.</p>
        )}
        {stageMessage && (
          <p className={`${styles.actionMessage} ${stageMessage.error ? styles.actionMessageError : ""}`}>
            {stageMessage.text}
          </p>
        )}
      </div>

      <div className={styles.actionsSecondary}>
        <button
          type="button"
          className={styles.secondaryButton}
          onClick={runFollowupNow}
          disabled={pending || followupBlocker !== null}
          aria-describedby={followupBlocker !== null ? `followup-blocker-${leadId}` : undefined}
        >
          Enviar follow-up agora
        </button>
        {followupBlocker !== null && !followupMessage && (
          <p id={`followup-blocker-${leadId}`} className={styles.helperText}>
            {followupBlocker}
          </p>
        )}
        {followupMessage && (
          <p className={`${styles.actionMessage} ${followupMessage.error ? styles.actionMessageError : ""}`}>
            {followupMessage.text}
          </p>
        )}
      </div>

      {role === "salesManager" && (
        <div className={styles.actionsSecondary}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              runReassign();
            }}
          >
            <select
              className={styles.select}
              value={brokerId}
              onChange={(event) => setBrokerId(event.target.value)}
              aria-label="Transferir para"
            >
              <option value="">Transferir para…</option>
              {brokers.map((broker) => (
                <option key={broker.id} value={broker.id}>
                  {broker.name}
                </option>
              ))}
            </select>
            <button type="submit" className={styles.secondaryButton} disabled={pending || brokerId === ""}>
              Transferir
            </button>
          </form>
          {reassignMessage && (
            <p className={`${styles.actionMessage} ${reassignMessage.error ? styles.actionMessageError : ""}`}>
              {reassignMessage.text}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
