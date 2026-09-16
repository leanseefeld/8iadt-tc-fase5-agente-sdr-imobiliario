/**
 * Extraction eval — how often does a turn read a lead's message correctly?
 *
 * Run:  docker compose exec -T app node evals/extraction.mjs [--runs 5]
 *
 * What it is for. The extraction is the one place where a sampler decides
 * whether the agent understood someone, so changing its prompt, its schema or
 * its provider needs a number rather than an anecdote. This is that number.
 *
 * Three properties matter more than the score itself:
 *
 *   1. It calls the **shipped** prompt and the **shipped** repair and gate —
 *      `extractionSystemPrompt`, `normalizeExtraction`, `hasEvidence`. A harness
 *      with its own copy of the prompt measures the copy.
 *   2. Each case carries the **conversation before it**, so the question the
 *      script had just asked is really in the context. Half of these messages
 *      ("2", "inicial") mean nothing without it.
 *   3. Labels live in `extraction-cases.json`, reviewed and version-controlled,
 *      apart from the code that scores them. Each case declares what the turn
 *      already knew, what this message must add, and — by omission — everything
 *      that must stay empty.
 *
 * Every run writes its raw model output to `evals/last-run.jsonl`, so a
 * surprising number can be read rather than re-argued.
 */

import { readFile, writeFile } from "node:fs/promises";
import { getConfig } from "../src/core/config.ts";
import { extractionSystemPrompt } from "../src/agent/prompts/system.ts";
import { normalizeExtraction, isTrue } from "../src/agent/tools/update-slots.ts";
import { hasEvidence } from "../src/domain/slots.ts";

const CASES_PATH = new URL("./extraction-cases.json", import.meta.url);
const OUTPUT_PATH = new URL("./last-run.jsonl", import.meta.url);

/** Pinned, not inherited: sampling settings change these results a lot. */
const TEMPERATURE = 0;
const MAX_OUTPUT_TOKENS = 300;
const CONCURRENCY = 8;

/** The closed-set slots the evidence gate protects, mirroring the orchestrator. */
const GATED_SLOTS = ["urgency", "investorProfile", "returnExpectation"];

// ---------------------------------------------------------------------------
// Running the model
// ---------------------------------------------------------------------------

/** Runs `worker` over `items`, `limit` at a time. oMLX serves 8 comfortably. */
async function inParallel(items, worker, limit = CONCURRENCY) {
  const results = new Array(items.length);
  let cursor = 0;

  const lane = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}

