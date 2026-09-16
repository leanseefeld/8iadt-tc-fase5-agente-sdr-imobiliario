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

**Status** is `✅ Done` once the slice is merged to `main` with its spec, plan and
tasks complete, and `—` otherwise. A slice in progress carries its branch name, so
this table answers "where are we" without anyone reading git.

---

## Core

Items 2 to 12 of the original list were regrouped into five specs on 2026-09-05
(ADR 17). The original item numbers survive in the *Scope* column so the
traceability to the challenge statement is unchanged.

| # | Status | Slice | Scope | Requisito coberto |
|---|---|---|---|---|
| 1 | ✅ Done | **Walking skeleton** | Next.js app, Dockerfile, `docker-compose.yml` (`app`, `worker`, `db`), health endpoints on both processes, env config, JSON structured logging, worker entrypoint. Resolved the oMLX networking question — see [`001-walking-skeleton`](001-walking-skeleton/spec.md). | Arquitetura: organização, escalabilidade, componentização |
| 002 | ✅ Done | **Data model, seed and catalog** | *(items 2 + 12)* Drizzle schema per [`modelo-de-dados.md`](../docs/arquitetura/modelo-de-dados.md) with `agencyId` on every table, migrations, seed of 100 coherent São Paulo properties plus agency, users and three demo leads, and the read-only catalog screen with basic filters. | Integração com base simulada de imóveis · credibilidade da demonstração |
| 003 | ✅ Done | **Authentication and app shell** | *(item 3)* Login screen, signed session cookie, seeded users, broker-vs-manager scoping, the authenticated layout with navigation (Leads · Agenda · Catálogo) that later specs fill. *Resolves open decision 2.* | Diferencial: segurança · UX |
| 004 | ✅ Done | **Conversation** | *(items 4 + 5 + 6)* Orchestrator with structured extraction under the deterministic slot machine, intent capture, provider factory, web `ChannelAdapter`, conversation persistence, `searchProperties` tool with inline property cards, public chat widget (streaming, typing delay, opt-in banner, fallback, handoff badge), Langfuse span contract and the observability Compose profile. | Atendimento conversacional · qualificação · continuidade · Cenários 1 e 2 · integração com base de imóveis · UX |
| 005 | — | **Broker surface** | *(items 7 + 8 + 9)* Deterministic score, async summary and preview line via the events outbox, leads dashboard with metrics header and filters, lead drawer (summary → qualification → transcript → timeline), handoff: assume, reply manually, return to agent. *Resolves open decisions 1 and 5.* | Resumo inteligente · dashboard mínimo · priorização de leads |
| 006 | — | **Scheduling and follow-up** | *(items 10 + 11)* Concrete slot proposals, confirmation in chat, agenda screen grouped by day, and the worker follow-up sweep: eligibility window, attempt cap, growing intervals, `doNotContact`, context from the summary, demo trigger button. **Do not cut this one** — it is a graded scenario and the strongest moment in the demo. | Agendamento · **Cenário 3 — follow-up automático** · memória conversacional |

## Deferred — differentiators, only if time remains

| # | Status | Slice | Scope | Requisito coberto |
|---|---|---|---|---|
| 13 | — | **Telegram `ChannelAdapter`** | Second channel implementation, proving the adapter seam. Needs long-polling or a tunnel locally — see the constraints register. | Diferencial: multicanal / pronto para WhatsApp |
| 14 | — | **Observability hardening** | Langfuse dashboards, cost per qualified lead, business metrics beyond the technical trace. | Diferencial: observabilidade |
| 15 | — | **RAG** | pgvector in the existing Postgres over property descriptions and commercial policy; hybrid search combining structured filters with semantic matching. | Diferencial: RAG |
| 16 | — | **Multi-agent routing** | Router in front of the orchestrator, with a specialized investment agent. | Diferencial: multiagentes |

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
