# Spec 016 — The model, by configuration

**Format:** one page, like 009's and 015's, agreed with the developer on 07/10/2026. The examples are the
acceptance tests. Anything this page doesn't say isn't a requirement; a question it raises goes to *Open
questions*, never into the build on its own.

## What it is

Today the agent talks to one kind of endpoint: an OpenAI-compatible server, the local oMLX running gemma e4b. The
demo and the pitch will run on a hosted model (Azure OpenAI), because the 4-bit local model is the main source of
the flakiness logged in `docs/cenarios-de-falha.md`. 016 lets the model be chosen **by configuration**, with no
code change: the local model for development and tests, Azure for the demo. Switching is a change to `.env` and
a restart.

## What it covers

- **One new key, `MODEL_PROVIDER`**: `local` (the default, today's behaviour) or `azure`. The existing keys keep
  their meaning for both:
  - `PROVIDER_BASE_URL`: the endpoint (for Azure, the resource URL);
  - `PROVIDER_API_KEY`: the key;
  - `MODEL_ID`: the model (for Azure, the **deployment** name);
  - `MODEL_TIMEOUT_MS`, `MODEL_MAX_RETRIES` and `MODEL_MAX_OUTPUT_TOKENS`.
- **`azure` uses the AI SDK's own Azure provider** (`@ai-sdk/azure`, the version that matches `ai` 7). It knows
  the API version, the `api-key` header and the parameters reasoning models need. Every model call in the
  system — extraction, action, reply, summary, follow-up, recovery — goes through it, because they all go
  through `agent/provider.ts` today.
- **What stays the same on both:**
  - the extraction asks for JSON mode and parses the text, as today;
  - the reply streams;
  - the guards, the scripted model and the turn don't change.

  `MODEL_THINKING` and its `chat_template_kwargs` stay a local-only switch, ignored on Azure.
- **Boot fails loudly.** `MODEL_PROVIDER=azure` with a missing key or endpoint stops the process with a message
  naming the key, as the Environment Contract already does for the required keys.
- **The model is visible.** Langfuse traces carry the deployment name as the model, as they carry
  `gemma-4-e4b-…` today.
- **Docs, in Portuguese:**
  - the README says how to switch to Azure and back;
  - `.env.example` documents `MODEL_PROVIDER`, with the Environment Contract test in the same change;
  - the architecture doc says where the provider is chosen.

## What it doesn't cover

- Provider profiles in YAML (backlog 17).
- A different model per call (extraction vs reply).
- Fallback from one provider to another when one is down. FR-014's written reply covers a dead provider.
- Cost tracking.
- Any provider other than local and Azure.

## Already decided

- e4b stays the default for development and tests; 12B is only for diagnosing model vs code; the demo runs on a
  hosted model (developer, 29/09).
- An Azure OpenAI key with a USD 50 budget is available (developer).
- The deterministic suite never calls a model; `npm run eval` is the real-model check before a merge (015).

## Examples

1. **Nothing set.** Without `MODEL_PROVIDER`, everything behaves as today: the deterministic suite passes
   unchanged, and `npm run eval` on e4b gives the same results.
2. **Azure.**
   - **Setup:** `MODEL_PROVIDER=azure`, with the endpoint, the key and the deployment in `.env`. Restart the app
     and the worker.
   - **Check:** the developer's phone conversations and `npm run eval` run against Azure. Every failure is read
     and logged, with its owner, in `docs/cenarios-de-falha.md`.
3. **A missing key.** `MODEL_PROVIDER=azure` with no `PROVIDER_API_KEY` → the app doesn't start, and the message
   names `PROVIDER_API_KEY`.
4. **Back to local.** Remove `MODEL_PROVIDER` (or set `local`) and restart → the next conversation runs on e4b,
   and the Langfuse trace says so.

## Open questions

1. **Which Azure deployment** (model and version)? It decides whether reasoning parameters apply (gpt-5 family,
   o-series) or not (gpt-4.1, gpt-4o).
2. **How much of the USD 50 the validation may spend.** One `npm run eval` on a mini model is about USD 1 by
   estimate (≈300 calls of ≈4k tokens). Proposal: at most 3 eval runs and the replay overnight, and each one
   logged with its cost from Langfuse.
