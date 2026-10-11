# Spec 017 — The follow-up queue, its settings and the meeting reminder

**Format:** one page, like 009, 015 and 016. Agreed with the developer on 10/10/2026 through the plan page
(decisions and comments quoted below). The examples are the acceptance tests. Anything this page doesn't say
isn't a requirement. Takes backlog items 23 and 37, and adds the reminder, which wasn't in the backlog.

## What it is

Three things, built in this order on one branch:

1. **Settings** (`/configuracoes`, sales manager only): when follow-ups may go out, and the reminders.
2. **The queue** (`/followups`, brokers and the manager): what goes out next, with **Send now** and **Cancel**.
3. **The reminder**: a written message to the lead a set time before a confirmed visit or call (default 2 h).

## Already decided (specs 006, 009, 015)

- The follow-up text is composed **at send time** by `writeFollowup`. Nothing is stored ahead of time.
- At most **one pending follow-up per conversation**. The next attempt is created only after one is sent.
- A lead's message cancels pending follow-ups (FR-010). Opt-out sets `doNotContact` and closes the conversation.
  The sweep checks eligibility twice before sending.
- **No broker's name reaches the lead** through scheduling (006 FR-005e). Written sentences say *"alguém da
  nossa equipe"*.
- Every appointment status change goes through `transitionAppointment`.

## 1 · Settings

- **Stored on the agency row** (per tenant, ADR 10), with migration defaults equal to today's behaviour and the
  seed writing them explicitly:
  - `followup_window_start` / `followup_window_end` (`09:00` / `20:00`);
  - `followup_window_days`, the weekdays the window opens (all seven);
  - `reminders_enabled` (`true`);
  - `reminder_lead_minutes` (`120`).
- **The env keys go away:** `FOLLOWUP_WINDOW_START` and `FOLLOWUP_WINDOW_END` are removed from `core/config.ts`
  and `.env.example`, and so is the stale `FOLLOWUP_FIRST_DELAY_HOURS` from the local `.env`.
  - `FOLLOWUP_TIMEZONE` **stays in env**. Visits, the agenda and the chat read it too, so it is the agency's
    time zone and not a follow-up setting. The screen shows it and doesn't edit it.
  - The cadence (first delay, attempts, backoff) stays in env.
- **No restart:** eligibility already joins `agencies`, so it reads the window from the row. `isWithinWindow` and
  `nextWindowOpening` learn about weekdays: a closed day is skipped to the next open day's start.
- **The screen**, for someone who came to change when the agency talks to leads:
  - follow-up on/off, **moved here** from the leads dashboard (brokers keep the read-only line there);
  - weekday toggles and start/end times (15-minute steps; start before end; at least one day);
  - reminders on/off, plus how long before the meeting.
  - One Save button and a word of feedback.
  - The nav item exists only for `salesManager`; a broker opening the URL goes to `/leads`.
- Changing the lead time **re-times pending reminders** in the same transaction.

## 2 · The queue

- **`/followups`**, a nav item for both roles, scoped by `LeadScope`. Rows are grouped Today / Tomorrow / Later,
  each showing when it goes, the lead and the kind:
  - *Follow-up 2 de 3*, with the conversation's `previewLine` for context;
  - *Lembrete de visita/conversa*, with the meeting's day and time.

  A follow-up due while the window is closed says when it will really go (*"fora da janela · sai às 09:00"*).
  Empty state: *"Nenhuma mensagem na fila."*
- **Send now** bypasses **only the window**:
  - the switch off, opt-out, a closed conversation, or a broker holding or awaited on the conversation still
    block it, with the reason in words;
  - the job gets `bypass_window` and is due now, the worker is woken through `LISTEN/NOTIFY` (a new
    `followup_due` channel), and the sweep interval stays as the fallback;
  - it is the same job and the same send path, and it counts as an attempt;
  - the drawer's existing *Enviar follow-up agora* calls the same service.
- **Write it myself** (follow-ups only): Send now offers *"Sofia escreve"* (default) or *"Eu escrevo"*.
  - The broker's text goes out as **that broker's message** (role `broker`, their `userId`, `isFollowUp`).
  - It isn't kept as a draft and exists only in the conversation history.
  - It counts as the attempt and the next one is scheduled. The conversation stays with Sofia, who already
    reads *"[Nome escreveu]"* lines.
- **Cancel** sets the job to `cancelled`, the conversation's follow-up state to `none` and writes
  `followup.cancelled` with the user.
  - A follow-up's chain stops until the lead writes again.
  - A reminder: only that reminder.
- Feedback: *"Enviando…"* on the row until the send lands, then the row leaves. A blocked send says why.

## 3 · The reminder

- **`followup_jobs.kind`** (`followup` | `reminder`) plus `appointment_id`, with one pending reminder per
  appointment (partial unique index). Same claim, same queue, same Send now / Cancel. It never touches
  `followupAttempts` or `followupState`.
