# Specification Quality Checklist: Revisable Orchestration

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-09-22
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

**All 16 items pass** as of the clarification session on 2026-09-22. The two
markers that were open after `/speckit-specify` were resolved by the developer and
encoded: FR-005/FR-005a (orphaned slots kept, intent change triggers a
reconfirmation) and FR-023 (an unanswerable question advances the streak but the
reply says "ainda não consigo te ajudar com isso" rather than claiming
incomprehension).

**Scope removed in the same session**, on the developer's instruction to hunt
overengineering:

- FR-007's concrete cascade table left the spec — the mapping is data in code or
  configuration, not a requirement. The values live in git history and land in
  `plan.md`.
- SC-004's "thirty generated states" became one assertion at the briefing
  boundary, since FR-019 prevents the leak by construction.
- SC-006 was withdrawn to Assumptions; an elicitation rate cannot be measured with
  scripted leads.
- The per-turn action-permission concept was dropped before it existed. Tools
  state their own when-to-call and when-not-to-call, and refuse to the model.

**Kept after challenge:** FR-022 (the collision is nearly unreachable but the rule
is one line, and the implementation carries a comment where it would occur) and
FR-029, which turned out to close a real gap rather than add a nicety — a first
fill writes a durable `slot.filled` event that the summariser and the broker
timeline read, and a revision currently writes nothing.

**Second clarify pass, same day, after `plan.md` existed.** The developer found a
defect the spec did not cover: `notUnderstood` gates on `plausiblyAnswers()`,
whose noise list is 28 tokens, so *"Nossa, isso seria bom haha"* and *"opa, tá
aí?"* both count as attempted answers and earn an apology plus a step toward
handoff. That produced FR-003a/FR-003b, and three further clarifications:

- **FR-003c** — a failed extraction call no longer counts as a misunderstanding.
  Found while probing the new boundary: a provider outage currently hands *every*
  live conversation to a broker within two turns.
- **FR-003d** — a conversational or failed turn **holds** the count; only learning
  something resets it. Without this, a lead alternating unintelligible and chatty
  messages would never reach a human.
- **Scope deliberately not added** — no second "no-progress" counter. Recorded as
  backlog item 27 instead, with the alternative (counting how often the same
  question is re-asked) noted beside it.

**One deliberate deviation from the generic checklist.** "No implementation
details" passes on the strength of requirements staying behavioural; the
mechanism is named only in the "Why this exists" narrative and the Clarifications.
This project's merged specs name schema columns and modules freely, and matching
that house style is a considered choice.
