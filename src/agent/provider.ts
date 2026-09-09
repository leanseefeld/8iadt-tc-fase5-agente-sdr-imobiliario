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
 * oMLX takes the thinking switch only in the request body, and the OpenAI
 * compatible provider has no generic "extra body fields" option — its
 * `providerOptions` are a fixed four. So the body is rewritten in the one place
 * the SDK does expose: its `fetch`. Verified against oMLX on 08/09/2026;
 * `reasoning_content` comes back on the reply and belongs to the trace, never
 * to the widget.
 */
async function fetchWithThinking(
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

  const withThinking = { ...body, chat_template_kwargs: { enable_thinking: true } };
  return fetch(input, { ...init, body: JSON.stringify(withThinking) });
}

function buildProvider() {
  const config = getConfig();
  const header = config.PROVIDER_AUTH_HEADER;

  return createOpenAICompatible({
    name: "sdr-provider",
    baseURL: config.PROVIDER_BASE_URL,
    // Off by default in this provider, and without it `generateObject` sends no
    // `response_format` at all and every structured call fails to parse.
    // Verified against oMLX on 08/09/2026: a `json_schema` response format comes
    // back as clean JSON. A gateway that lacks it degrades to the same failure
    // `agent/recovery.ts` already treats as "the slot stays empty".
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
    ...(config.MODEL_THINKING ? { fetch: fetchWithThinking } : {}),
  });
}

let provider: ReturnType<typeof buildProvider> | undefined;

/** The configured chat model. `modelId` is for the rare call that needs another. */
export function getModel(modelId?: string): LanguageModel {
  provider ??= buildProvider();
  return provider.chatModel(modelId ?? getConfig().MODEL_ID);
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
