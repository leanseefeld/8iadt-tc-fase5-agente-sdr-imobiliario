# Modelo de dados

Documento normativo. Define o esquema compartilhado pelas specs 002 a 006, para que
cinco specs escritas em paralelo partam do mesmo chão. A spec 002 o materializa em
Drizzle; as demais o consomem. Alterações passam por aqui primeiro.

Identificadores em inglês, conforme o glossário de [`AGENTS.md`](../../AGENTS.md).
Chaves primárias são `uuid` geradas no banco. Toda tabela de negócio carrega
`agencyId` (ADR 10) e `createdAt`; as mutáveis carregam `updatedAt`.

---

## 1. Tabelas

### agencies

| Coluna | Tipo | Notas |
|---|---|---|
| id | uuid | |
| name | text | "Imobiliária Demo" na seed |
| slug | text, único | usado na rota pública do widget: `/chat/[agencySlug]` |

### users

| Coluna | Tipo | Notas |
|---|---|---|
| id, agencyId | uuid | |
| name, email | text | `email` único por agência |
| passwordHash | text | |
| role | enum `broker` · `salesManager` | |
| specializations | jsonb `intent[]` | intenções que o corretor atende (`purchase`, `rental`, `investment`); vazio no gerente |
| availability | jsonb | disponibilidade por dia da semana: `{ mon: { enabled, start, end }, … }`; padrão seg–sex 09:00–18:00 na seed; editável na agenda |

### leads

| Coluna | Tipo | Notas |
|---|---|---|
| id, agencyId | uuid | |
| name, phone, email | text, nulos | pedidos tarde no roteiro; PII mascarada em logs e traces |
| channel | enum `web` · `telegram` | |
| externalId | text | identidade no canal (sessão do widget); único por agência + canal |
| intent | enum `purchase` · `rental` · `investment` · `undefined` | |
| status | enum `new` · `qualifying` · `qualified` · `scheduled` · `visited` · `won` · `lost` | **etapa do funil**, só avança; o corretor pode marcar `won`/`lost` de qualquer etapa. Ver §7 |
| score | int, padrão 0 | ver §3 |
| assignedBrokerId | uuid, nulo → users | |
| consentAt | timestamptz, nulo | opt-in declarado na abertura |
| doNotContact | bool, padrão false | honrado por toda saída |
| createdAt, updatedAt | timestamptz | |

A **temperatura** (`cold` · `warm` · `hot`) não é coluna: deriva do score em
`domain/`.

### conversations

| Coluna | Tipo | Notas |
|---|---|---|
| id, agencyId, leadId | uuid | uma conversa ativa por lead |
| channel | enum | igual ao lead |
| status | enum `active` · `paused` · `closed` | **estado da conversa**: `paused` = um humano precisa responder; `closed` = encerrada (won/lost/opt-out) |
| heldByUserId | uuid, nulo → users | quem assumiu; nulo com `paused` = "Aguardando corretor" |
| followupState | enum `none` · `pending` · `exhausted` | **estado do follow-up**; `exhausted` = tentativas esgotadas sem resposta |
| processingSince | timestamptz, nulo | turno em andamento; garante um turno por conversa e permite coalescer mensagens |
| slots | jsonb | estado da qualificação, ver §2 |
| summary | text, nulo | resumo gerado pelo worker |
| previewLine | text, nulo | frase-chave para a lista de leads |
| summaryUpdatedAt | timestamptz, nulo | |
| lastLeadMessageAt, lastAgentMessageAt | timestamptz, nulos | base da elegibilidade de follow-up |
| fallbackStreak | int, padrão 0 | respostas seguidas sem entendimento; 2 dispara handoff |
| followupAttempts | int, padrão 0 | |
| createdAt, updatedAt | timestamptz | |

### messages

| Coluna | Tipo | Notas |
|---|---|---|
| id, conversationId | uuid | |
| role | enum `lead` · `agent` · `broker` · `system` | |
| content | text | |
| repliesToMessageId | uuid, nulo | mensagens `agent`: a última mensagem do lead que o turno leu. Se houver mensagens do lead posteriores, o widget cita a primeira linha dela no topo do balão |
| metadata | jsonb | chaves reservadas: `clientMessageId` (idempotência, 004), `guard` (guarda de código que reescreveu a resposta, 004), `propertyIds` exibidos (004), `toolCalls` (004), `isFollowUp` (006), `appointmentId` (006). Cada spec só escreve as suas. |
| createdAt | timestamptz | índice `(conversationId, createdAt)` |

