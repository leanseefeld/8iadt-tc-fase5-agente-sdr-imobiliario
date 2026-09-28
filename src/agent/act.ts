import { generateText, stepCountIs, type ToolSet } from "ai";
import { modelTelemetry, recordToolSpans } from "../core/langfuse.ts";
import { createLogger } from "../core/logging.ts";
import type { LoadedTurn } from "../services/conversation.ts";
import { modelCall } from "./provider.ts";

/**
 * The bounded tool loop. It sits between extraction and phrasing, and it never
 * writes to the lead: its text is discarded. Only `phrase()` and the written
 * replies in `finish()` may reach the sink.
 */

const log = createLogger("app", { module: "agent/act" });

export const MAX_ACTION_STEPS = 3;

export interface ActInput {
  turn: LoadedTurn;
  briefing: string;
  /** The tools this turn may use. One entry, today. */
  tools: ToolSet;
}

export interface ActionStep {
  name: string;
  arguments: unknown;
  result: unknown;
  index: number;
  refused: boolean;
}

export interface ActResult {
  steps: ActionStep[];
  /** True when the loop stopped at the bound rather than because the model finished. */
  bounded: boolean;
  /** The loop never throws. A failure is a step plus this flag. */
  failed: boolean;
}

interface SdkToolCall {
  toolName: string;
  input: unknown;
  toolCallId: string;
}

interface SdkToolResult {
  toolCallId: string;
  output: unknown;
}

function isRefusal(result: unknown): boolean {
  return (
    result !== null &&
    typeof result === "object" &&
    "ok" in result &&
    (result as { ok: unknown }).ok === false
  );
}

/**
 * One conditional call. A turn with nothing to do never reaches here.
 * Reaching the step bound stops tool offering and returns what was collected.
 */
export async function act(input: ActInput): Promise<ActResult> {
  try {
    const result = await generateText({
      ...modelCall(),
      ...modelTelemetry("model.act"),
      stopWhen: stepCountIs(MAX_ACTION_STEPS),
      tools: input.tools,
      // The lead never reads this call. The sentence is phrased afterwards.
      system:
        "Você pode chamar a ferramenta de busca. Não escreva uma resposta para a pessoa. " +
        "Quando a busca não for necessária, não chame nada.",
      prompt: input.briefing,
    });

    // `text` is the model's scratch reasoning. Drop it on purpose (FR-012).
    void result.text;

    const steps: ActionStep[] = [];
    for (const step of result.steps) {
      const calls = step.toolCalls as SdkToolCall[];
      const results = step.toolResults as SdkToolResult[];
      for (const call of calls) {
        const matched = results.find((item) => item.toolCallId === call.toolCallId);
        const output = matched?.output;
        steps.push({
          name: call.toolName,
          arguments: call.input,
          result: output,
          index: steps.length,
          refused: isRefusal(output),
        });
      }
    }

    recordToolSpans(
      steps.map((step) => ({
        name: step.name,
        attributes: { arguments: step.arguments },
        result: step.result,
        stepIndex: step.index,
        refused: step.refused,
      })),
    );

    const bounded = result.steps.length >= MAX_ACTION_STEPS && result.finishReason !== "stop";
    log.info(
      { conversationId: input.turn.conversation.id, count: steps.length, bounded },
      "action loop finished",
    );
    return { steps, bounded, failed: false };
  } catch (error) {
    // A provider error or a tool exception becomes a recorded step. The turn
    // still phrases a reply (FR-016).
    log.warn({ err: (error as Error).message }, "action loop failed");
    const failedStep: ActionStep = {
      name: "searchProperties",
      arguments: {},
      result: { ok: false, reason: "failed", message: (error as Error).message },
      index: 0,
      refused: false,
    };
    recordToolSpans([
      {
        name: failedStep.name,
        attributes: { arguments: failedStep.arguments },
        result: failedStep.result,
        stepIndex: 0,
        refused: false,
      },
    ]);
    return { steps: [failedStep], bounded: false, failed: true };
  }
}
