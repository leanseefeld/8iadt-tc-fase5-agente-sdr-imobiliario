# Spec 016 — The model, by configuration

**Format:** one page, like 009's and 015's, agreed with the developer on 07/10/2026. The examples are the
acceptance tests. Anything this page doesn't say isn't a requirement.

## What it is

The demo and the pitch run on a hosted model, Azure OpenAI `gpt-5.4-nano`, because the 4-bit local model is the
main source of the flakiness logged in `docs/cenarios-de-falha.md`. Development and tests stay on the local e4b.
ADR 16 and constitution principle VI already promise that the swap is configuration only:

- `PROVIDER_BASE_URL`, `PROVIDER_API_KEY` and `MODEL_ID`;
- plus `PROVIDER_AUTH_HEADER` for an endpoint that wants another auth header.

016 makes that promise true. A smoke call on 07/10 found the one thing that breaks it: Azure's gpt-5 family
refuses `max_tokens` ("use `max_completion_tokens`"), and the OpenAI-compatible provider sends `max_tokens`.

## What it covers

- **`max_completion_tokens`, always.**
  - The provider's existing body rewrite (`rewritingFetch` in `agent/provider.ts`) renames `max_tokens` to
    `max_completion_tokens`, OpenAI's current name for it.
  - The local oMLX honours it exactly like `max_tokens` (measured 07/10: a 5-token cap stopped at 5 tokens on
    both).
  - No new key, no new package, no second provider: principle VI holds as written.
- **Switching is `.env` only.** For Azure:

  ```
  PROVIDER_BASE_URL=https://<resource>.openai.azure.com/openai/v1
  PROVIDER_AUTH_HEADER=api-key
  PROVIDER_API_KEY=<the key>
  MODEL_ID=gpt-5.4-nano
  ```

  Then restart the app and the worker. The smoke call found nothing else the deployment needs: JSON mode works,
  and the model spends no reasoning tokens by default, so the output ceilings stay as they are.

  *Superseded on 08/10 by the profiles below: these four values became `MODEL_PROFILE=azure_nano` plus the two
  Azure secrets.*
- **A profile per model (amended 08/10/2026, developer; constitution VI 1.5.0, ADR 23).** gpt-6-luna reasons by
  default and spent the extraction's whole 300-token ceiling on it in 13 of 15 calls. What a model needs —
  reasoning effort, ceilings — is a property of the model, so it lives with the model:
  - one YAML file per model in `config/models/` (`omlx_gemma4_e4b`, `omlx_gemma4_e4b_thinking`,
    `omlx_gemma4_12b`, `azure_nano`, `azure_luna_low`), validated strictly by `core/model-profile.ts`;
  - `.env` holds `MODEL_PROFILE` and the secrets: `OMLX_API_KEY`, `AZURE_OPENAI_BASE_URL`,
    `AZURE_OPENAI_API_KEY`. A profile names the keys it reads, and may read only keys the schema declares;
  - `reasoning_effort` is sent through the same body rewrite, and stops at `low` (developer: above that,
    change the model);
  - two ceilings per profile, `reply` and `extraction`. The extraction's rises from 300 to 1024 for a model that
    does not reason (developer: 300 was too low), and to 4096 for one that does: `max_completion_tokens` counts
    reasoning and answer together, and the API offers no separate cap;
  - tests run on `omlx_gemma4_e4b` whatever `.env` names; `TEST_MODEL_PROFILE` picks another, on purpose.
- **Docs, in Portuguese:** the README says how to switch to Azure and back, and `.env.example` shows the Azure
  values next to the local ones.

## What it doesn't cover

- A different model per call.
- Fallback between providers (FR-014's written reply covers a dead one).
- Cost tracking.

## Already decided

- e4b stays the default for development and tests; the demo runs on a hosted model (ADR 16, developer 29/09).
- **The developer validates the hosted model.** Claude makes at most one or two calls to check the happy path,
  and never runs `npm run eval` against Azure: its budget is limited (developer, 07/10).

## Examples

1. **Local, unchanged.** With today's `.env`:
   - the deterministic suite passes;
   - the extraction, act and reply calls reach oMLX with `max_completion_tokens`.
2. **Azure, happy path.** With the four values above, one conversation turn gets a reply from `gpt-5.4-nano`,
   and its Langfuse trace shows that model.
3. **Back to local.** `MODEL_PROFILE=omlx_gemma4_e4b` and restart; the next turn runs on e4b.
4. **A profile that reasons.** Conversations 13 and 14 of the replay on `azure_luna_low` (08/10): every turn is
   answered, none with "tive um problema técnico"; extraction used 215–542 tokens, 43–371 of them reasoning.
5. **A broken profile stops the boot.** An unknown profile, a `reasoning_effort` above `low`, an unknown field, a
   key the profile names that is unset or undeclared: the process refuses to start and names the problem.

## Open questions

- **gpt-6-luna refuses tools with a reasoning effort** on `/v1/chat/completions` ("use /v1/responses or set
  reasoning_effort to 'none'"), so on `azure_luna_low` the action loop fails and nothing is searched or booked.
  The responses API would need another provider package, against principle VI. Waiting on the developer.

Answered on 07/10:
- the deployment is `gpt-5.4-nano`;
- the developer validates it.

Dropped by the developer's constraint and principle VI: a `MODEL_PROVIDER` key and the `@ai-sdk/azure`
package (the first draft of this page).
