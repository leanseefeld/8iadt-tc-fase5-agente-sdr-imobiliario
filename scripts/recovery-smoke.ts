import { recoverSlot } from "../src/agent/recovery.ts";

/**
 * Proves the one call FR-011 allows actually works against the configured
 * provider — `generateObject` needs structured output the server may not have:
 *
 *   docker compose exec app node scripts/recovery-smoke.ts
 *
 * Not a test. The unit suite must never need a model.
 */

const cases: Array<[Parameters<typeof recoverSlot>[0]["slot"], string]> = [
  ["intent", "Estou procurando apartamento na zona sul"],
  ["priceMax", "Até uns 700 mil"],
  ["bedrooms", "Pelo menos 2, um deles como escritório"],
  ["neighborhoods", "Tenho preferência por Moema ou Vila Mariana"],
  ["urgency", "Preciso me mudar em até 2 meses"],
];

for (const [slot, text] of cases) {
  const started = Date.now();
  const extraction = await recoverSlot({ slot, text });
  console.log(`${slot}: ${JSON.stringify(extraction)} (${Date.now() - started} ms)`);
}
