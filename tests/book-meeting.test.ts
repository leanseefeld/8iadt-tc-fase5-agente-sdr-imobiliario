import test from "node:test";
import assert from "node:assert/strict";
import { indexFrom, instantFrom } from "../src/agent/tools/book-meeting.ts";

/**
 * Spec 006 FR-005 — what the 4-bit model actually sends. The first live replay
 * booked nothing because it wrote `{"optionIndex": "1"}` and the schema wanted a
 * number; a pick the model got right must not be lost to its spelling.
 */

test("an option index arrives as a number or as a numeric string", () => {
  assert.equal(indexFrom(2), 2);
  assert.equal(indexFrom("1"), 1);
  assert.equal(indexFrom(" 3 "), 3);
  for (const bad of [0, -1, 1.5, "", "segunda", null, undefined]) assert.equal(indexFrom(bad), null, String(bad));
});

test("a named time is read in the agency's zone, in the spellings the model uses", () => {
  const tz = "America/Sao_Paulo";
  const ten = "2030-01-10T13:00:00.000Z";
  for (const time of ["10:00", "10h", "10", "10h00"]) assert.equal(instantFrom("2030-01-10", time, tz)?.toISOString(), ten, time);
  assert.equal(instantFrom("2030-01-10", "9:30", tz)?.toISOString(), "2030-01-10T12:30:00.000Z");
  for (const time of ["25:00", "10:75", "manhã"]) assert.equal(instantFrom("2030-01-10", time, tz), null, time);
  assert.equal(instantFrom("10/01/2030", "10:00", tz), null);
});
