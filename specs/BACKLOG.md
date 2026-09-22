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

**Numbers are identity, not order.** Spec 007 was opened after 006 was written but
runs *before* it: 006 was blocked on pending decision 6, resolved on 22/09/2026 by
[ADR 22](../docs/arquitetura/adr/decisoes.md#22-revisable-qualification-state-and-actions-as-tool-calls).
The real order from here is **007 → 006 → 008 → 009**.

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
| 005 | ✅ Done | **Broker surface** | *(items 7 + 8 + 9)* Async summary and preview line via the events outbox, leads dashboard with metrics header, filters and live SSE updates, lead drawer (summary → qualification → transcript → timeline), handoff: assume, reply manually, return, move the stage, reassign. **O score saiu desta fatia**: o ADR 20 o reabriu e ele fica com a spec que o implementar (pendência 8). | Resumo inteligente · dashboard mínimo · priorização de leads |
| 006 | — | **Scheduling and follow-up** | *(items 10 + 11)* Concrete slot proposals, confirmation in chat, agenda screen grouped by day, and the worker follow-up sweep: eligibility window, attempt cap, growing intervals, `doNotContact`, context from the summary, demo trigger button. **Do not cut this one** — it is a graded scenario and the strongest moment in the demo. | Agendamento · **Cenário 3 — follow-up automático** · memória conversacional |
| 007 | — | **Revisable orchestration** | *(resolves pending decision 6, [ADR 22](../docs/arquitetura/adr/decisoes.md#22-revisable-qualification-state-and-actions-as-tool-calls))* Every criterion revisable, `intent` included; a revision counted as learning rather than as non-comprehension; actions as model tool calls with a round trip before the reply, taking `searchProperties` (re-runnable when a criterion changes) and leaving `proposeMeeting`/`bookMeeting` inert for 006; the meeting offer derived from Postgres instead of re-firing every turn; every step of the loop its own Langfuse span. **Runs before 006, which it unblocks.** | Atendimento conversacional · continuidade · observabilidade |
| 008 | — | **Uncapped lead score** | *(resolves pending decision 8, implements [ADR 20](../docs/arquitetura/adr/decisoes.md#20-the-lead-score-is-uncapped-and-compounding))* Exact weights, how budget carries the score past 100, re-derived temperature bands, the rental floor of 50, accept-or-reject the investor interest signal, recomputed seed and a rewritten `tests/score.test.ts`. **After 006** — "booking raises the score" needs `appointments` to exist first. | Priorização de leads · dashboard |
| 009 | — | **Reschedule and cancel** | Rescheduling or cancelling a booked meeting from the conversation itself — *"pode ser quinta em vez de quarta?"* — as tool calls on 007's loop over 006's calendar. Scoped out of 006 deliberately; brought into the MVP on 22/09/2026. Needs both predecessors. | Agendamento · UX · continuidade |

## Deferred — differentiators, only if time remains

| # | Status | Slice | Scope | Requisito coberto |
|---|---|---|---|---|
| 13 | — | **Telegram `ChannelAdapter`** | Second channel implementation, proving the adapter seam. Needs long-polling or a tunnel locally — see the constraints register. | Diferencial: multicanal / pronto para WhatsApp |
| 14 | — | **Observability hardening** | Langfuse dashboards, cost per qualified lead, business metrics beyond the technical trace. | Diferencial: observabilidade |
| 15 | — | **RAG** | pgvector in the existing Postgres over property descriptions and commercial policy; hybrid search combining structured filters with semantic matching. | Diferencial: RAG |
| 16 | — | **Multi-agent routing** | Router in front of the orchestrator, with a specialized investment agent. | Diferencial: multiagentes |
| 19 | — | **O agente pode escolher não responder** | Hoje todo turno produz uma resposta: a máquina sempre tem uma próxima pergunta e `phrase()` sempre fala. Depois que um corretor devolve a conversa, o certo muitas vezes é ficar quieto — o lead já foi atendido, e um "te ajudo com algo a mais?" é ruído. A solução do MVP é a frase curta de reentrada; o que fica para explorar é o turno que termina **sem mensagem**, com a conversa esperando o lead. Mexe em `commitTurn` (um turno sem `messages` row), no follow-up (quem reabre?) e na garantia de que silêncio não vira conversa morta. | UX · pós-MVP |
| 20 | — | **O corretor edita os slots pela ficha** | A extração lê só o que o lead escreveu (decisão de 21/09/2026, o caminho que não muda nada). Então o que o corretor apura por telefone ou por escrito não entra no estado: ele sabe que o orçamento subiu para 800 mil e o agente continua com 700. A ideia é tornar a tabela de QUALIFICAÇÃO editável, gravando quem mudou o quê nos `events`, com o agente sempre lendo a versão mais recente. Resolve também o caso "o corretor já perguntou isso" sem afrouxar o gate de evidência. | Diferencial: colaboração humano-agente |
| 21 | — | **Estado de visita verificado por código na devolução** | Quando a conversa volta do corretor, ninguém confere o que mudou no mundo real. Se ele marcou ou desmarcou uma visita, o agente só sabe pelo texto. Com a spec 006 no ar existe `appointments`: dá para reconciliar o estado no momento da devolução — visita confirmada vira `scheduled`, cancelada volta o follow-up — em vez de confiar na leitura do transcript. | Confiabilidade · depende da 006 |
| 18 | — | **Guarda de valores: `unbackedFigure` recusa a própria resposta** | `tests/integration/scenario-purchase.test.ts` falha de forma intermitente (também com `--test-concurrency=1`): o lead disse *"Até uns 700 mil"*, o slot guarda `700000`, e quando o modelo escreve a mesma cifra de outro jeito a guarda lê `700`, não acha na lista permitida e descarta uma frase verdadeira — `{"guard":"unbackedFigure","reason":"no search returned the amount 700"}`. **A solução provavelmente é tirar regra, não acrescentar**: comparar cifras por valor em vez de por grafia, ou simplesmente afrouxar a lista fixa. Os 17 casos de `tests/reply-guards.test.ts` seguram o resto. Pode já ter sido resolvido por outro caminho quando chegarmos aqui — a spec 007 mexe nesta área. | Confiabilidade do gate · Cenário 1 |
| 17 | — | **Perfil de provedor em YAML** | Um arquivo por provedor (ou por `provider+model`) declarando como aquele modelo se comporta: **método de extração JSON** (`json_schema` nativo · modo JSON · texto + parser), suporte a tool calling, thinking, tetos de token, cabeçalho de autenticação. `agent/provider.ts` lê o perfil em vez de o código decidir. **Evidência que originou a ideia:** o `generateObject` falha validação em 2 de 3 conversas no `gemma-4-e4b-it-OptiQ-4bit` e a spec 005 teve de pedir JSON em texto e parsear — a mesma escolha que a 004 já tinha feito na extração. O GPT-5 da demonstração faria o contrário. Hoje essa diferença está espalhada por call sites; um perfil a torna configuração, que é o que o ADR 16 e o princípio VI prometem. | Diferencial: portabilidade de provedor · ADR 16 |
| 22 | — | **Resolução de localização em texto livre** | Uma ferramenta (ou subagente) que o orquestrador consulta para transformar o que o lead escreve numa localização utilizável: *"zona leste"* → São Paulo, *"Itacorubi"* → Florianópolis, e assim por diante para bairros de qualquer cidade do país. As fontes a avaliar: o próprio catálogo (`region` já é coluna), um serviço externo de geocoding, ou RAG. **Desbloqueado pela spec 007**: a pendência 6 foi resolvida em 22/09/2026 e `neighborhoods` passa a ser revisável, então uma localização melhor resolvida deixa de ser descartada pela contabilidade do turno. Ideia levantada em 21/09/2026; ainda não validada. | Diferencial: cobertura geográfica · UX |
| 23 | — | **Tela de follow-ups agendados** | Uma tela onde o corretor vê os follow-ups que estão na fila: quem é o lead, o resumo da conversa e quando o próximo disparo acontece — só isso, nada de transcript. Sobre cada linha ele pode: **cancelar** (só o próximo, ou todos os daquele lead), ou **disparar agora**. No disparo imediato ele pode deixar o agente compor a mensagem *ou escrever a dele*. A mensagem escrita pelo corretor **não é armazenada como rascunho**: serve para o envio e passa a existir apenas como mensagem no histórico da conversa. Em aberto para quando a spec for escrita: **em que momento a mensagem de follow-up é gerada** (no agendamento ou no disparo), e se uma mensagem nova enviada pelo corretor **reinicia o agendamento** do lead. **Depende da spec 006**, que é quem cria a varredura de follow-up, a janela de elegibilidade, o teto de tentativas e os intervalos crescentes. Ideia levantada em 21/09/2026. | Diferencial: controle humano sobre o follow-up · UX do corretor |
| 24 | — | **Filtrar leads pelo que eles querem** | O dashboard filtra hoje por *estado da conversa* — os cinco chips de `LEAD_FILTERS` (`todos`, `ao_vivo`, `aguardando`, `visita_marcada`, `sem_resposta`) em [`FilterChips.tsx`](../src/app/(app)/leads/_components/FilterChips.tsx). Falta filtrar pelo **interesse**: região, número de quartos, faixa de preço e intenção (compra · aluguel · investimento), com **múltiplas opções selecionáveis** em cada um. Ou seja, filtrar pelos slots de qualificação, não só pelo estágio. Estado de lista mora todo na query string (FR-020/FR-023), então a seleção múltipla tem de caber nesse contrato. Ideia levantada em 21/09/2026. | Diferencial: priorização de leads · UX do corretor |
| 25 | — | **Servidor MCP para corretores e gestores** | Expor um servidor MCP sobre o sistema, para o corretor e o gestor operarem pelo Claude — que é também a demonstração da ideia. **Leitura:** consultar leads (com os filtros do item 24), próximos follow-ups, agenda, e o resumo de uma conversa. **Escrita, deliberadamente estreita:** definir a disponibilidade do corretor e **disparar um follow-up** — é a única forma de o MCP fazer uma mensagem chegar ao lead. *Responder ao lead pelo MCP fica proibido*, fora desse caso. **A avaliar quando a spec for escrita:** expor também a consulta completa ao catálogo, as visitas (ou as últimas visualizações) de um imóvel, e com isso a correlação entre um imóvel e os leads que demonstraram interesse nele num período — a correlação em si fica com o Claude, o sistema só precisa expor as ferramentas. **Autenticação é trabalho à parte** e provavelmente o maior custo do item: hoje a sessão é um cookie assinado com escopo de corretor/gestor (spec 003), e um cliente MCP não tem cookie. Ideia levantada em 21/09/2026. | Diferencial: integração / superfície de agente · demonstração |

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