### properties

| Coluna | Tipo | Notas |
|---|---|---|
| id, agencyId | uuid | |
| code | text | referência humana, ex. `MOE-0042`; única por agência |
| title | text | |
| type | enum `apartment` · `house` · `commercial` · `land` | |
| transaction | enum `sale` · `rent` | |
| price | int (BRL, inteiro) | venda: valor; aluguel: mensal |
| condoFee | int, nulo | |
| areaM2, bedrooms, bathrooms, parkingSpots | int | |
| neighborhood, city | text | |
| region | text | `zona sul`, `zona oeste`, `centro`… — o que o lead fala |
| description | text | 2–4 frases, pt-BR |
| features | jsonb `string[]` | `varanda`, `home office`, `pet friendly`… |
| estimatedRent | int, nulo | só em `sale`; permite yield para o roteiro de investimento |
| imageUrl | text | placeholder determinístico por `code` |
| isActive | bool | |

### appointments

| Coluna | Tipo | Notas |
|---|---|---|
| id, agencyId, leadId, conversationId | uuid | |
| brokerId | uuid → users | |
| propertyId | uuid, nulo | nulo em `call` |
| scheduledAt | timestamptz | |
| type | enum `viewing` · `call` | |
| status | enum `proposed` · `confirmed` · `cancelled` · `done` | |

### events — append-only, também outbox

| Coluna | Tipo | Notas |
|---|---|---|
| id, agencyId | uuid | |
| leadId, conversationId | uuid, nulos | |
| type | text | catálogo em §4 |
| actorType | enum `lead` · `user` · `agent` · `worker` · `system` | quem fez |
| actorUserId | uuid, nulo → users | preenchido quando `actorType = user` |
| traceId | text, nulo | id do trace no Langfuse quando `agent`/`worker` chamou o modelo; a linha do tempo linka para ele |
| payload | jsonb | |
| createdAt | timestamptz | |
| processedAt | timestamptz, nulo | **outbox**: nulo até um consumidor do worker tratar |

### followup_jobs

| Coluna | Tipo | Notas |
|---|---|---|
| id, agencyId, conversationId | uuid | |
| attempt | int | 1..N |
| scheduledFor | timestamptz | |
| status | enum `pending` · `running` · `sent` · `cancelled` · `failed` | |
| lockedAt | timestamptz, nulo | |
| sentAt | timestamptz, nulo | |

Consulta do worker: `select … where status = 'pending' and scheduledFor <= now()
for update skip locked`.

---

## 2. Slots — o estado da qualificação

Um objeto JSON validado por Zod em `domain/`. O roteiro por intenção define a
**ordem** das perguntas; a slot machine pergunta o primeiro slot vazio dessa ordem
e nunca pergunta um preenchido.

| Intenção | Ordem dos slots |
|---|---|
| `purchase` · `rental` | `priceMax` → `bedrooms` → `neighborhoods` → `urgency` → `name` → `contact` |
| `investment` | `investorProfile` → `ticket` → `returnExpectation` → `name` → `contact` |
| `undefined` | apenas a captura de intenção; nada mais é perguntado |

| Slot | Tipo | Notas |
|---|---|---|
| priceMax | number (BRL) | "até 700 mil" → 700000 |
| bedrooms | int | mínimo desejado |
| neighborhoods | string[] | bairros ou região; vazio = "aberto a sugestões" é válido |
| urgency | `immediate` · `soon` · `exploring` | ≤ 1 mês · ≤ 3 meses · sem prazo |
| investorProfile | `firstTime` · `experienced` | |
| ticket | number (BRL) | |
| returnExpectation | `income` · `appreciation` · `both` · `undecided` | |
| name | string | |
| contact | string | telefone ou e-mail |

`intent` vive no lead, não nos slots, mas é o primeiro slot lógico: enquanto for
`undefined`, a única pergunta é sobre a intenção.

---

## 3. Score (ADR 11 — **superado pelo ADR 20**)

