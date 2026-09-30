# Spec 015 — plan and record

Built overnight on 30/09/2026 against the one-page [spec](spec.md). This plan adds no requirement of its own. Where
it chose something the page doesn't say, the choice is listed under *Decisions I made*, for the developer to
confirm in the morning.

## Consistency check (constitution 1.4.0, turn map)

- **V · Deterministic slot machine.** Code decides when the boundary offer happens and what waits. The model only
  phrases it. The offer is the turn's one question, and the script's question waits a turn, so there is still
  one question per message.
- **Development workflow.** The Spec Kit steps (specify → analyze) are waived for this spec by the developer
  (30/09). This check replaces `/speckit-analyze`. The spec lives on the feature branch, as 009's did.
- **VII · Observability.** The act and the remainder are extraction facts, so they reach the trace like the
  others. The boundary decision is recorded on the turn as a code-invoked tool span (`offerHuman`).
- **VIII · Privacy.** The remainder is the lead's own words. It is kept on the agent message's metadata (like
  the options) and masked on the trace like every payload.
- **Turn map.** Two new decisions (boundary, pending offer) and a change to the close. The map is updated with
  them.

## Design

- **`src/agent/lexicon.ts`**: the pt-BR readings done by code. `readAcknowledgement(text)` is the safety net.
  `parseWhen` and the yes/no reading move here during the refactor stage.
- **`src/agent/decide/boundary.ts`**: pure. `decideBoundary(facts, turn) → { offer: string } | null`, and
  `readOfferAnswer(...)` for the turn after an offer.
- **Extraction** (`tools/update-slots.ts`): `messageAct` (thanks, agree, answer, request, question, inform, other)
  and `uncovered` (string or null).
- **Pending state**: `humanOffer: { about }` on the agent message's metadata, read by `pendingChange`.
- **Reply prompt** (`prompts/system.ts`):
  - the capability list joins the constant `REPLY_SYSTEM_PROMPT`, which stays constant, for the cache;
  - the discount line leaves the refusal rule;
  - the briefing gains two tasks: the boundary offer and the close.
- **Close** (`prompts/meeting.ts`): `closingSummary(meetings)` is the code prefix. The courtesy is phrased with
  the close task.

## Decisions I made (not on the page)

- **When the boundary applies.** Only on a turn that would otherwise be phrased without a search presentation:
  the script's question, "nothing to ask", and the close.
  - A code-written reply (options, a confirmation, "quer mesmo cancelar?", "qual delas?", a refusal, a handoff)
    still wins the turn outright, and the remainder is dropped.
  - A search presentation also wins.

  That keeps one question per message, and leaves the precedence of 006 and 009 untouched.
- **The script's question waits** for a turn with a boundary offer. It comes back on the next turn.
- **Yes/no to the offer** is read like the other pending questions: the extraction's `answer`, or the words when
  it didn't say.
