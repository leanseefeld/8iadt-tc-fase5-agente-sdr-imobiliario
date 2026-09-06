# Quickstart: Broker Surface

The acceptance script. Everything runs inside containers — the host has no usable
Node. Run it top to bottom on a fresh `docker compose up -d`, with specs 002, 003
and 004 merged and the seed applied.

## 0 · Prerequisites

```bash
docker compose up -d
docker compose exec app npm run doctor        # provider reachable
docker compose logs -f worker                 # keep this open in a second terminal
```

Sign in as `ana@demo.com.br` (broker) and `carla@demo.com.br` (sales manager),
password `demo1234`.

## 1 · Rules — SC-001

```bash
docker compose exec app npm test
```

`tests/scoring.test.ts` must cover both scripts, both bonuses, the cap at 100 and
both band boundaries (39/40 and 69/70). Expect at least fifteen cases and no
database or model involvement — the file runs with the containers stopped.

## 2 · The queue — SC-002, SC-003, SC-004

1. Open `/leads` as Ana. Four tiles, then a list ordered by score descending. The
   confirmed-appointments and recovered tiles read `0` until spec 006 lands.
2. Click *Quentes*, reload the page: the filter is still applied and the URL still
   says so. Same for a search term and for page 2.
3. Confirm every row shows a colored dot **and** a word (*Quente* · *Morno* ·
   *Frio*), a name or *Lead anônimo*, the intent, the compact qualification line,
   the preview line in quotes when there is one, and a relative time.
4. Sign in as Carla: the same screen lists the whole agency. Sign back in as Ana and
   paste the URL of a lead assigned to Bruno — expect a not-found, not a panel.
5. The seed carries three demo leads. For SC-003, bulk-insert 500 more into the same
   agency from `psql` first; then the first paint is under 1.5 s and the query count
   for the page does not change between page 1 and page 20. Roll them back after.

## 3 · The panel — SC-010

1. Open a lead. Sections in order: header, **RESUMO (IA)** with its timestamp,
   **QUALIFICAÇÃO**, actions, **CONVERSA**, **LINHA DO TEMPO**.
2. Every unfilled slot reads *— não informado*. The timeline reads as Portuguese
   sentences with times, never as `lead.qualified`.
3. Press Escape: the panel closes, focus returns to the row, and the list keeps its
   filter, search and scroll. The back button does the same.
4. At a 390 px viewport the panel fills the screen and nothing scrolls sideways.

## 4 · Summary — SC-005, SC-006, SC-007

1. Hold a four-turn conversation in the widget. Within one debounce plus one sweep,
   the row gains a preview line and the panel a summary. Read it: natural pt-BR
   addressed to a broker, and the preview line at most 90 characters.
2. Send a message and check the worker log immediately — that conversation is
   skipped this sweep. It is summarised on the next one.
3. Concurrency:
   ```bash
   docker compose up -d --scale worker=2
   docker compose exec db psql -U postgres -d sdr \
     -c "select conversation_id, count(*) from events
         where type='conversation.turn' and processed_at is null group by 1;"
   ```
   Let both sweep. Every conversation gets exactly one `summary.updated` per batch —
   no duplicates, none skipped. Return to `--scale worker=1`.
4. Stop oMLX. The widget still replies through 004's fallback, every broker screen
   still renders, the sweep logs a failure and clears its turns, and the stored
   summary is unchanged. Start oMLX again.

## 5 · Handoff — SC-008

1. With the widget open in another window, click *Assumir conversa*. The
   conversation shows as paused, the badge *Falando com um corretor* appears in the
   widget on its next poll, and the timeline records the takeover.
2. Send a lead message from the widget: no agent reply, at all.
3. Type in the reply box. The message arrives in the widget labelled as a person's,
   and is stored with `role='broker'`.
4. As Carla, try to take over the same conversation: it fails with a message rather
   than stealing it.
5. Click *Devolver ao agente*. The next lead message gets an agent reply and the
   timeline records the return.
6. Open a lead nobody has taken over: the reply box is visible, disabled, and says
   why.

## 6 · Gates

```bash
docker compose exec app npm run lint      # no db/ import under app/, domain/ isolated
docker build --target build .             # the only type-check gate; not `npm run build`
INTEGRATION=1 docker compose exec -e INTEGRATION=1 app npm test    # includes the oMLX summariser test
```

Then read the screen once more with SC-009 in hand: every string pt-BR, no emoji
anywhere in the dashboard.