- **Kept in step by `transitionAppointment`**, the one place statuses change:
  - becoming `confirmed` (booking or reschedule) queues or moves the reminder to `scheduled_at − lead`, and
    cancels it when that is already past (a meeting booked less than the lead time ahead gets none);
  - becoming `cancelled` or `done`, from the chat or the agenda, cancels it.
- **The lead writing doesn't cancel it:** `cancelFollowup` touches `kind = 'followup'` only.
- **At send it bypasses** the window, the attempt cap, the "booked" rule and the follow-up switch. It
  **respects**:
  - `reminders_enabled`;
  - opt-out (skipped, event `reminder.skipped`);
  - the appointment still being confirmed and not yet started.
- **Written text, no model call.** It is informational, asks nothing, and reuses `describeMeeting`'s facts
  (kind, day, time, property):

  > Oi, Ana! Passando pra lembrar: sua visita ao apartamento no Campeche é hoje às 15h, com alguém da nossa
  > equipe. Pode avisar por aqui mesmo se não puder mais ou precisar remarcar.

  When a broker holds the conversation, or it is awaiting one:

  > Sofia aqui, interrompendo só pra lembrar: sua visita ao apartamento no Campeche é hoje às 15h. Pode avisar
  > por aqui mesmo se não puder mais ou precisar remarcar.

  The lead's answer then goes to the broker, as every message does in a held conversation. The broker sees
  Sofia's reminder in the transcript.
- **The answer is a normal turn.** The reminder is stored as an agent message with `reminder: { appointmentId }`
  and the `closing` mark, so a thank-you gets courtesy only (015's *"a second obrigado"*), not the schedule
  again.
- **Opted out with a meeting still booked:** the agenda card shows *"Lead pediu para não receber mensagens"*.
- **Events:** `reminder.sent` and `reminder.skipped` (with the reason).

## Examples

1. **Window closed, Send now.** Saturday 22:10, window 09:00–20:00, Marcos has *Follow-up 2 de 3* due at 22:00 →
   the row says *"sai às 09:00"*. Send now → Sofia's follow-up arrives within seconds and the row leaves; attempt
   3 is scheduled.
2. **Switch off.** The follow-up switch is off and the broker presses Send now → *"O follow-up automático está
   desligado nesta imobiliária."* Nothing is sent.
3. **Eu escrevo.** Beatriz writes *"Oi Marcos, separei mais duas opções na Trindade, quer ver?"* → it arrives
   under her name. Marcos answers and Sofia carries on.
4. **Cancel.** Cancel on Marcos's follow-up → the row leaves and nothing follows. Marcos writes the next day →
   Sofia answers and a new follow-up is queued as usual.
5. **Weekdays.** The manager turns Sunday off. A follow-up due Sunday 10:00 moves to Monday 09:00 with no
   restart.
6. **Reminder.** Ana books a visit for 15:00 → a reminder is queued for 13:00. At 13:00 she gets the first text
   above.
7. **Answers to the reminder**, each a normal turn:
   - *"não vou mais poder"* → 009's cancel flow, and no reminder remains;
   - *"pode ser amanhã no mesmo horário?"* → 009's reschedule, and the reminder moves;
   - *"ok"* or *"obrigada!"* → a short courtesy, without the schedule again;
   - *"para de me mandar mensagem"* → opt-out as always, and the agenda card gets the badge.
8. **Cancelled first.** Ana cancels at 11:00 → nothing at 13:00. A broker marking the visit `done` early does
   the same.
9. **Booked late.** At 14:00 Ana books 15:00 → no reminder.
10. **Rescheduled.** 15:00 moves to tomorrow 10:00 → the reminder moves to tomorrow 08:00 and is sent then, before
    the window opens.
11. **Held conversation.** Beatriz holds Ana's conversation → the reminder goes out with *"Sofia aqui,
    interrompendo…"*. Ana's reply waits for Beatriz.
12. **Reminders off.** The manager turns reminders off → pending ones are skipped at send time. Follow-ups are
    unaffected.
13. **Opted out.** Ana opted out with a visit still booked → no reminder, and the badge is on the agenda.

## What it doesn't cover

- Reminders to the broker.
- Per-day hours (the same start and end apply to every enabled day).
- Editing the time zone or the cadence on screen.
- Opt-out cancelling the visit.

## How it is checked

- Unit tests for window and weekday arithmetic and the reminder's due time.
- Integration tests for the sweep (bypass, reminder kinds, skips) and examples 6–10 on e4b, kept under 5
  minutes. Full suite before merge.
- Docs in the same branch, per AGENTS.md's "Keeping the docs true":
  - `turno-do-agente.md` (the reminder as a written message and the state it leaves);
  - `modelo-de-dados.md`, `configuracoes.md`, `visao-geral.md`, and a new ADR superseding ADR 15's fixed
    window;
  - `requisitos.md` and the README;
  - backlog 23 and 37 marked done, plus a reminder row;
  - screenshots: the new nav items appear on every app screen, so all of them are retaken, plus the queue and
    settings screens.

## Open questions

None open.
