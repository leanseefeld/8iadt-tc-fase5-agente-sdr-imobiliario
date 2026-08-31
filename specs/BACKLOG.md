# Backlog

Ordered slices of work. Each row names the challenge requirement, scenario or
grading criterion it satisfies — traceability lives here as a column rather than in
a separate matrix, so there is one index of the work instead of two that drift.

**Workflow per slice:** `/speckit-specify` → `/speckit-clarify` → `/speckit-plan` →
`/speckit-tasks` → `/speckit-analyze` → `/speckit-implement`. One feature branch
each.

Order is deliberate: the skeleton first so everything after it has ground to stand
on, then the conversation (which is the demo), then the broker surface, then the
follow-up loop that closes scenario 3.

---

## Core

| # | Slice | Scope | Requisito coberto |
|---|---|---|---|
| 1 | **Walking skeleton** | Next.js app, Dockerfile, `docker-compose.yml` (`app`, `worker`, `db`), health endpoints on both processes, env config, JSON structured logging, worker entrypoint. Resolves the oMLX networking question from the constraints register. | Arquitetura: organização, escalabilidade, componentização |
| 2 | **Domain model** | Drizzle schema — `leads`, `conversations`, `messages`, `properties`, `appointments`, `events`, `followup_jobs` — migrations, and a seed of ~100 coherent fictional properties plus brokers and users. | Integração com base simulada de imóveis |
| 3 | **Authentication** | Login screen, seeded users, broker-vs-manager scoping. *Resolves open decision 2.* | Diferencial: segurança |
| 4 | **Orchestrator** | Intent classification (purchase / rental / investment / undefined), deterministic slot machine per intent, provider factory, web `ChannelAdapter`, conversation persistence. **Authors the Langfuse span contract** — the observability document that was deliberately not written during setup. | Atendimento conversacional · qualificação de leads · continuidade da conversa · Cenários 1 e 2 |
| 5 | **Chat widget** | Public chat UI: message bubbles, artificial typing delay, opt-in banner on open, explicit fallback when the agent doesn't know, handoff state. | Conversa natural · fluxo humanizado · UX: interface, clareza, usabilidade |
| 6 | **Property search tool** | `searchProperties` tool over the seeded catalog, filter refinement across turns, inline property cards in the conversation. | Integração com base simulada de imóveis · qualidade das respostas |
| 7 | **Summary and scoring** | AI-generated broker summary and lead temperature score, computed asynchronously through the worker. *Resolves open decisions 1 and 5.* | Resumo inteligente |
| 8 | **Leads dashboard** | Metrics header (first-response time, qualification rate, scheduling rate, leads recovered by follow-up), filterable list with the AI preview line, lead drawer with summary → qualification data → transcript → timeline. | Dashboard mínimo de acompanhamento |
| 9 | **Handoff** | Assume conversation (pauses the agent), manual reply through the same thread, return to agent. Visible to the lead. | Priorização de leads · UX |
| 10 | **Scheduling** | Concrete slot proposals rather than open questions, confirmation in the chat, agenda screen grouped by day. | Agendamento de reuniões e visitas |
| 11 | **Follow-up sweep** | Worker job: eligibility window, attempt cap, growing intervals, `doNotContact` opt-out, context carried from the summary rather than the full transcript. **Do not cut this one** — it is a graded scenario and the strongest moment in the demo. | **Cenário 3 — follow-up automático** · memória conversacional |
| 12 | **Catalog screen** | Read-only property grid with basic filters. Proves the agent's suggestions are real records in the database, not hallucinations. | Credibilidade da demonstração · UX |

## Deferred — differentiators, only if time remains

| # | Slice | Scope | Requisito coberto |
|---|---|---|---|
| 13 | **Telegram `ChannelAdapter`** | Second channel implementation, proving the adapter seam. Needs long-polling or a tunnel locally — see the constraints register. | Diferencial: multicanal / pronto para WhatsApp |
| 14 | **Observability hardening** | Langfuse dashboards, cost per qualified lead, business metrics beyond the technical trace. | Diferencial: observabilidade |
| 15 | **RAG** | pgvector in the existing Postgres over property descriptions and commercial policy; hybrid search combining structured filters with semantic matching. | Diferencial: RAG |
| 16 | **Multi-agent routing** | Router in front of the orchestrator, with a specialized investment agent. | Diferencial: multiagentes |

---

## Requirements not yet mapped

Tracked so nothing from the challenge statement is silently dropped:

| Requisito | Onde é coberto |
|---|---|
| Identificar intenção de compra, aluguel ou investimento | Item 4 |
| Coletar informações relevantes | Item 4 (slot filling) |
| Realizar follow-up automático | Item 11 |
| Gerar resumos para corretores | Item 7 |
| Conversa humanizada | Items 4 e 5 combinados |
| Deploy em cloud | Não implementado. Justificado pela paridade de contêiner — ver [`../docs/arquitetura/visao-geral.md`](../docs/arquitetura/visao-geral.md) §6 |
| Voice AI | Fora de escopo. Ponto de encaixe previsto: middleware de STT no `ChannelAdapter` |
| Integração com CRM | Fora de escopo. Ponto de encaixe previsto: consumidor do outbox `events` |

The last three are deliberate omissions with a named integration point, not
oversights. That distinction is worth making explicitly in the pitch.
