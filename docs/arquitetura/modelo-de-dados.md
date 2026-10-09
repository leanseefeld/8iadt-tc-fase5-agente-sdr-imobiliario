# Modelo de dados

Documento normativo. Define o esquema compartilhado pelas specs 002 a 009; a spec 002 o materializa em Drizzle
(`src/db/schema.ts`, migrações em `src/db/migrations/`, `0000` a `0003`), e as demais o consomem. Alterações
passam por aqui primeiro. Conferido contra o schema e a migração `0003` em 08/10/2026.

Identificadores em inglês, conforme o glossário de [`AGENTS.md`](../../AGENTS.md).
Chaves primárias são `uuid` geradas no banco. Toda tabela de negócio carrega `agencyId` (ADR 10) e `createdAt`;
**`messages` é a exceção**: não tem `agencyId` e é escopada pela conversa a que pertence. Só `users`, `leads` e
`conversations` têm `updatedAt`.

---

## 1. Tabelas

### agencies

| Coluna | Tipo | Notas |
|---|---|---|
| id | uuid | |
| name | text | "Imobiliária Demo" na seed |
| slug | text, único | usado na rota pública do widget: `/chat/[agencySlug]` |
| followupEnabled | boolean, padrão `true` | chave do follow-up automático da agência (006 FR-019); só a gerência muda; lida **na hora de enviar**, nunca ao agendar |

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
| name, phone, email | text, nulos | pedidos tarde no roteiro; o slot `contact` vira `phone` ou `email` na gravação do turno; PII mascarada em logs, traces e eventos |
| channel | enum `web` · `telegram` | |
| externalId | text | identidade no canal (sessão do widget); único por (agência, canal, externalId) |
| intent | enum `purchase` · `rental` · `investment` · `undefined` | |
| status | enum `new` · `qualifying` · `qualified` · `scheduled` · `visited` · `won` · `lost` | **etapa do funil**, só avança; o corretor pode marcar `won`/`lost` de qualquer etapa. Ver §7 |
| score | int, padrão 0 | recalculado a cada turno, ver §3 |
| assignedBrokerId | uuid, nulo → users | |
| consentAt | timestamptz, nulo | opt-in declarado na abertura |
| doNotContact | bool, padrão false | honrado por toda saída |
| createdAt, updatedAt | timestamptz | |

A **temperatura** (`cold` · `warm` · `hot`) não é coluna: deriva do score em
`domain/`.

### conversations

| Coluna | Tipo | Notas |
|---|---|---|
| id, agencyId, leadId | uuid | o código reaproveita a conversa do lead; o banco não impõe unicidade por lead |
| channel | enum | igual ao lead |
| status | enum `active` · `paused` · `closed` | **estado da conversa**: `paused` = um humano precisa responder; `closed` = encerrada; hoje só o opt-out do lead escreve esse valor |
| heldByUserId | uuid, nulo → users | quem assumiu; nulo com `paused` = "Aguardando corretor" |
| followupState | enum `none` · `pending` · `exhausted` | **estado do follow-up**; `exhausted` = tentativas esgotadas sem resposta |
| processingSince | timestamptz, nulo | turno em andamento (`claimTurn`); garante um turno por conversa e permite coalescer mensagens |
| slots | jsonb | estado da qualificação, ver §2 |
| summary | text, nulo | resumo gerado pelo worker |
| previewLine | text, nulo | frase-chave para a lista de leads |
| summaryUpdatedAt | timestamptz, nulo | |
| lastLeadMessageAt, lastAgentMessageAt | timestamptz, nulos | base da elegibilidade de follow-up |
| fallbackStreak | int, padrão 0 | respostas seguidas sem entendimento; 2 dispara handoff |
| followupAttempts | int, padrão 0 | tentativas de follow-up já enviadas; zera quando o lead escreve |
| createdAt, updatedAt | timestamptz | |

### messages

