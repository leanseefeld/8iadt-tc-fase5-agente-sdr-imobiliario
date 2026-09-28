# Quickstart — proving Revisable Orchestration works

How to verify this slice by hand, in the order the phases land. Each section names
the success criteria it closes, so a partial implementation can still be checked
against what it claims.

## Prerequisites

```bash
docker compose up -d
```

The unit suite needs Node 24 (the host default may be older):

```bash
nvm use 24 && npm test
```

**Baseline before starting.** On the host, `npm test` gives 177 pass / 15 fail —
all fifteen are `loadConfig` errors from an unset `DATABASE_URL` and `AUTH_SECRET`,
because the suite is meant to run in the container. That is the known-good state,
not a regression. Inside the container the suite is green.

---

## 1. The accounting fix — SC-001, SC-002

**No model needed.** This is the whole defect, and it is verifiable in the unit
suite.

```bash
npm test -- tests/slots.test.ts tests/revision.test.ts
```

Expect: a slot receiving a different value appears in `revised`, not in `dropped`;
re-supplying the same value appears in neither; an empty value over a filled slot
is still `dropped`; `intent` moving between two defined values reports
`intentChanged` instead of being dropped.

Then the end-to-end shape, against the container's database:

```bash
docker compose exec app npm test -- tests/integration/revision.test.ts
```

Drive a purchase script to completion, then send *"na verdade, e na zona norte?"*.
Assert: the neighbourhood changed, `fallbackStreak` is **0**, a new search ran,
and the reply is not an apology.

**The register's three conversations (SC-002).** Replay each to completion and
assert none reaches a handoff:

- *"E na zona norte, tem algo?"* after a finished script
- *"Moema ou Vila Mariana"* after *"zona sul"*, mid-script
- *"e a visita de amanhã, continua de pé?"* the turn after a handback

The third one is expected to reach a handoff **eventually** — the agent genuinely
cannot answer it until spec 006 — but the reply must read *"ainda não consigo te
ajudar com isso"*, never *"desculpa, não entendi"* (FR-023).

## 1a. Conversational messages — SC-004a

No model assertion needed for the decision itself, only for the fact feeding it.
In the widget, mid-script, send each of these and expect **no apology and no
streak movement**:

- *"Nossa, isso seria bom haha"* — a reaction
- *"opa, tá aí?"* — a check-in
- *"valeu!"* — thanks
- *"👍"* — nothing at all

Then send two in a row and confirm **no handoff**. Today the first two both earn
*"desculpa, não entendi"*, because `plausiblyAnswers` counts `nossa`, `isso`,
`seria` and `ta` as attempted answers.

Also check the mixed case — *"opa! pode ser até 900 mil"* — which is social *and*
substantive: the slot must merge and the turn must be ordinary.

## 1b. The provider is down — SC-004b

Point `PROVIDER_BASE_URL` at a dead port and send ten messages.

Expect ten technical replies, **zero handoffs**, and a fallback streak that never
moves. Today the second message hands off, so an outage delivers every live
conversation to the brokers at once.

Also check the ordering case: one unintelligible message, then *"haha ok"*, then
another unintelligible one. The third turn hands off — the interjection neither
rescued the count nor accelerated it.

## 2. The reconfirmation — SC-005

```bash
npm test -- tests/revision.test.ts
```

Property-style over generated revision cases: exactly one question every time, the
table's invariants hold (no `name`/`contact`, no self-reference, at most three
dependants, every key real), unfilled dependants omitted.

Then by hand in the widget at `http://localhost:3000/chat/<agency>`: qualify,
then say *"na verdade até 1,2 milhão"*. Expect something like:

> Só pra confirmar: até R$ 1,2 mi, 3 quartos, Moema. Continua assim?

Reply with another change. Expect **no second reconfirmation** — that is FR-009,
and it is the easiest thing to get wrong.

## 3. The loop — SC-003, SC-007

Bring it up in the playbook's order; do not skip to the hard case.

```bash
npm run tool-smoke            # one tool, obvious case
```

1. **Obvious case.** A turn that should search, searches. One step.
2. **Retry case.** *Moved to backlog item 010 on 27/09/2026 — the search takes no
   arguments since FR-034, so a second step cannot differ from the first.*
3. **Refusal case.** A tool called when its preconditions do not hold returns a
   refusal the model reads, and the turn still replies.
4. **Bound case.** A loop that would exceed three steps stops and still replies.

Then read the trace in Langfuse:

```bash
docker compose --profile observability up -d
```

Expect exactly the shape in
[contracts/observability.md](contracts/observability.md) §3: `model.act` with
`steps.count=2`, two `tool.searchProperties` children at `step.index` 0 and 1,
each with its result, then `model.reply`. **A `steps.count` that does not match
the number of tool children is a defect.**

## 4. The offer, once — SC-008

Complete a qualification, then send three unrelated messages. Expect exactly
**one** offer to meet across all of them. Today the offer repeats on every turn,
so this is visible without instrumentation.

## 5. Coming back from a broker — SC-009

Sign in as a broker, assume a conversation from the dashboard, then return it.
Expect, immediately and without a model call:

> Sofia de volta! Ana saiu da conversa, mas se precisar de alguma coisa, é só chamar!

Then write as the lead. The reply must not be a greeting repeated, and must not be
an apology.

## 6. What is filtered — SC-004

Ask, in three phrasings: *"como você tá filtrando?"*, *"o que vc tá considerando
pra busca?"*, *"em que critérios você tá se baseando?"*. Each reply names the held
criteria and invites a change.

The leak check is **one assertion, not a sweep**: the briefing payload carries only
the permitted fields. Score, temperature, fallback streak and pipeline stage cannot
appear in a reply because they never enter the prompt.

## 7. Concurrency, measured not assumed — SC-010

```bash
npm run tool-smoke -- --concurrency 1
npm run tool-smoke -- --concurrency 4
```

Report per-request latency for both. Roughly 4× at N=4 means the server queues;
roughly flat means real parallelism. **Record the number**, and replace the
unverified claim in `docs/exploracoes/roteiro-por-topicos.md` with it either way.

Run the two serially. Running them at the same time measures neither.

## 8. Before calling it done

```bash
docker compose exec app npm test          # green inside the container
docker compose exec app npm run lint
npm run build
```

And the judgement call that no test makes: read three real conversations end to
end in the widget. The defect this slice fixes is one a test can assert but a
person notices — an agent that apologises for understanding you.

## 9. Closing checks — SC-012, SC-013 *(added 2026-09-27)*

One conversation at `http://localhost:3000/chat/demo`, in order:

1. `quero comprar, até uns 900 mil` → `dois quartos, em vila mariana` → `em breve`
   — cards appear.
2. `posso ver até 600k?` — the reply talks about **the results**: the card(s), or
   that nothing matched. **No** *"Só pra confirmar… Continua assim?"* in that reply.
3. `nenhum imóvel nessa faixa?` — answered with the fact (*"com esses critérios
   não encontrei nenhum"*), not a bare restatement of the criteria.
4. `e até 400k?` — a no-match that invites **a new value** for one criterion.
   It must **not** ask *"posso procurar em bairros vizinhos?"*.

Then open step 2's `conversation.turn` in Langfuse: one `tool.searchProperties`
step at `step.index` 0, its result, then `model.reply`.
