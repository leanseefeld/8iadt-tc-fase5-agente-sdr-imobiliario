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
}

type Feedback = { text: string; error: boolean } | null;

/**
 * FR-032 to FR-037, constitution X: Assumir/Devolver is the one primary
 * action; the stage move and the reassignment are secondary. A reassignment
 * needs the target broker's id — there is no broker picker in this slice
 * (no service exposes the agency's roster to `app/`), so a manager types the
 * id directly; a simplification, not a shortcut around the authorization
 * check, which still runs in `reassignLeadAction`.
 */
export function ActionsRow({ leadId, currentUserId, heldByUserId, conversationStatus, stage, role }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [primaryMessage, setPrimaryMessage] = useState<Feedback>(null);
  const [stageMessage, setStageMessage] = useState<Feedback>(null);
  const [reassignMessage, setReassignMessage] = useState<Feedback>(null);
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

      {role === "salesManager" && (
        <div className={styles.actionsSecondary}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              runReassign();
            }}
          >
            <input
              type="text"
              className={styles.textInput}
              placeholder="ID do novo corretor"
              value={brokerId}
              onChange={(event) => setBrokerId(event.target.value)}
              aria-label="ID do novo corretor"
            />
            <button type="submit" className={styles.secondaryButton} disabled={pending || brokerId.trim() === ""}>
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
