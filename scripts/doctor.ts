import { getConfig } from "../src/core/config.ts";

/**
 * One-shot provider reachability check. Run inside the application container:
 *
 *   docker compose exec app npm run doctor
 *
 * This is deliberately not part of readiness. A provider outage does not make
 * the application unfit to serve traffic, and gating readiness on it would pull
 * a healthy container out of rotation. What this closes is the question of
 * whether the container can reach the host's inference server at all — which is
 * a question you answer once, from inside, and then write down.
 *
 * Exit codes: 0 reachable · 2 unreachable · 3 authentication failed · 4 unexpected
 */

const config = getConfig();

const base = config.PROVIDER_BASE_URL.endsWith("/")
  ? config.PROVIDER_BASE_URL
  : `${config.PROVIDER_BASE_URL}/`;
const target = new URL("models", base);

console.log(`provider: ${target.href}`);
console.log(`model:    ${config.MODEL_ID}`);

let response: Response;
try {
  response = await fetch(target, {
    headers: { authorization: `Bearer ${config.PROVIDER_API_KEY}` },
    signal: AbortSignal.timeout(config.MODEL_TIMEOUT_MS),
  });
} catch (error) {
  // A network failure, distinct from a rejected credential (FR-015). This is
  // the shape of "the container cannot reach the host at all".
  const reason = error instanceof Error ? error.message : String(error);
  console.error(`\nUNREACHABLE — no response from the provider.\n  ${reason}`);
  console.error(
    "\nIf curl works on the host but this does not, the server is probably bound to\n" +
      "loopback again. See docs/arquitetura/restricoes-de-implantacao.md section 1.",
  );
  process.exit(2);
}

if (response.status === 401 || response.status === 403) {
  console.error(
    `\nAUTHENTICATION FAILED — the provider answered with ${response.status}.\n` +
      "The route works; the credential does not. Set PROVIDER_API_KEY in .env to the\n" +
      "key configured in the provider.",
  );
  process.exit(3);
}

if (!response.ok) {
  console.error(`\nUNEXPECTED — the provider answered with ${response.status}.`);
  console.error(await response.text());
  process.exit(4);
}

const body = (await response.json()) as { data?: Array<{ id?: string }> };
const models = (body.data ?? []).map((entry) => entry.id).filter(Boolean);

console.log(`\nREACHABLE — ${models.length} model(s) available.`);
for (const id of models.slice(0, 10)) console.log(`  ${id}`);
if (models.length > 10) console.log(`  … and ${models.length - 10} more`);

if (models.length > 0 && !models.includes(config.MODEL_ID)) {
  console.warn(
    `\nNote: MODEL_ID "${config.MODEL_ID}" is not in the list above. The route is\n` +
      "fine; the configured model id may not be.",
  );
}
