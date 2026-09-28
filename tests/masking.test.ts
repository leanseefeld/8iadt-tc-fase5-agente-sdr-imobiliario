import test from "node:test";
import assert from "node:assert/strict";
import { maskText, maskPII } from "../src/core/security.ts";

/** FR-031 / constitution VIII: one masking rule for logs, traces and events. */

test("masks a bare e-mail", () => {
  assert.equal(maskText("joao.silva@gmail.com"), "j***@gmail.com");
});

test("masks an e-mail embedded in a sentence", () => {
  assert.equal(
    maskText("pode confirmar em joao.silva@gmail.com, por favor?"),
    "pode confirmar em j***@gmail.com, por favor?",
  );
});

test("masks a plain 11-digit phone number", () => {
  assert.equal(maskText("11987654321"), "(11) *****-**21");
});

test("masks a phone number in (DDD) NNNNN-NNNN form", () => {
  assert.equal(maskText("(11) 98765-4321"), "(11) *****-**21");
});

test("masks a phone number with the +55 country code", () => {
  assert.equal(maskText("+55 11 98765-4321"), "(11) *****-**21");
});

test("masks a phone number in DDD NNNNN NNNN form", () => {
  assert.equal(maskText("11 98765 4321"), "(11) *****-**21");
});

test("masks a 10-digit landline the same way, 4-4 grouped", () => {
  assert.equal(maskText("(11) 3456-7890"), "(11) ****-**90");
});

test("masks a phone embedded in free text", () => {
  assert.equal(
    maskText("pode me ligar no 11987654321 amanhã de manhã"),
    "pode me ligar no (11) *****-**21 amanhã de manhã",
  );
});

test("does not treat a R$ price as a phone number", () => {
  assert.equal(maskText("o imóvel está R$ 850.000"), "o imóvel está R$ 850.000");
});

test("does not treat a 4-digit year as a phone number", () => {
  assert.equal(maskText("construído em 2026"), "construído em 2026");
});

test("does not touch a CEP", () => {
  assert.equal(maskText("CEP 01310-100"), "CEP 01310-100");
});

test("leaves plain free text with no PII untouched", () => {
  const text = "o lead quer um apartamento de dois quartos em Moema";
  assert.equal(maskText(text), text);
});

test("maskPII masks a value under a name key, one flat *** per word", () => {
  assert.deepEqual(maskPII({ name: "Camila Duarte" }), { name: "C*** D***" });
});

test("maskPII masks a value under a leadName key by suffix match", () => {
  assert.deepEqual(maskPII({ leadName: "Camila Duarte" }), { leadName: "C*** D***" });
});

test("maskPII masks a phone under a contactPhone key", () => {
  assert.deepEqual(maskPII({ contactPhone: "11987654321" }), {
    contactPhone: "(11) *****-**21",
  });
});

test("maskPII masks a contact key holding a phone", () => {
  assert.deepEqual(maskPII({ contact: "(11) 98765-4321" }), {
    contact: "(11) *****-**21",
  });
});

test("maskPII masks a contact key holding an e-mail", () => {
  assert.deepEqual(maskPII({ contact: "joao.silva@gmail.com" }), {
    contact: "j***@gmail.com",
  });
});

test("maskPII walks a nested object", () => {
  const input = {
    lead: { name: "Camila Duarte", phone: "11987654321" },
    note: "sem PII aqui",
  };
  assert.deepEqual(maskPII(input), {
    lead: { name: "C*** D***", phone: "(11) *****-**21" },
    note: "sem PII aqui",
  });
});

test("maskPII walks an array of records", () => {
  const input = [{ name: "Camila Duarte" }, { name: "João Souza" }];
  assert.deepEqual(maskPII(input), [{ name: "C*** D***" }, { name: "J*** S***" }]);
});

test("maskPII passes numbers, booleans and null through untouched", () => {
  const input = { score: 82, isQualified: true, phone: null, note: undefined };
  assert.deepEqual(maskPII(input), input);
});

test("maskPII passes a Date through untouched", () => {
  const now = new Date();
  assert.deepEqual(maskPII({ createdAt: now }), { createdAt: now });
});

test("maskPII does not hang on a cyclic object", () => {
  const node: Record<string, unknown> = { name: "Camila Duarte" };
  node.self = node;
  const result = maskPII(node) as Record<string, unknown>;
  assert.equal(result.name, "C*** D***");
  assert.equal(result.self, node); // cycle: returned as-is rather than re-walked
});

test("masking twice is stable: masking a masked value changes nothing", () => {
  const input = {
    leadName: "Camila Duarte",
    contact: "joao.silva@gmail.com",
    message: "meu telefone é 11987654321",
  };
  const once = maskPII(input);
  const twice = maskPII(once);
  assert.deepEqual(once, twice);
});

test("maskText itself is idempotent on already-masked text", () => {
  const masked = maskText("liga pra mim: 11987654321 ou joao.silva@gmail.com");
  assert.equal(maskText(masked), masked);
});

/** An id is not a telephone number, however many digits it spends. */
test("leaves a bare UUID untouched", () => {
  const id = "d3c4dbdf-fe90-4141-414f-2d326d894141";
  assert.equal(maskText(id), id);
});

test("leaves a UUID inside a sentence untouched while still masking a real number", () => {
  const masked = maskText("mensagem d3c4dbdf-fe90-4141-414f-2d326d894141 de 11987654321");
  assert.ok(masked.includes("d3c4dbdf-fe90-4141-414f-2d326d894141"), masked);
  assert.ok(masked.includes("(11) *****-**21"), masked);
});

test("masks a payload carrying an id and a telephone side by side", () => {
  assert.deepEqual(
    maskPII({ messageId: "d3c4dbdf-fe90-4141-414f-2d326d894141", phone: "11987654321" }),
    { messageId: "d3c4dbdf-fe90-4141-414f-2d326d894141", phone: "(11) *****-**21" },
  );
});

test("masks a bare name through its key, the way an event payload does", () => {
  assert.deepEqual(maskPII({ name: "Camila" }), { name: "C***" });
});

/**
 * Traces came back reading `"toolName": "u***"` where `updateSlots` belonged,
 * which makes a trace unreadable in exactly the place you go to read it. The
 * suffix rule stays broad; the machinery keys are the exception.
 */
test("leaves an AI SDK toolName alone", () => {
  assert.deepEqual(maskPII({ toolName: "updateSlots" }), { toolName: "updateSlots" });
});

test("still masks the person-name keys the data model uses", () => {
  assert.deepEqual(maskPII({ name: "Camila Duarte", leadName: "Ana Souza" }), {
    name: "C*** D***",
    leadName: "A*** S***",
  });
});

test("leaves the other machinery keys alone", () => {
  assert.deepEqual(maskPII({ modelName: "gemma-4-e4b", fileName: "seed.ts" }), {
    modelName: "gemma-4-e4b",
    fileName: "seed.ts",
  });
});

test("a Langfuse trace or span id is an id, not a phone number", () => {
  const traceId = "c78868825597c737c04f00a4172b9105";
  assert.equal(maskText(`trace ${traceId}`), `trace ${traceId}`);
  assert.equal(maskText("span 7b1c49d2a1156123"), "span 7b1c49d2a1156123");
  assert.deepEqual(maskPII({ traceId, outcome: "sent" }), { traceId, outcome: "sent" });
});

test("a phone next to an id is still masked", () => {
  const out = maskText("ligar 11987654321 sobre c78868825597c737c04f00a4172b9105");
  assert.equal(out, "ligar (11) *****-**21 sobre c78868825597c737c04f00a4172b9105");
});
