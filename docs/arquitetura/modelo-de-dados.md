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

### leads

| Coluna | Tipo | Notas |
|---|---|---|
| id, agencyId | uuid | |
| name, phone, email | text, nulos | pedidos tarde no roteiro; PII mascarada em logs e traces |
| channel | enum `web` · `telegram` | |
| externalId | text | identidade no canal (sessão do widget); único por agência + canal |
| intent | enum `purchase` · `rental` · `investment` · `undefined` | |
| status | enum `new` · `qualifying` · `qualified` · `scheduled` · `handoff` · `won` · `lost` · `unresponsive` | |
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
| status | enum `active` · `paused` · `closed` | `paused` = corretor assumiu |
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

## 3. Score (ADR 11)

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
- Handoff automático = quente **e** `contact` preenchido — que coincide com o fim
  do roteiro; o agente propõe a reunião e avisa que um corretor assume.

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
| `handoff.requested` | `{ reason: 'asked' · 'fallback' · 'score' }` | 005 |
| `conversation.assumed` / `conversation.returned` | `{ userId }` | 005 |
| `summary.updated` | `{}` | 005 |
| `appointment.proposed` / `appointment.confirmed` | `{ appointmentId }` | 006 |
| `followup.scheduled` / `followup.sent` | `{ attempt }` | 006 |
| `followup.recovered` | `{ attempt }` — lead respondeu após follow-up | 006 |
| `lead.opted_out` | `{}` | 004 |

As métricas do painel derivam daqui: tempo de primeira resposta
(`lead.created` → primeira mensagem `agent`), taxa de qualificação
(`lead.qualified` / `lead.created`), taxa de agendamento
(`appointment.confirmed` / `lead.created`), recuperados (`followup.recovered`).

---

## 5. Seed

Uma agência; três usuários (`ana@demo.com.br` corretora, `bruno@demo.com.br`
corretor, `carla@demo.com.br` gerente; senha `demo1234`); **100 imóveis** em São
Paulo distribuídos por zona sul (Moema, Vila Mariana, Brooklin, Campo Belo,
Saúde), zona oeste (Pinheiros, Vila Madalena, Perdizes, Butantã), centro e zona
norte (Santana), ~70 venda / ~30 aluguel, ~15 comerciais, preços coerentes com o
bairro; e três leads de demonstração em estados distintos (quente com reunião
marcada, morno em qualificação, frio parado há dois dias aguardando follow-up).
