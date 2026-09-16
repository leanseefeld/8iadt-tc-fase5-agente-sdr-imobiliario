# Lead brief — spec 004 (conversation)

You are the implementation lead for ONE checkpoint group of spec 004 in
/Users/leanderseefeld/workspaces/fiap/8iadt-tc-fase5-agente-sdr-imobiliario, branch
`004-conversation` (already checked out; never switch branches, never create
worktrees, never touch `.claude/worktrees/`). Your group is named in your task.

## Read first (only these)
1. `specs/004-conversation/implementation-log.md` — the recovery file; trust it.
2. `git log --oneline main..HEAD` and `git status` — what is committed and what is not.
3. `AGENTS.md`; constitution principles III, V, VI, VII, IX, X.
4. `docs/arquitetura/modelo-de-dados.md` (§1 conversations/messages/events, §2, §3, §6, §7),
   `docs/arquitetura/visao-geral.md` §8–§9, `docs/arquitetura/configuracoes.md`.
5. `specs/004-conversation/spec.md`, `plan.md`, `tasks.md`, `data-model.md`, `contracts/*`,
   `quickstart.md` — read the parts your group needs.
6. Existing code your group touches. Reuse `src/core/config.ts`, `logging.ts`,
   `src/db/schema.ts`, `client.ts`, `src/services/properties.ts`, `auth.ts`, `health.ts`,
   `src/worker/index.ts`, `src/jobs/*` if present. Do not re-invent them.

## Environment
- No host Node. `docker compose exec app npm install <pkg>@<exact>`, `… npm test`,
  `docker compose exec -e INTEGRATION=1 app npm test`, `… npm run lint`,
  `docker compose exec app npm run db:generate|db:migrate|db:seed`. Stack is up and seeded.
- Model: oMLX on the host, reachable from containers at `PROVIDER_BASE_URL` in `.env`,
  `MODEL_ID=gemma-4-e4b-it-OptiQ-4bit` for all tests (set it in `.env` if it still says
  `gemma4:12b`). Calls take 2–10 s; thinking (`chat_template_kwargs.enable_thinking`) adds
  ~8 s and needs a higher output cap. Keep model-dependent tests few and under
  `tests/integration/` gated by `INTEGRATION=1`.
- Next 16 App Router; `cookies()`/`headers()` async; `params`/`searchParams` are Promises;
  route handlers for SSE must return a `Response` with a `ReadableStream`.
- AI SDK 7 (`ai`, `@ai-sdk/openai-compatible`): check installed `node_modules/ai/dist/index.d.ts`
  for the exact `streamText`/`generateObject`/`tool` signatures before writing code;
  do not code from memory.

## Rules
- Commit after EVERY task (`feat(004): T0xx …`, ending with
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`); tick the task in tasks.md in the
  same commit; update `implementation-log.md` (Done / In flight / Next step / Gotchas) in the
  same commit. Never leave more than one task uncommitted. Assume you can be killed at any moment.
- You may spawn at most 3 Sonnet subagents (model "sonnet") at a time for file-owned,
  well-defined pieces (tests, CSS, a single module). Short briefs naming exact files; each
  subagent commits its own work with the same rules. When you spawn one, your run pauses and you are
  re-invoked with its result; on that re-invocation, read the result and CONTINUE the work — never
  reply with a 'waiting' message. Prefer doing pieces yourself unless they are truly separable.
- You may simplify plan.md/tasks.md (commit as `docs(specs): 004 simplify …`). You MUST NOT
  change spec.md, contracts/ or docs/. If you need to, STOP and report the exact change.
- STOP and report (ending your run) when: your group's exit gate passes; a spec/contract change
  is needed; a decision in `docs/decisoes-pendentes.md` is involved; a dependency or API you cannot
  verify blocks you; or a test cannot go green within the spec. Never work around silently.
- Frugal and unfussy: no extra abstractions, no repository layer, no Redis, no UI library.
  Portuguese copy written by a native; English identifiers.

## Final report (≤ 20 lines)
Commits since start, tasks ticked, subagents used and what they owned, test counts (unit and
INTEGRATION), exit-gate evidence (commands and outputs), open items or requested changes, and
the exact next task for the following lead.

## Prompt layout for KV / prefix caching (guidance from the product owner, 2026-09-08)
A turn makes more than one model call. Keep the shared prefix byte-identical so the
server's prefix cache hits: stable system persona first, then the conversation history
in a stable serialisation, and only then the per-call suffix (slot state, next question,
call-specific instruction). Never put timestamps, random ids or the slot state at the
top of the prompt. oMLX reports `usage.prompt_tokens_details.cached_tokens`; check it in
the smoke script when touching prompts. Not a hard requirement — a cheap habit.
