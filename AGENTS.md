# AGENTS.md

Brief for coding agents working in this repository. Read this before touching
anything. The authoritative rules live in `.specify/memory/constitution.md`; this
file carries what you must not get wrong even if you never open another file.

## What this is

A POC of an **AI SDR agent for the Brazilian real estate market** (FIAP Fase 5 Tech
Challenge). A lead chats in Portuguese; the agent qualifies them through a
deterministic slot-filling flow, searches a seeded property catalog, proposes a
viewing, summarizes the conversation for a broker, and follows up automatically if
the lead goes quiet.

Solo developer. Specs are **offered, not enforced**: before changing production
code, offer to write a short one-page spec in `specs/`, then follow the
developer's choice (constitution 1.6.0, ADR 24).

## Document authority

| Location | Status |
|---|---|
| `.specify/memory/constitution.md` | Normative, highest |
| `docs/` | Normative — the real architecture |
| `specs/` | Normative for its feature |
| `reference/` | **NON-NORMATIVE — ideation only** |

`reference/` describes a Python/FastAPI design that **will not be built**. Use it
for product intent and user journeys. Never cite it as a technical requirement.
Unresolved questions live in `docs/decisoes-pendentes.md` — defer to that register
instead of inventing an answer.

## Non-negotiables

- **English** code, identifiers, comments, commits, specs. **pt-BR** README and
  `docs/`. **pt-BR only** for UI copy and agent conversation — no i18n framework,
  no locale keys.
- **UI never imports `db/` or Drizzle.** Everything goes through `services/`.
- **`domain/` imports nothing.** Pure entities and rules, no I/O.
- **No repository layer.** Services own their Drizzle queries.
- **The slot machine decides what to ask next, not the model.** One question per
  message. Every criterion is revisable, `intent` included, and re-asking a
  filled slot is discouraged in the prompt, not forbidden in code (ADR 22).
- **Only `src/agent/provider.ts` imports a provider SDK.** Swapping oMLX for a
  hosted endpoint is one line, `MODEL_PROFILE` in `.env`, choosing a YAML profile
  in `config/models/` (ADR 23).
- **Every LLM call is traced to Langfuse, fire-and-forget.** Telemetry never blocks
  or fails a reply.
- **`docker compose up` is the only supported way to run this.** Host-only steps
  require an entry in `docs/arquitetura/restricoes-de-implantacao.md`.
- **No Redis.** Async work is `followup_jobs` + `events` in Postgres, polled with
  `FOR UPDATE SKIP LOCKED`.
- **UI changes start from the user, not the code.** Before touching a screen, state
  who is there, what they came to do and the smoothest interaction for it; then
  build that, with a clear information hierarchy (summary before detail, one
  primary action) and a visual hierarchy that shows it. Processing, lost
  connections and empty states always give feedback. Constitution principle X.
- **The turn map is updated in the same commit as the code it describes.**
  [`docs/arquitetura/turno-do-agente.md`](docs/arquitetura/turno-do-agente.md)
  maps what the model reads, what code decides, which tools the model may call
  and what enables each of them per turn, plus the state kept between turns. Any
  change to one of those — a node of the turn pipeline in `agent/turn/`, an
  extraction fact, a tool or its gating, `task()`'s precedence, a written reply,
  an appointment or follow-up state — updates the diagrams and the table in that
  same commit. A step marked *planejado* loses the mark when it's built. Re-render
  the Mermaid before committing: a diagram that doesn't parse counts as not updated.

## Structure

```
src/
├── app/              # App Router — routes only, thin
│   ├── (public)/chat/          # lead-facing widget
│   ├── (app)/leads/            # dashboard + lead drawer
│   ├── (app)/agenda/
│   ├── (app)/catalogo/
│   ├── login/
│   └── api/{webhooks/[channel],chat,health}/
├── channels/         # ChannelAdapter interface + web adapter
├── agent/            # turn/ (the turn as typed nodes) · prompts · tools · provider
├── domain/           # pure entities and rules, no I/O
├── services/         # use cases + their Drizzle queries — the ONLY entry for UI and API
├── db/               # schema · migrations · seed
├── jobs/             # sweep consumers: followup · summarize · unanswered turns
├── worker/           # worker entrypoint (same image, different command)
└── core/             # config · logging · langfuse · auth · security
```

Dependency rule: `app → services → db`, `agent → services`, `domain → nothing`.

## Glossary (PT → EN)

The docs are in Portuguese and the code is in English. Translate through this
table; never transliterate, never leave Portuguese in an identifier.

| Portuguese | English identifier |
|---|---|
| corretor | `broker` |
| imóvel / imóveis | `property` / `properties` |
| lead | `lead` |
| visita | `viewing` |
| agendamento | `appointment` |
| qualificação | `qualification` |
| faixa de preço | `priceRange` |
| quartos | `bedrooms` |
| bairro | `neighborhood` |
| intenção | `intent` |
| compra / aluguel / investimento | `purchase` / `rental` / `investment` |
| conversa | `conversation` |
| mensagem | `message` |
| resumo | `summary` |
| urgência | `urgency` |
| status / etapa | `status` |
| gerente comercial | `salesManager` |
| acompanhamento | `followUp` |
| não perturbe | `doNotContact` |
| consentimento | `consent` |
| canal | `channel` |

## Workflow

Before a change to production code, **offer** a short spec — one page of prose in
`specs/NNN-name/spec.md`: what it covers, what it doesn't, how it will be checked —
and follow the developer's answer. Don't refuse or stall without one.

History: specs 001–007 used the full Spec Kit flow (`/speckit-specify` →
`/speckit-clarify` → `/speckit-plan` → `/speckit-tasks` → `/speckit-analyze` →
`/speckit-implement`); from 009 on, short prose specs replaced it. The skills are still
installed if the developer asks for them.

Still required: the deterministic suite (`npm run test:integration`) passes before
a merge, and the turn map is updated with the turn's code. One branch per change.
`specs/BACKLOG.md` holds the slices and which challenge requirement each satisfies.
