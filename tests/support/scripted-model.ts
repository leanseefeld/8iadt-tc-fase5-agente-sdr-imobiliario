import type { LanguageModelV4CallOptions, LanguageModelV4Content, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import { overrideModel } from "../../src/agent/provider.ts";

/**
 * A model that says what the test tells it to, so a turn's **code** decisions
 * can be tested without a sampler in the loop.
 *
 * Each lead message consumes one `Script`: the extraction answers with its
 * `facts` as JSON, the action loop calls the `act` tools (then stops), and the
 * phrasing call streams `reply`. What the code writes itself — options,
 * confirmations, "quer mesmo cancelar?" — never reaches the model, which is
 * exactly what these tests are about.
 *
 * The call is told apart by what it carries, the way the agent sends it: the
 * extraction's system prompt, the action loop's tools, anything else a reply.
 */
export interface Script {
  /** What the extraction "read" in this message. Anything left out is null/false. */
  facts?: Record<string, unknown>;
  /** Tools the action loop calls, in order. The loop stops after them. */
  act?: Array<{ tool: string; input: Record<string, unknown> }>;
  /** The phrased reply. Defaults to a neutral sentence. */
  reply?: string;
}

export interface ScriptedModel {
  /** Queue what the next lead messages will be read as. */
  push(...scripts: Script[]): void;
  /** Every system prompt the phrasing call received, newest last. */
  readonly briefings: string[];
  /** Restores the real provider. */
  restore(): void;
}

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

type Kind = "extract" | "act" | "reply";

function systemText(options: LanguageModelV4CallOptions): string {
  return options.prompt
    .filter((message) => message.role === "system")
    .map((message) => (typeof message.content === "string" ? message.content : ""))
    .join("\n");
}

function kindOf(options: LanguageModelV4CallOptions): Kind {
  if (systemText(options).startsWith("Você lê mensagens")) return "extract";
  if ((options.tools ?? []).length > 0) return "act";
  return "reply";
}

/** The briefing is the last system-ish text the reply call carries. */
function lastText(options: LanguageModelV4CallOptions): string {
  const texts: string[] = [];
  for (const message of options.prompt) {
    if (typeof message.content === "string") texts.push(message.content);
    else for (const part of message.content) if (part.type === "text") texts.push(part.text);
  }
  return texts.join("\n");
}

export function useScriptedModel(): ScriptedModel {
  const queue: Script[] = [];
  let current: Script = {};
  const briefings: string[] = [];
  let calls = 0;

  function answer(options: LanguageModelV4CallOptions): { content: LanguageModelV4Content[]; tools: boolean } {
    const kind = kindOf(options);
    if (kind === "extract") {
      current = queue.shift() ?? {};
      return { content: [{ type: "text", text: JSON.stringify(current.facts ?? {}) }], tools: false };
    }
    if (kind === "act") {
      // A second step carries the first step's tool results: stop there.
      const answered = options.prompt.some((message) => message.role === "tool");
      if (answered || (current.act ?? []).length === 0) return { content: [], tools: false };
      return {
        content: (current.act ?? []).map((call) => ({
          type: "tool-call" as const,
          toolCallId: `call_${++calls}`,
          toolName: call.tool,
          input: JSON.stringify(call.input),
        })),
        tools: true,
      };
    }
    briefings.push(lastText(options));
    return { content: [{ type: "text", text: current.reply ?? "Entendi, obrigada por contar." }], tools: false };
  }

  const model = new MockLanguageModelV4({
    provider: "scripted",
    modelId: "scripted",
    doGenerate: async (options) => {
      const { content, tools } = answer(options);
      return {
        content,
        finishReason: { unified: tools ? "tool-calls" : "stop", raw: undefined },
        usage: USAGE,
        warnings: [],
      };
    },
    doStream: async (options) => {
      const { content, tools } = answer(options);
      const parts: LanguageModelV4StreamPart[] = [{ type: "stream-start", warnings: [] }];
      for (const item of content) {
        if (item.type === "text") {
          parts.push({ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: item.text }, { type: "text-end", id: "t" });
        } else {
          parts.push(item as LanguageModelV4StreamPart);
        }
      }
      parts.push({ type: "finish", finishReason: { unified: tools ? "tool-calls" : "stop", raw: undefined }, usage: USAGE });
      return { stream: convertArrayToReadableStream(parts) };
    },
  });

  overrideModel(model);
  return {
    push: (...scripts) => queue.push(...scripts),
    briefings,
    restore: () => overrideModel(null),
  };
}
