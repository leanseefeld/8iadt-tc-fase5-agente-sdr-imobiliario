import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { getConfig } from "../core/config.ts";

/**
 * The only module in the repository that imports a provider SDK.
 *
 * Constitution VI: swapping oMLX for a hosted endpoint must be a change to
 * environment variables and nothing else. ADR 16 allows exactly three provider
 * variables plus the model id, and `PROVIDER_AUTH_HEADER` is the third — some
 * gateways carry the key under their own header instead of `Authorization`.
 *
 * Nothing here reaches the network at import time; the model is built on first
 * use so that a process without a provider still boots.
 */

/**
 * Extra fields on the request body, for the two things this provider's typed
 * options cannot express.
 *
 * The OpenAI-compatible provider has a fixed set of `providerOptions` and no
 * generic "extra body fields" escape hatch, so the body is rewritten in the one
 * place the SDK does expose: its `fetch`.
 *
 * - `chat_template_kwargs.enable_thinking` is how oMLX takes the thinking switch,
 *   verified 08/09/2026; the reply then carries `reasoning_content`.
 * - `response_format: { type: "json_object" }` is how the extraction asks for
 *   JSON. Not `json_schema`: oMLX accepts a schema and then fails to constrain
 *   to it — measured over 96 calls, the model answered with a bare
 *   `["zona sul"]` and ran to the token ceiling on most of them, and at
 *   temperature 0 it did so every single time. Plain JSON mode, with the field
 *   guide in the prompt, parsed 30 out of 30 with no wrong values.
 */
function rewritingFetch(extra: Record<string, unknown>) {
  return async function fetchWithExtras(
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> {
    if (init === undefined || typeof init.body !== "string") return fetch(input, init);

    let body: unknown;
    try {
      body = JSON.parse(init.body);
    } catch {
      return fetch(input, init);
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return fetch(input, init);
    }

    return fetch(input, { ...init, body: JSON.stringify({ ...body, ...extra }) });
  };
}

function buildProvider(extra: Record<string, unknown>) {
  const config = getConfig();
  const header = config.PROVIDER_AUTH_HEADER;
  const thinking = config.MODEL_THINKING ? { chat_template_kwargs: { enable_thinking: true } } : {};
  const rewrites = { ...thinking, ...extra };

  return createOpenAICompatible({
    name: "sdr-provider",
    baseURL: config.PROVIDER_BASE_URL,
    // Off by default in this provider, and without it `generateObject` sends no
    // `response_format` at all and every structured call fails to parse.
    // `agent/recovery.ts`'s one-field schema is what still relies on it.
    supportsStructuredOutputs: true,
    // Sends `stream_options: { include_usage: true }`. Both model calls in this
    // agent stream, and a streaming OpenAI-compatible response carries **no**
    // usage at all unless this asks for it — which is why every generation span
    // reported zero tokens until 09/09/2026. oMLX then closes the stream with a
    // choice-less chunk carrying prompt/completion counts and
    // `prompt_tokens_details.cached_tokens`, the prefix-cache hit rate the lead
    // brief asks us to watch.
    includeUsage: true,
    // `apiKey` means `Authorization: Bearer`. When a header name is configured
    // the key goes there instead, and only there — never both.
    ...(header === undefined
      ? { apiKey: config.PROVIDER_API_KEY }
      : { headers: { [header]: config.PROVIDER_API_KEY } }),
    ...(Object.keys(rewrites).length === 0 ? {} : { fetch: rewritingFetch(rewrites) }),
  });
}

let provider: ReturnType<typeof buildProvider> | undefined;
let jsonProvider: ReturnType<typeof buildProvider> | undefined;

/**
 * A model that stands in for the provider, for every call in this process.
 * Tests only: a scripted model (`tests/support/scripted-model.ts`) makes the
 * code's decisions testable without a sampler in the loop. On `globalThis`
 * so every module instance sees the same one.
 */
const OVERRIDE = Symbol.for("sdr.agent.provider.override");

export function overrideModel(model: LanguageModel | null): void {
  (globalThis as Record<symbol, LanguageModel | undefined>)[OVERRIDE] = model ?? undefined;
}

function overridden(): LanguageModel | undefined {
  return (globalThis as Record<symbol, LanguageModel | undefined>)[OVERRIDE];
}

/** The configured chat model. `modelId` is for the rare call that needs another. */
export function getModel(modelId?: string): LanguageModel {
  const stand = overridden();
  if (stand !== undefined) return stand;
  provider ??= buildProvider({});
  return provider.chatModel(modelId ?? getConfig().MODEL_ID);
}

/**
 * The same model, asked to answer in JSON. Used by the extraction, which parses
 * the text itself — see `rewritingFetch` for why the schema is not sent.
 */
export function getJsonModel(): LanguageModel {
  const stand = overridden();
  if (stand !== undefined) return stand;
  jsonProvider ??= buildProvider({ response_format: { type: "json_object" } });
  return jsonProvider.chatModel(getConfig().MODEL_ID);
}

export interface ModelCall {
  model: LanguageModel;
  maxOutputTokens: number;
  maxRetries: number;
  /** Total milliseconds for the call, retries included (FR-014). */
  timeout: number;
}

/**
 * The defaults every model call carries, meant to be spread:
 *
 *   streamText({ ...modelCall(), messages, tools })
 *
 * A bounded timeout and a bounded retry count are FR-014, and the output
 * ceiling includes reasoning tokens — which is why `MODEL_MAX_OUTPUT_TOKENS`
 * defaults higher when `MODEL_THINKING` is on.
 */
export function modelCall(): ModelCall {
  const config = getConfig();
  return {
    model: getModel(),
    maxOutputTokens: config.MODEL_MAX_OUTPUT_TOKENS,
    maxRetries: config.MODEL_MAX_RETRIES,
    timeout: config.MODEL_TIMEOUT_MS,
  };
}