| Coluna | Tipo | Notas |
|---|---|---|
| id, conversationId | uuid | sem `agencyId`: a agência vem da conversa |
| role | enum `lead` · `agent` · `broker` · `system` | |
| content | text | |
| repliesToMessageId | uuid, nulo | mensagens `agent`: a última mensagem do lead que o turno leu. Se houver mensagens do lead posteriores, o widget cita a primeira linha dela no topo do balão |
| metadata | jsonb | o que cada mensagem carrega além do texto. **Lead:** `clientMessageId` (idempotência: índice único parcial por conversa, migração `0001`). **Corretor:** `userId`. **Follow-up:** `isFollowUp`. **Agente, gravado pelo `commitTurn`:** `propertyIds` (os cards exibidos), `guard` (guarda de código que reescreveu a resposta), `meeting` (`viewing`/`call` ofertado), `reconfirmation`, `toolCalls` (nome e argumentos, com PII mascarada); e o estado que o turno seguinte lê (ADR 22) — `meetingOptions`, `offerDeclined`, `interestedProperty`, `booking`, `pendingCancel`, `pendingChoice`, `reschedulingId`, `rebook`, `closing` (009), `humanOffer` (015). Ver [`turno-do-agente.md`](turno-do-agente.md) §3 |
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
| isActive | bool, padrão true | |

### appointments

| Coluna | Tipo | Notas |
|---|---|---|
| id, agencyId, leadId, conversationId | uuid | |
| brokerId | uuid → users | |
| propertyId | uuid, nulo | nulo em `call` |
| scheduledAt | timestamptz | |
| type | enum `viewing` · `call` | |
| status | enum `proposed` · `confirmed` · `cancelled` · `done`, padrão `proposed` | uma proposta aberta é uma linha `proposed`; reservar a confirma, cancelar e remarcar (009) mexem na mesma linha |

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
| lockedAt | timestamptz, nulo | quando o worker reivindicou a tentativa; uma linha `running` parada há mais de dez minutos é reivindicada de novo |
| sentAt | timestamptz, nulo | |

Consulta do worker: `update … where status = 'pending' and scheduledFor <= now() … for update skip locked`
(`jobs/followup.ts`).

### Restrições únicas e índices

| Onde | O quê | Para quê | Origem |
|---|---|---|---|
| `agencies` | único `slug` | rota pública do widget | `0000` |
| `users` | único `(agencyId, email)` | login | `0000` |
| `leads` | único `(agencyId, channel, externalId)` | uma identidade de canal, um lead | `0000` |
| `properties` | único `(agencyId, code)`; índices `(agencyId, transaction)` e `(agencyId, neighborhood)` | código humano; busca do agente | `0000` |
| `messages` | índice `(conversationId, createdAt)` | histórico de um turno | `0000` |
| `messages` | único parcial `(conversationId, metadata->>'clientMessageId')` onde a chave existe | reenvio do mesmo `clientMessageId` não cria segunda mensagem | `0001` (à mão) |
| `events` | índices `(conversationId, createdAt)` e `(agencyId, type, createdAt)`; parcial `(conversationId, createdAt)` onde `type = 'conversation.turn'` e `processedAt` é nulo | linha do tempo; métricas do painel; fila do resumidor | `0000`, `0002` |
| `leads` | índice `(agencyId, assignedBrokerId, score desc, updatedAt desc)` | fila de leads por escopo e score | `0002` (à mão) |
| `appointments` | parcial `(brokerId, scheduledAt)` onde `status = 'confirmed'` | horários ocupados e colisão na reserva | `0003` |
| `followup_jobs` | índices `(status, scheduledFor)` e parcial, onde `status = 'pending'` | reivindicação do worker | `0000`, `0003` |

A migração `0003` também acrescenta `agencies.followupEnabled`.

---

## 2. Slots — o estado da qualificação

Um objeto JSON validado por Zod em `src/domain/slots.ts` (`slotsSchema`, `SCRIPT`). O roteiro por intenção define a
**ordem** das perguntas; a slot machine pergunta o primeiro slot vazio dessa ordem (`nextQuestion`), e quem
escolhe a pergunta é sempre o código.

