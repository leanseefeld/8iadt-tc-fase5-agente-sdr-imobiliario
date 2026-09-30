# Spec 009 — Changing what was booked

**Format:** one page, agreed with the developer on 29/09/2026 for this spec only, instead of `/speckit-specify`.
The examples are the acceptance tests. Anything this page doesn't say is not a requirement; a question it raises
goes to *Open questions* for the developer, never into the build on its own.

## What it is

Today a lead books a visit or a phone conversation in the chat but can't undo or move it: asking gets *"ainda não
consigo te ajudar com isso"* (spec 006 FR-004g). 009 lets the lead **cancel** and **reschedule** from the
conversation, and hold **more than one** meeting at a time.

## What it covers

- **Cancel.** *"Não vou mais poder na sexta"* identifies that meeting, and the agent **asks first**: *"Quer mesmo
  cancelar a visita de sexta às 14h?"* Only a yes cancels. After cancelling, the agent offers to reschedule.
- **Reschedule.** *"Dá pra passar pra segunda às 10?"* moves **the same meeting** to the new time. The new time goes
  through the same check as booking — the broker's week, what's already booked, **two hours' notice**. If it doesn't
  fit, the lead gets options for that meeting, as when booking.
- **More than one meeting.** Visits to different properties, or a visit and a phone conversation — **up to three**
  confirmed meetings still to come per lead. Asking for a fourth gets a code-written sentence saying so, and the
  offer to change one of the three.
- **Which one.** When *"a visita"* or *"o horário"* could mean more than one meeting, the agent asks which — by
  property or by day — and acts only once it's clear.
- **The agenda follows.** A cancelled meeting shows as cancelled on its day; a rescheduled one moves to its new day
  and time.

## What it doesn't cover

Reminders before a meeting · cancellation rules or penalties · the broker rescheduling from the agenda (it keeps
*Realizada* / *Cancelar*) · choosing the broker.

## Already decided (spec 006)

One rule validates every time, booking and rescheduling alike · the model acts through tools, and the sentences the
lead reads are written by code · no broker's name reaches the lead · a meeting is one appointment row, so a
reschedule moves that row rather than creating another.

## Examples

1. **Cancel, confirmed.** Booked: Friday 14h. *"não vou mais poder na sexta"* → *"Quer mesmo cancelar a visita ao
   VMA-0001 de sex 02/10 às 14h?"* → *"sim"* → cancelled; the agent offers to reschedule; the agenda shows it
   cancelled.
2. **Cancel, not confirmed.** Same, but the lead answers *"não, deixa"* → nothing changes; the visit stands.
3. **Reschedule.** Booked: Friday 14h. *"dá pra passar pra segunda às 10?"* → the same meeting now on Monday 10h, with
   a new confirmation; nothing is created.
4. **Reschedule that doesn't fit.** *"pode ser daqui a uma hora?"* → less than two hours away → the lead hears why,
   and gets options.
5. **Which one.** Booked: VMA-0001 on Friday, MOE-0008 on Tuesday. *"quero cancelar a visita"* → *"Qual delas:
   VMA-0001 na sexta ou MOE-0008 na terça?"* → *"a de terça"* → the cancel confirmation for MOE-0008.
6. **A second meeting.** Booked: a visit on Friday. *"quero também uma conversa por telefone"* → phone options →
   booked; both meetings stand.
7. **The limit.** Three meetings booked; asking for another → told the limit is three, and offered to change one.

## Decided after the phone tests (29/09)

The developer tested four conversations on a phone; each was replayed on e4b and 12B, and these came from it:

- **A close.** When nothing is pending and the lead asks nothing, the agent closes in a code-written sentence
  — *"Por nada! Fica marcado: … Se precisar de algo, é só chamar."* — instead of inventing a next step. When the
  lead writes again after a close, the agent greets them back naturally before going on.
- **Calendar words are read by code**: weekday names, *manhã/tarde*, *hoje/amanhã/depois de amanhã*.
- **Times on the table come first**: with options offered, *"nada na quarta?"* or *"quinta"* asks for other
  options, not to move something already booked — unless the message says to move or cancel it.
- **Nothing still to come to change** (it already passed): a request for times becomes a new booking; otherwise
  the agent says there's nothing booked from now on and offers to book.
- **Mornings offer 9h and 11h too**, after 10h, 14h and 16h30; options are shown in time order.
- **Declining an offer is not opting out**: only an explicit request to stop receiving messages closes the
  conversation.

## Open questions

None open. Answered on 29/09: ask before cancelling; rescheduling uses booking's two-hour notice; up to three
meetings per lead.
