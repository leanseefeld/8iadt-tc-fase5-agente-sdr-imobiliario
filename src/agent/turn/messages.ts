import type { ModelMessage } from "ai";
import type { LoadedTurn } from "../../services/conversation.ts";

/**
 * The conversation as the model reads it — shared by every model call of a
 * turn, so the transcript is shaped the same way for the extraction and for
 * the reply, and the provider's prefix cache sees the same bytes.
 */

/**
 * Gemma's chat template wants the roles to alternate, so consecutive messages
 * from the same side are joined rather than sent as two turns. Everything the
 * model sees is already bounded to `MODEL_HISTORY_WINDOW` by `loadTurn`.
 */
export function toModelMessages(turn: LoadedTurn, limit?: number): ModelMessage[] {
  const messages: ModelMessage[] = [];
  // Handovers are woven into the transcript in timestamp order, not described
  // in the briefing, for the reason the briefing itself moved: everything
  // before the final user turn has to stay byte-identical between calls or the
  // provider's prefix cache throws the whole conversation away (measured at
  // 82–84% hits in spec 004). A marker beside the message it explains is
  // cached with it; the same fact in the briefing would be re-encoded forever.
  const pending = [...turn.handovers];

  const say = (role: "user" | "assistant", content: string) => {
    const previous = messages.at(-1);
    if (previous !== undefined && previous.role === role) {
      previous.content = `${previous.content as string}\n${content}`;
      return;
    }
    messages.push({ role, content });
  };

  for (const message of turn.history) {
    if (message.role === "system") continue;

    while (pending.length > 0 && pending[0].at <= message.createdAt) {
      const handover = pending.shift();
      if (handover === undefined) break;
      say(
        "assistant",
        handover.kind === "assumed"
          ? `[${handover.name} (corretor) assumiu a conversa]`
          : `[${handover.name} devolveu a conversa para você]`,
      );
    }

    const role = message.role === "lead" ? "user" : "assistant";
    // A broker's words arriving as `assistant` is how this agent used to read
    // "Oi, aqui é a Ana" as something it had said itself. The label is the
    // whole fix: the model is told which assistant lines are not its own.
    const authorId = message.metadata.userId;
    const author = typeof authorId === "string" ? turn.brokerNames[authorId] : undefined;
    const content =
      message.role === "broker"
        ? `[${author ?? "Corretor"} escreveu] ${message.content}`
        : message.content;
    say(role, content);
  }

  for (const handover of pending) {
    say(
      "assistant",
      handover.kind === "assumed"
        ? `[${handover.name} (corretor) assumiu a conversa]`
        : `[${handover.name} devolveu a conversa para você]`,
    );
  }

  const trimmed = limit === undefined ? messages : messages.slice(-limit);
  // A turn exists because a lead wrote; the model must end on their words.
  if (trimmed.at(-1)?.role !== "user") {
    trimmed.push({ role: "user", content: unansweredText(turn) });
  }
  return trimmed;
}

/**
 * Puts the turn's briefing immediately before the lead's own words, inside the
 * last user turn.
 *
 * Two constraints decide the shape. AI SDK 7 refuses a `system` message inside
 * `messages` ("use the instructions option instead"), and Gemma's template wants
 * the roles to alternate, so the briefing cannot be a message of its own either
 * way. It therefore rides in the final user turn, fenced and labelled, with the
 * lead's text last — instructions, then the thing to answer.
 *
 * The caching property survives intact, which is the whole reason for the move:
 * everything before this last turn is byte-identical to the previous call, so
 * the server's prefix cache keeps the entire conversation instead of discarding
 * it behind a system prompt that changed. The labels also matter on their own —
 * the model is told which half is ours and which half is the lead's, and the
 * lead's half is the half it must answer.
 */
export function briefed(messages: ModelMessage[], briefing: string): ModelMessage[] {
  const fenced = (leadText: string) =>
    [
      "[CONTEXTO PARA VOCÊ — instruções do sistema, não é mensagem da pessoa]",
      briefing,
      "",
      "[MENSAGEM DA PESSOA — responda a isto]",
      leadText,
    ].join("\n");

  const last = messages.at(-1);
  if (last === undefined || last.role !== "user") {
    return [...messages, { role: "user", content: fenced("") }];
  }
  return [
    ...messages.slice(0, -1),
    { role: "user", content: fenced(last.content as string) },
  ];
}

/** FR-044: one turn answers every lead message left unanswered, together. */
export function unansweredText(turn: LoadedTurn): string {
  return turn.unanswered.map((message) => message.content).join("\n");
}