/** One extraction call, shaped exactly as `agent/orchestrator.extract` shapes it. */
async function extractOnce(config, testCase) {
  const messages = [
    ...testCase.history.map((entry) => ({
      role: entry.role === "lead" ? "user" : "assistant",
      content: entry.content,
    })),
    { role: "user", content: testCase.message },
  ];

  const response = await fetch(`${config.PROVIDER_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.PROVIDER_API_KEY}`,
    },
    body: JSON.stringify({
      model: config.MODEL_ID,
      temperature: TEMPERATURE,
      max_tokens: MAX_OUTPUT_TOKENS,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: extractionSystemPrompt() }, ...messages],
    }),
  });

  const body = await response.json();
  return body.choices?.[0]?.message?.content ?? "";
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function parseObject(text) {
  const open = text.indexOf("{");
  const close = text.lastIndexOf("}");
  if (open === -1 || close <= open) return null;
  try {
    const parsed = JSON.parse(text.slice(open, close + 1));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The orchestrator's gate: a closed-set slot needs evidence unless it was asked. */
function applyEvidenceGate(slots, testCase) {
  const kept = { ...slots };
  for (const slot of GATED_SLOTS) {
    if (kept[slot] === undefined) continue;
    if (slot === testCase.pending) continue;
    if (hasEvidence(slot, testCase.message)) continue;
    delete kept[slot];
  }
  return kept;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * A case passes only if the turn ends in exactly the state the label describes:
 * every expected value present and correct, and **nothing else filled**. The
 * second half is the half that catches invention, so it is not optional.
 */
function grade(text, testCase) {
  const raw = parseObject(text);
  if (raw === null) return { outcome: "unparseable", problems: ["no JSON object in the response"] };

  const slots = applyEvidenceGate(normalizeExtraction(raw), testCase);
  const flags = { askedForHuman: isTrue(raw.askedForHuman), optOut: isTrue(raw.optOut) };
  const problems = [];

  for (const [key, expected] of Object.entries(testCase.expect)) {
    const actual = key in flags ? flags[key] : slots[key];
    if (!same(actual, expected)) {
      problems.push(`${key}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  }

  // Anything beyond the label is either a harmless re-statement of what the turn
  // already knew — the extraction does this constantly and `mergeSlots` ignores
  // it, because a filled slot is never overwritten — or invention.
  for (const [key, actual] of Object.entries({ ...slots, ...flags })) {
    if (key in testCase.expect) continue;
    if (actual === undefined || actual === null || actual === false) continue;
    if (key in testCase.known) {
      if (!same(actual, testCase.known[key])) {
        problems.push(
          `${key}: contradicts what was known ` +
            `(${JSON.stringify(testCase.known[key])} → ${JSON.stringify(actual)})`,
        );
      }
      continue;
    }
    problems.push(`${key}: invented ${JSON.stringify(actual)}`);
  }

  return { outcome: problems.length === 0 ? "pass" : "fail", problems };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function parseRuns(argv) {
  const flag = argv.indexOf("--runs");
  const value = flag === -1 ? NaN : Number(argv[flag + 1]);
  return Number.isInteger(value) && value > 0 ? value : 5;
}

async function main() {
  const config = getConfig();
  const runsPerCase = parseRuns(process.argv);
  const { cases } = JSON.parse(await readFile(CASES_PATH, "utf8"));

  const jobs = cases.flatMap((testCase) =>
    Array.from({ length: runsPerCase }, () => testCase),
  );
  const outputs = await inParallel(jobs, (testCase) => extractOnce(config, testCase));

  const tally = new Map(cases.map((c) => [c.id, { pass: 0, fail: 0, unparseable: 0, problems: [] }]));
  const audit = [];

  outputs.forEach((text, index) => {
    const testCase = jobs[index];
    const { outcome, problems } = grade(text, testCase);
    const row = tally.get(testCase.id);
    row[outcome] += 1;
    for (const problem of problems) if (!row.problems.includes(problem)) row.problems.push(problem);
    audit.push({ case: testCase.id, outcome, problems, raw: text });
  });

  await writeFile(OUTPUT_PATH, audit.map((row) => JSON.stringify(row)).join("\n") + "\n");

  console.log(`model ${config.MODEL_ID}  temperature ${TEMPERATURE}  ${runsPerCase} runs per case\n`);

  let passed = 0;
  for (const [id, row] of tally) {
    const rate = row.pass / runsPerCase;
    if (row.pass === runsPerCase) passed += 1;
    const mark = row.pass === runsPerCase ? "ok  " : row.pass === 0 ? "FAIL" : "flaky";
    console.log(`${mark.padEnd(6)} ${id.padEnd(42)} ${row.pass}/${runsPerCase}`);
    for (const problem of row.problems.slice(0, 3)) console.log(`         ${problem}`);
  }

  const total = outputs.length;
  const clean = [...tally.values()].reduce((sum, row) => sum + row.pass, 0);
  const unparseable = [...tally.values()].reduce((sum, row) => sum + row.unparseable, 0);
  console.log(
    `\n${clean}/${total} runs correct · ${passed}/${cases.length} cases clean on every run · ` +
      `${unparseable} unparseable\nraw output: evals/last-run.jsonl`,
  );

  // A case that is right sometimes is not right: the lead only gets one turn.
  process.exitCode = passed === cases.length ? 0 : 1;
}

await main();