> **Atenção, quem for implementar:** a tabela abaixo e o teto de 100 **não valem
> mais**. O [ADR 20](adr/decisoes.md#20-the-lead-score-is-uncapped-and-compounding)
> (20/09/2026) tornou o score **sem teto e cumulativo**, com 100 calibrado como
> "roteiro de compra completo com urgência imediata" e pontuação maior conforme o
> orçamento. As faixas de temperatura também serão refeitas. Os pesos exatos ficam
> com a spec que implementar o ADR 20; até lá esta tabela descreve só o que o
> código faz hoje.

Função pura `scoreLead(intent, slots)` em `domain/`, recalculada a cada turno.

| Componente | Pontos |
|---|---|
| Intenção identificada (≠ `undefined`) | 10 |
| Cada slot do roteiro preenchido, exceto `name`/`contact` | 15 (compra/aluguel: 4 slots = 60; investimento: 3 slots = 45) |
| `contact` preenchido | 15 |
| `urgency = immediate` ou `returnExpectation ≠ undecided` com `ticket ≥ 1 000 000` | +15 |
| `urgency = soon` | +5 |

Teto 100. Faixas: **frio < 40**, **morno 40–69**, **quente ≥ 70**.

- `qualified` = todos os slots do roteiro preenchidos (exceto `name`/`contact`).
- Quente **e** `contact` preenchido = hora de **propor a reunião** (006). Não é
  handoff: o agente segue no comando. Handoff (conversa `paused`) só quando o lead
  pede uma pessoa, após dois fallbacks seguidos, ou quando um corretor assume
  pelo painel.

---

## 4. Catálogo de eventos

| type | payload | emitido por |
|---|---|---|
| `lead.created` | `{ channel }` | 004 |
| `lead.consented` | `{}` | 004 |
| `intent.identified` | `{ intent }` | 004 |
| `slot.filled` | `{ slot, value }` (PII mascarada) | 004 |
| `conversation.turn` | `{ messageId }` | 004 — consumido pelo resumidor (005) |
| `lead.qualified` | `{ score }` | 005 |
| `properties.suggested` | `{ propertyIds }` | 004 |
| `handoff.requested` | `{ reason: 'asked' · 'fallback' }` — sem `score`: quente com contato propõe reunião (ADR 19) | 004 (agente) · 005 (regra `shouldHandoff`) |
| `conversation.assumed` / `conversation.returned` | `{ userId }` | 005 |
| `summary.updated` | `{}` | 005 |
| `appointment.proposed` / `appointment.confirmed` | `{ appointmentId }` | 006 |
| `followup.scheduled` / `followup.sent` | `{ attempt }` | 006 |
| `followup.recovered` | `{ attempt }` — lead respondeu após follow-up | 006 |
| `lead.opted_out` | `{}` | 004 |
| `lead.status_changed` | `{ from, to }` | 004 (agente até `scheduled`) · 005 (corretor) · 006 (visita) |
| `lead.reassigned` | `{ fromBrokerId, toBrokerId }` | 005 |
| `appointment.done` / `appointment.cancelled` | `{ appointmentId }` | 006 |

As métricas do painel derivam daqui: tempo de primeira resposta
(`lead.created` → primeira mensagem `agent`), taxa de qualificação
(`lead.qualified` / `lead.created`), taxa de agendamento
(`appointment.confirmed` / `lead.created`), recuperados (`followup.recovered`).

---

## 5. Seed

Uma agência; três usuários (`ana@demo.com.br` corretora, `bruno@demo.com.br`
corretor, `carla@demo.com.br` gerente; senha `demo1234`); **100 imóveis** em São
Paulo distribuídos por zona sul (Moema, Vila Mariana, Brooklin, Campo Belo,
Saúde, Itaim Bibi), zona oeste (Pinheiros, Vila Madalena, Perdizes, Butantã),
centro, zona norte (Santana) e zona leste (Tatuapé), ~70 venda / ~30 aluguel, ~15 comerciais, preços coerentes com o
bairro; e três leads de demonstração em estados distintos (quente com reunião
marcada, morno em qualificação, frio parado há dois dias aguardando follow-up).

---

## 6. Contratos entre specs

Assinaturas que mais de uma spec toca. Fixadas aqui em 06/09/2026 para que a
primeira a implementar não decida sozinha.

| Contrato | Forma | Dono | Consome |
|---|---|---|---|
| Registro de consumidores do worker (`src/jobs/consumers.ts`) | `type SweepConsumer = { name: string; run(ctx: { db: Database; now: Date; log: Logger }): Promise<void> }`; array exportado, iterado pelo loop do worker com try/catch por consumidor | 005 | 006 |
| Tools de agendamento no registro do agente (`src/agent/tools/index.ts`) | `proposeMeeting()` e `bookMeeting({ optionIndex } \| { scheduledAt })`, declaradas como stubs em `scheduling.stub.ts` | 004 (stub) | 006 (implementa) |
| Busca de imóveis (`services/properties.searchProperties(agencyId, criteria)`) | até 3, ranqueados; `criteria = { transaction, priceMax?, bedrooms?, neighborhoods? }` | 002 | 004 |
| Escopo por papel (`scopeForUser(session)`) | `{ agencyId, defaultOwnLeadsOnly }` — todos veem a agência; `defaultOwnLeadsOnly` é `true` para corretor e liga o filtro "Meus leads" por padrão | 003 | 005, 006 |
| Três eixos de estado | ver §7; visita confirmada marca `scheduled` independentemente do estado da conversa | 005 | 004, 006 |

---

## 7. Três eixos de estado (decidido em 08/09/2026, ADR 19)

Um lead nunca é descrito por um único status. São três eixos independentes:

| Eixo | Coluna | Valores | Quem muda |
|---|---|---|---|
| Etapa do funil | `leads.status` | `new → qualifying → qualified → scheduled → visited → won \| lost` | agente (até `scheduled`), worker (nunca), corretor (`visited`, `won`, `lost`, de qualquer etapa) |
| Estado da conversa | `conversations.status` + `heldByUserId` | `active` · `paused` (com ou sem `heldByUserId`) · `closed` | agente (`paused` sem holder = pediu corretor), corretor (assumir/devolver/encerrar) |
| Follow-up | `conversations.followupState` | `none` · `pending` · `exhausted` | worker e o turno do agente |

Leituras derivadas para o painel:

| Rótulo | Regra |
|---|---|
| Agente respondendo | `active` e último turno do agente |
| *Nome* no comando | `paused` com `heldByUserId` |
| Aguardando corretor | `paused` sem `heldByUserId` |
| Encerrada | `closed` |
| Ao vivo | `lastLeadMessageAt` há menos de `DASHBOARD_LIVE_WINDOW_MINUTES` |
| Sem resposta | `followupState = exhausted` |
| Visita *dia hora* | `status = scheduled` com appointment confirmado futuro |

O caminho feliz fica com o agente: qualifica, busca, propõe horários, confirma. O
corretor assume quando quer, de qualquer etapa. `handoff` e `unresponsive`
deixaram de existir como etapas.

### Regras do follow-up automático

Agenda-se uma tentativa **somente** quando todas valem, e revalida-se na hora de
enviar:

1. conversa `active` (não `paused`, não `closed`)
2. a última mensagem é do agente e deixou algo em aberto — pergunta pendente ou
   proposta de horário sem escolha — segundo a slot machine, não o texto
3. o lead não tem appointment confirmado futuro
4. `doNotContact = false`
5. `followupAttempts < FOLLOWUP_MAX_ATTEMPTS`

Qualquer mensagem do lead cancela a tentativa pendente e zera a contagem. Devolver
a conversa ao agente reinicia o relógio. Visita concluída ou cancelada **não**
reativa follow-up automático: é decisão do corretor, pela agenda.

### Turnos coalescidos

Um turno por conversa (`processingSince`). Mensagens do lead que chegam durante um
turno são gravadas e respondidas juntas no turno seguinte. Antes de iniciar um
turno, o servidor espera `CHAT_DEBOUNCE_MS` desde a última mensagem do lead, para
que rajadas ("oi" / "quero um apê" / "em Moema") virem um turno só. Toda resposta
do agente grava `repliesToMessageId`.

As chaves de configuração citadas aqui vivem em
[`configuracoes.md`](configuracoes.md).
