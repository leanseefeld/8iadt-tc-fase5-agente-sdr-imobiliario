import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { forgetLeadNames, maskSpanData, rememberLeadName } from "../src/core/langfuse.ts";

/**
 * SC-011: zero unmasked names, phones or e-mail addresses in any trace.
 *
 * The two failures these cover were both found by reading real spans in
 * Langfuse, not by reasoning about the code — see the T053 notes in the
 * implementation log.
 */
describe("the span mask", () => {
  beforeEach(() => forgetLeadNames());

  it("masks a name under a key inside an already-serialized payload", () => {
    // The AI SDK hands OpenTelemetry a JSON *string*, which is why masking the
    // structure is not enough on its own.
    const payload = JSON.stringify({
      arguments: { name: "Camila Duarte", contact: "(11) 98765-4321" },
    });

    const masked = maskSpanData(payload) as string;

    assert.ok(!masked.includes("Camila"), masked);
    assert.ok(!masked.includes("Duarte"), masked);
    assert.ok(!masked.includes("98765"), masked);
    assert.ok(masked.includes("C*** D***"), masked);
  });

  it("leaves a payload that is not JSON as free text, phones still masked", () => {
    const masked = maskSpanData("me liga no (11) 98765-4321") as string;

    assert.ok(!masked.includes("98765"));
    assert.ok(masked.startsWith("me liga no "));
  });

  it("redacts a registered name from free text, where no key names it", () => {
    rememberLeadName("Camila Duarte");

    const masked = maskSpanData("Prazer em te conhecer, Camila! Vamos achar seu imóvel.") as string;

    assert.ok(!masked.includes("Camila"), masked);
    assert.ok(masked.includes("C***"), masked);
    assert.ok(masked.includes("Vamos achar seu imóvel."), masked);
  });

  it("redacts the full name before its parts, so no half-masked form survives", () => {
    rememberLeadName("Camila Duarte");

    const masked = maskSpanData("- nome: Camila Duarte") as string;

    assert.equal(masked, "- nome: C*** D***");
  });

  it("reaches names nested anywhere in a serialized structure", () => {
    rememberLeadName("Camila Duarte");
    const payload = JSON.stringify({
      messages: [{ role: "user", content: "Oi, meu nome é Camila Duarte" }],
    });

    const masked = maskSpanData(payload) as string;

    assert.ok(!masked.includes("Camila"), masked);
    assert.ok(!masked.includes("Duarte"), masked);
    assert.ok(JSON.parse(masked).messages[0].role === "user");
  });

  it("registers nothing for a null name, and redacts nothing without one", () => {
    rememberLeadName(null);

    assert.equal(maskSpanData("Camila veio ver o imóvel"), "Camila veio ver o imóvel");
  });

  it("does not shred ordinary text with two-letter fragments of a name", () => {
    rememberLeadName("Ana Li");

    // "Li" is too short to redact on its own; the full name still is.
    const masked = maskSpanData("O imóvel fica em Lisboa") as string;
    assert.equal(masked, "O imóvel fica em Lisboa");
    assert.equal(maskSpanData("Ana Li ligou"), "A*** L*** ligou");
  });
});
