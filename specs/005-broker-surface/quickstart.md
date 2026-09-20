# Quickstart: Broker Surface

Run top to bottom on `docker compose up -d` after `docker compose exec app npm run db:reset`.
Users: `ana@demo.com.br` (broker), `carla@demo.com.br` (manager), password `demo1234`.

## 1 · Queue — SC-002–SC-004

1. `/leads` as Ana: four tiles, list by score. 006's tiles read `0`.
2. *Meus leads* on shows only Ana's leads; off shows the agency. Filter, search and page 2 survive a reload.
3. Rows: dot **and** word, *Lead anônimo* where unnamed, intent, qualification line, quoted preview, conversation chip, stage chip, live dot.
4. As Carla the toggle starts off. As Ana with toggle on, a URL to Bruno's lead is not found; off, it opens.
5. SC-003: insert 500 leads via `psql`, first paint < 1.5 s, same query count on pages 1 and 20; roll back.

## 2 · Panel — SC-010

1. Sections: header, RESUMO (IA) with time, QUALIFICAÇÃO, actions, CONVERSA, LINHA DO TEMPO.
2. Empty slots *— não informado*; whole transcript; timeline in pt-BR with *ver trace* links.
3. Escape and back close it; focus returns; list state kept. 390 px: full screen, no side scroll.

## 3 · Summary — SC-005–SC-007

1. Four-turn widget conversation: within two sweeps the row has a preview (≤ 90 chars) and the panel a summary.
2. A message just sent: that conversation is skipped this sweep.
3. `docker compose up -d --scale worker=2`; one `summary.updated` per conversation per batch. Scale back.
4. Stop oMLX: widget falls back, screens render, sweep logs failure, summary unchanged.

## 4 · Handoff — SC-008

1. Widget open in another window. Ana assumes a `new` lead: the badge appears **with no message sent** (SC-008); the timeline names Ana.
2. Lead message: no agent reply.
3. Ana replies: widget shows it labelled as a person; row `role='broker'`.
4. Carla assumes the same: fails with a message.
5. Return: next lead message gets an agent reply.
6. A lead nobody holds: reply box disabled, says why; a `paused` unheld one reads *Aguardando corretor*.

## 5 · Gates

```bash
docker compose exec app npm run lint
docker compose exec app npx tsc --noEmit
docker compose exec app npm test
docker compose exec app npm run test:integration
```

Then SC-009: every string pt-BR, no emoji.
