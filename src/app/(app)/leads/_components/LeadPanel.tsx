import type { LeadDetail } from "@/services/leads";
import type { UserRole } from "@/core/auth";
import { ConversationChip } from "./ConversationChip";
import { StageChip } from "./StageChip";
import { QualificationTable } from "./QualificationTable";
import { ActionsRow } from "./ActionsRow";
import { Transcript } from "./Transcript";
import { ReplyBox } from "./ReplyBox";
import { Timeline } from "./Timeline";
import { absoluteTime, relativeTime } from "./format";
import { TEMPERATURE_LABEL, INTENT_LABEL } from "./labels";
import styles from "../leads.module.css";

/**
 * FR-027: header, AI summary, qualification, actions, transcript, timeline —
 * in exactly this order, so the summary and the qualification sit above the
 * fold (constitution X) and the transcript is never the first thing read.
 */
export function LeadPanel({
  detail,
  currentUserId,
  role,
  brokers,
  langfuseUiPort,
}: {
  detail: LeadDetail;
  currentUserId: string;
  role: UserRole;
  brokers: Array<{ id: string; name: string }>;
  langfuseUiPort: number;
}) {
  const heldByUserId = detail.conversation.heldByUserId;
  const isHeldByMe = heldByUserId === currentUserId;

  const replyDisabledReason =
    detail.conversation.status === "closed"
      ? "Esta conversa já foi encerrada."
      : heldByUserId === null
        ? "Assuma a conversa para responder ao lead."
        : `${detail.conversation.heldByName ?? "Outro corretor"} está no comando desta conversa.`;

  return (
    <div>
      <header className={styles.panelHeader}>
        <div className={styles.panelHeaderTop}>
          <span className={styles.tempGroup}>
            <span className={styles.tempDot} data-temp={detail.temperature} aria-hidden="true" />
            <span className={styles.tempLabel}>{TEMPERATURE_LABEL[detail.temperature]}</span>
          </span>
          <h2 className={styles.panelName}>{detail.name ?? "Lead anônimo"}</h2>
        </div>
        <p className={styles.panelMeta}>
          {INTENT_LABEL[detail.intent]}
          {detail.phone ? ` · ${detail.phone}` : ""}
          {detail.email ? ` · ${detail.email}` : ""}
        </p>
        <div className={styles.panelChips}>
          <StageChip stage={detail.stage} />
          <ConversationChip state={detail.conversation.state} />
        </div>
      </header>

      <section className={styles.section} aria-labelledby="lead-panel-summary">
        <h3 id="lead-panel-summary" className={styles.sectionTitle}>
          Resumo (IA)
        </h3>
        {/*
          A stale summary that looks current is worse than no summary: a broker
          reads it as "what this lead wants" and walks into the call one
          exchange behind. The dot says the gap exists and that it closes on its
          own, so nobody goes looking for a button to press.
        */}
        {detail.conversation.summaryStale && (
          <p className={styles.summaryStale}>
            <span className={styles.stalePulse} aria-hidden="true" />
            {detail.conversation.summary === null
              ? "Resumindo a conversa — o resumo aparece aqui em instantes."
              : "Este resumo não inclui as últimas mensagens. Será atualizado em instantes."}
          </p>
        )}
        <p className={styles.summaryText}>
          {detail.conversation.summary ?? "Ainda não há um resumo desta conversa."}
        </p>
        {detail.conversation.summaryUpdatedAt && (
          <p className={styles.summaryMeta} title={absoluteTime(detail.conversation.summaryUpdatedAt)}>
            Atualizado {relativeTime(detail.conversation.summaryUpdatedAt)}
          </p>
        )}
      </section>

      <section className={styles.section} aria-labelledby="lead-panel-qualification">
        <h3 id="lead-panel-qualification" className={styles.sectionTitle}>
          Qualificação
        </h3>
        <QualificationTable intent={detail.intent} slots={detail.conversation.slots} />
      </section>

      <section className={styles.section} aria-labelledby="lead-panel-actions">
        <h3 id="lead-panel-actions" className={styles.sectionTitle}>
          Ações
        </h3>
        <ActionsRow
          leadId={detail.id}
          currentUserId={currentUserId}
          heldByUserId={heldByUserId}
          conversationStatus={detail.conversation.status}
          stage={detail.stage}
          role={role}
          brokers={brokers}
        />
      </section>

      <section className={styles.section} aria-labelledby="lead-panel-conversation">
        <h3 id="lead-panel-conversation" className={styles.sectionTitle}>
          Conversa
        </h3>
        <Transcript messages={detail.messages} />
        <ReplyBox leadId={detail.id} enabled={isHeldByMe} disabledReason={replyDisabledReason} />
      </section>

      <section className={styles.section} aria-labelledby="lead-panel-timeline">
        <h3 id="lead-panel-timeline" className={styles.sectionTitle}>
          Linha do tempo
        </h3>
        <Timeline events={detail.events} langfuseUiPort={langfuseUiPort} />
      </section>
    </div>
  );
}
