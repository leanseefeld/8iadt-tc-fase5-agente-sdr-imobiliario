import test from "node:test";
import assert from "node:assert/strict";
import { profileExtras, rewriteBody } from "../src/agent/provider.ts";
import type { ModelProfile } from "../src/core/model-profile.ts";

/**
 * Spec 016: one request body for oMLX and for Azure's gpt-5 family, which
 * refuses `max_tokens`. oMLX honours `max_completion_tokens` the same way.
 */
test("the output ceiling is sent as max_completion_tokens", () => {
  assert.deepEqual(rewriteBody({ model: "m", max_tokens: 300, stream: true }, {}), {
    model: "m",
    stream: true,
    max_completion_tokens: 300,
  });
  assert.deepEqual(rewriteBody({ model: "m" }, {}), { model: "m" }, "no ceiling, none added");
});

test("the extras still reach the body: JSON mode, the thinking switch", () => {
  const body = rewriteBody(
    { model: "m", max_tokens: 50 },
    { response_format: { type: "json_object" }, chat_template_kwargs: { enable_thinking: true } },
  );
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.deepEqual(body.chat_template_kwargs, { enable_thinking: true });
  assert.equal(body.max_completion_tokens, 50);
  assert.equal("max_tokens" in body, false);
});

const LOCAL: ModelProfile = {
  name: "local",
  baseUrl: "http://local.test/v1",
  apiKey: "k",
  modelId: "m",
  thinking: false,
  maxOutputTokens: { reply: 600, extraction: 1024 },
};

test("a profile adds its reasoning effort and thinking switch, and nothing when it has neither", () => {
  assert.deepEqual(profileExtras(LOCAL), {});
  assert.deepEqual(profileExtras({ ...LOCAL, reasoningEffort: "low" }), { reasoning_effort: "low" });
  assert.deepEqual(profileExtras({ ...LOCAL, thinking: true }), { chat_template_kwargs: { enable_thinking: true } });
});
