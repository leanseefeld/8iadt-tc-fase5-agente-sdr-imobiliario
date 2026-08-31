# CLAUDE.md

**Read [AGENTS.md](AGENTS.md) first.** It carries the project brief, the document
authority table, the non-negotiables, the folder structure and the PT→EN glossary.
This file only adds what is specific to Claude Code, so the two cannot drift.

## Authority

`.specify/memory/constitution.md` governs everything. `docs/` is the real
architecture. `reference/` is **non-normative ideation** describing a Python design
that will not be built — never cite it as a technical requirement.

## Skills

Spec Kit is installed. The workflow is:

`/speckit-specify` → `/speckit-clarify` → `/speckit-plan` → `/speckit-tasks` →
`/speckit-analyze` → `/speckit-implement`

`/speckit-analyze` is **required** before implementing. This is a solo project with
no human review gate, so the automated consistency check is the only gate there is.

## Working here

- Plan mode is worth using for anything touching the orchestrator, the slot machine
  or the data model — those are where a wrong assumption is expensive.
- Do not write production code without a merged spec in `specs/`. If asked to
  implement something with no spec, say so and offer to write the spec first.
- When a question is listed as undecided in `docs/decisoes-pendentes.md`, stop and
  ask rather than picking a plausible answer.
- `npm`, not pnpm or yarn.