> **Revisável desde o [ADR 22](adr/decisoes.md#22-revisable-qualification-state-and-actions-as-tool-calls)**
> (22/09/2026). Todo critério pode ser revisto, **`intent` inclusive**. Uma revisão é algo aprendido, nunca uma
> não compreensão. Repetir uma pergunta já respondida é desencorajado no prompt, não proibido no código.

| Intenção | Ordem dos slots |
|---|---|
| `purchase` · `rental` | `priceMax` → `bedrooms` → `neighborhoods` → `urgency` → `name` → `contact` |
| `investment` | `investorProfile` → `ticket` → `returnExpectation` → `name` → `contact` |
| `undefined` | apenas a captura de intenção; nada mais é perguntado |

`name` e `contact` só entram na fila depois do consentimento (`lead.consentAt`).

| Slot | Tipo | Notas |
|---|---|---|
| priceMax | number > 0 (BRL) | "até 700 mil" → 700000; aluguel: mensal |
| bedrooms | int > 0 | mínimo desejado |
| neighborhoods | string[] | bairros ou região; `[]` = "aberto a sugestões", resposta válida que conta como preenchida; `null` = ainda não respondido |
| urgency | `immediate` · `soon` · `exploring` | ≤ 1 mês · ≤ 3 meses · sem prazo |
| investorProfile | `firstTime` · `experienced` | |
| ticket | number > 0 (BRL) | |
| returnExpectation | `income` · `appreciation` · `both` · `undecided` | |
| name | string | |
| contact | string | telefone ou e-mail |

`intent` vive no lead, não nos slots, mas é o primeiro slot lógico: enquanto for `undefined`, a única pergunta é
sobre a intenção.

**Regras de merge** (`mergeSlots`, aplicadas depois de toda extração; a regra 3 foi retirada pelo ADR 22):

1. Um slot preenchido nunca é apagado por valor vazio; um valor *diferente* e não vazio o substitui (o lead pode
   subir o orçamento) e conta como revisão.
2. `[]` em `neighborhoods` não é vazio (ver acima).
3. *(retirada)* `intent` só saía de `undefined`; hoje ele troca, e a troca é `intentChanged`.
4. Um valor inválido é descartado sozinho; o resto da extração vale.
5. `name` e `contact` não existem antes do consentimento, diga o que o modelo disser.

Antes do merge, um portão de evidência (`turn/extract.ts`, `hasEvidence` em `domain/slots.ts`) descarta um valor
de `urgency`, `investorProfile` ou `returnExpectation` que as palavras do lead não sustentam, e uma troca de
`intent` que o lead não disse: são os valores que um modelo pequeno inventa. O slot que a pergunta anterior
acabou de fazer dispensa a evidência.

---

## 3. Score e temperatura

Função pura `scoreLead(intent, slots)` em `src/domain/score.ts`, recalculada do zero a cada turno e gravada em
`leads.score`. O modelo nunca atribui nem ajusta o número. É o que o [ADR 11](adr/decisoes.md#11-deterministic-lead-score)
decide e o que o código faz.

| Componente | Pontos |
|---|---|
| Intenção identificada (≠ `undefined`) | 10 |
| Cada slot do roteiro preenchido, exceto `name`/`contact` | 15 (compra/aluguel: 4 slots = 60; investimento: 3 slots = 45) |
| `contact` preenchido | 15 |
| `urgency = immediate`, **ou** `returnExpectation` preenchida e ≠ `undecided` com `ticket ≥ 1 000 000` | +15 |
| `urgency = soon` | +5 |

Teto de **100** (`Math.min`). Um roteiro de compra completo com contato e urgência imediata dá 10 + 60 + 15 + 15 =
100; um de investimento chega a 10 + 45 + 15 + 15 = 85. Temperatura (`temperature()`): **fria < 40**, **morna
40–69**, **quente ≥ 70**; não é coluna, deriva do score.

- `qualified` = todos os slots do roteiro preenchidos, exceto `name`/`contact` (`isQualified`).
- **Propor a reunião** (`shouldProposeMeeting`, 006): compra e aluguel — quente **e** com `contact`; investimento —
  roteiro completo, sem exigir temperatura. Não é handoff: o agente segue no comando. Handoff (conversa `paused`)
  só quando o lead pede uma pessoa, após dois fallbacks seguidos, ou quando um corretor assume pelo painel.

> **Não implementado.** O [ADR 20](adr/decisoes.md#20-the-lead-score-is-uncapped-and-compounding) previa um
> score **sem teto e cumulativo** (100 como referência de "roteiro de compra completo com urgência imediata",
> mais pontos conforme o orçamento, piso de 50 para aluguel com prazo curto, pontos por reservar uma visita,
> faixas de temperatura refeitas). A spec 008, que o construiria, foi cortada da entrega: os pesos nunca foram
> fixados e `score.ts` continua com a tabela acima. Se a 008 voltar, é aqui, em `score.ts` e no ADR 20 que a
> mudança acontece; nada do que o ADR 20 descreve vale hoje.

---

## 4. Catálogo de eventos

Só aparece aqui o que o código grava. `append-only`; `processedAt` nulo é a fila do worker (o resumidor consome
`conversation.turn`).

| type | payload | emitido por |
|---|---|---|
| `lead.created` | `{ channel }` | `services/conversation/inbound.ts` |
| `lead.consented` | `{}` | idem |
| `intent.identified` | `{ intent }` | `commitTurn` |
| `slot.filled` | `{ slot, value }` (PII mascarada) — primeiro preenchimento e revisão | `commitTurn` |
| `conversation.turn` | `{ messageId }` | `commitTurn` — consumido pelo resumidor |
| `properties.suggested` | `{ propertyIds }` | `commitTurn` |
| `handoff.requested` | `{ reason: 'asked' · 'fallback' }` — sem `score`: quente com contato propõe reunião (ADR 19) | `commitTurn` |
| `lead.opted_out` | `{}` | `commitTurn` |
| `lead.status_changed` | `{ from, to }` | `commitTurn` (agente: `qualifying`, `qualified`) · `services/scheduling.ts` (reserva → `scheduled`; visita feita → `visited`) · `services/handoff.ts` (corretor muda a etapa) |
| `conversation.assumed` / `conversation.returned` | `{ userId }` | `services/handoff.ts` |
| `summary.updated` | `{}` — `actorType: worker` | `jobs/summarize.ts` |
| `lead.reassigned` | `{ fromBrokerId, toBrokerId }` | `services/auth.ts` (gerente) |
| `appointment.proposed` / `appointment.confirmed` | `{ appointmentId }` | `services/scheduling.ts` (006) |
| `appointment.rescheduled` | `{ appointmentId, from, to }` — a mesma linha, novo horário | `services/scheduling.ts` (009) |
| `appointment.done` / `appointment.cancelled` | `{ appointmentId }` — `actorType: user` pela agenda; `cancelled` também com `actorType: lead`, pelo chat, depois do sim (009) | `services/scheduling.ts` |
| `followup.scheduled` | `{ attempt, scheduledFor }` | `services/followup.ts` |
| `followup.sent` | `{ attempt, opening, exhausted }` — `actorType: worker` e o `traceId` do `followup.send` | `jobs/followup.ts` |
| `followup.recovered` | `{ attemptsSent }` — lead respondeu depois de um follow-up enviado | `services/followup.ts` |
| `followup.enabled` / `followup.disabled` | `{}` — a gerência mudou a chave da agência | `services/followup.ts` |

`lead.qualified` (`{ score }`) **não é emitido**: aparece nos dados da seed e a linha do tempo sabe mostrá-lo, mas
nada no código o grava. O estágio `qualified` do lead é o que vale (o ADR 20 e a spec 008 é que redefiniriam o
evento).

As métricas do painel (`services/metrics.ts`): tempo de primeira resposta (mediana entre o `lead.created` e a
primeira mensagem `agent`); taxa de qualificação (leads em `qualified`, `scheduled`, `visited` ou `won` sobre o
total de leads — lê `leads.status`, não evento); agendamentos (`appointments` em `confirmed`); recuperados
(eventos `followup.recovered`).

---

## 5. Seed

`npm run db:seed` (`src/db/seed/index.ts`; `db:reset` apaga e semeia de novo): uma agência ("Imobiliária Demo", slug `demo`); três usuários
(`ana@demo.com.br` corretora de compra e aluguel, `bruno@demo.com.br` corretor de investimento e compra,
`carla@demo.com.br` gerente; senha `demo1234`, só para a demonstração local); **100 imóveis** em São Paulo
(`properties.json`), 67 venda e 33 aluguel, 15 comerciais, em zona sul (Moema, Vila Mariana, Brooklin, Campo Belo,
Saúde, Itaim Bibi), zona oeste (Pinheiros, Vila Madalena, Perdizes, Butantã), centro, zona norte (Santana) e zona
leste (Tatuapé), com preços coerentes com o bairro; e três leads de demonstração em estados distintos: quente com
visita marcada (Camila), morno em qualificação (Rafael), frio parado há dois dias aguardando follow-up (Julia).

O `score` desses três leads é um valor fixo escrito na seed (85, 55 e 15); não passa por `scoreLead`, então não é
o número que o código calcularia a partir dos slots, só cai na mesma faixa de temperatura.

---

## 6. Contratos entre módulos

Assinaturas que mais de um módulo toca. Fixadas em 06/09/2026 e conferidas contra o código em 08/10/2026.

| Contrato | Forma | Onde |
|---|---|---|
| Registro de consumidores do worker | `type SweepConsumer = { name: string; run(ctx: { db: Database; now: Date; log: Logger }): Promise<void> }`; o array `consumers` é `[unansweredTurns, summarize, followup]`, iterado pelo loop do worker com try/catch por consumidor | `src/jobs/consumers.ts` |
| Tools do agente | `actionTools({ search?, booking?, reschedule? })`: só entra a tool que o turno tem motivo para oferecer (`searchProperties`, `bookMeeting`, `rescheduleMeeting`). **Propor horários não é tool**: é código (`proposeAppointment`); `proposeMeeting` sobrevive só como rótulo de transcrição | `src/agent/tools/index.ts` |
| Busca de imóveis | `services/properties.searchProperties(agencyId, criteria)`; `criteria = { transaction, priceMax?, bedrooms?, neighborhoods? }`; o agente mostra até 3 (`MAX_SUGGESTIONS`) | `src/services/properties.ts` |
| Escopo por papel | `scopeForUser(session)` → `{ agencyId, defaultOwnLeadsOnly }`: todos veem a agência; `defaultOwnLeadsOnly` é `true` para corretor e liga o filtro "Meus leads" por padrão | `src/services/auth.ts` |
| Três eixos de estado | ver §7; visita confirmada marca `scheduled` independentemente do estado da conversa | `src/services/scheduling.ts` |

---

## 7. Três eixos de estado (decidido em 08/09/2026, ADR 19)

Um lead nunca é descrito por um único status. São três eixos independentes:

| Eixo | Coluna | Valores | Quem muda |
|---|---|---|---|
| Etapa do funil | `leads.status` | `new → qualifying → qualified → scheduled → visited → won \| lost` | agente (até `scheduled`), worker (nunca), corretor (`visited`, `won`, `lost`, de qualquer etapa) |
| Estado da conversa | `conversations.status` + `heldByUserId` | `active` · `paused` (com ou sem `heldByUserId`) · `closed` | agente (`paused` sem holder = pediu corretor), corretor (assumir/devolver); o turno do agente fecha só no opt-out |
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
| Visita marcada | appointment `confirmed` com `scheduledAt` futuro — **derivado do appointment, não da etapa** (006 FR-008b): como as etapas só avançam, uma visita cancelada deixa o lead em `scheduled` sem nada marcado. O rótulo da etapa `scheduled` é *Agendamento feito* |

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

Na hora de enviar, somam-se duas condições: a chave `agencies.followupEnabled`
ligada e o instante dentro da janela (`FOLLOWUP_WINDOW_START`–`_END`, no fuso
`FOLLOWUP_TIMEZONE`). Fora da janela, a tentativa é **movida** para a próxima
abertura, sem consumir contagem; qualquer outra condição falhando **cancela** a
tentativa e devolve `followupState` a `none` (a não ser `exhausted`), para o
painel nunca mostrar um follow-up sem tentativa por trás (006 FR-013a).

### Turnos coalescidos

Um turno por conversa (`processingSince`). Mensagens do lead que chegam durante um
turno são gravadas e respondidas juntas no turno seguinte. Antes de iniciar um
turno, o servidor espera `CHAT_DEBOUNCE_MS` desde a última mensagem do lead, para
que rajadas ("oi" / "quero um apê" / "em Moema") virem um turno só. Toda resposta
do agente grava `repliesToMessageId`.

As chaves de configuração citadas aqui vivem em
[`configuracoes.md`](configuracoes.md).
