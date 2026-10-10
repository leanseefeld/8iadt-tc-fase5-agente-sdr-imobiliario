# CLAUDE.md

**Read [AGENTS.md](AGENTS.md) first.** It carries the project brief, the document
authority table, the non-negotiables, the folder structure and the PT→EN glossary.
This file only adds what is specific to Claude Code, so the two cannot drift.

## Authority

`.specify/memory/constitution.md` governs everything. `docs/` is the real
architecture. `reference/` is **non-normative ideation** describing a Python design
that will not be built — never cite it as a technical requirement.

## Skills

Spec Kit is installed but **optional** since 08/10/2026 (constitution 1.6.0): offer
a one-page spec before production code and follow the developer's choice. The full
flow (`/speckit-specify` → … → `/speckit-implement`) is used only when asked.

## Working here

- Plan mode is worth using for anything touching the orchestrator, the slot machine
  or the data model — those are where a wrong assumption is expensive.
- Before writing production code with no spec, offer to write a short one first;
  if the developer declines, go ahead.
- When a question is listed as undecided in `docs/decisoes-pendentes.md`, stop and
  ask rather than picking a plausible answer.
- `npm`, not pnpm or yarn.
- **A change isn't done until the docs and screenshots match it.** Run AGENTS.md's
  "Keeping the docs true" checklist before reporting back. In particular, read
  `docs/imagens/README.md`: it says which screenshot shows what and when it must be
  retaken (`scripts/screenshots/`). Don't wait to be asked.
