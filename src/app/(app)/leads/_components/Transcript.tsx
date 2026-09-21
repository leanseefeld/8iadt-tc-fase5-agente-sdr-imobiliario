import type { PanelMessage } from "@/services/leads";
import { absoluteTime, relativeTime } from "./format";
import styles from "../leads.module.css";

/**
 * FR-029: the whole conversation, never a window — `getLeadDetail` already
 * reads every row. Roles are visually distinct (background + alignment) and
 * a broker's own words are always labelled as a person's, never folded into
 * the agent's bubble.
 */
function roleLabel(message: PanelMessage): string {
  switch (message.role) {
    case "lead":
      return "Lead";
    case "agent":
      return "Agente";
    case "broker":
      return message.authorName ? `${message.authorName} (corretor)` : "Corretor";
    case "system":
      return "Sistema";
  }
}

export function Transcript({ messages }: { messages: PanelMessage[] }) {
  if (messages.length === 0) {
    return <p className={styles.helperText}>Nenhuma mensagem trocada ainda.</p>;
  }

  return (
    <div className={styles.transcript}>
      {messages.map((message) => (
        <div key={message.id} className={`${styles.message} ${styles[`message_${message.role}`]}`}>
          <span className={styles.messageMeta} title={absoluteTime(message.createdAt)}>
            {roleLabel(message)} · {relativeTime(message.createdAt)}
          </span>
          <p className={styles.messageContent}>{message.content}</p>
          {message.propertyIds.length > 0 && (
            <span className={styles.propertyChip}>
              {message.propertyIds.length === 1
                ? "1 imóvel sugerido"
                : `${message.propertyIds.length} imóveis sugeridos`}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
