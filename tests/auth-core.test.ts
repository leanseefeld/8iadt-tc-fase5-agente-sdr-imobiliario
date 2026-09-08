import test from "node:test";
import assert from "node:assert/strict";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  newSession,
  sessionCookieOptions,
  sign,
  verify,
  type SessionPayload,
} from "../src/core/auth.ts";

/**
 * `core/auth.ts` is pure crypto over `AUTH_SECRET` — no database, no request.
 * FR-003/FR-004 and `contracts/session-cookie.md`: what a valid cookie is, and
 * every way one stops being valid.
 */

const user = {
  userId: "11111111-1111-4111-8111-111111111111",
  agencyId: "22222222-2222-4222-8222-222222222222",
  role: "broker" as const,
};

test("the cookie contract is what specs 004-006 were promised", () => {
  assert.equal(SESSION_COOKIE, "session");
  assert.equal(SESSION_MAX_AGE_SECONDS, 7 * 24 * 60 * 60);
  const options = sessionCookieOptions();
  assert.equal(options.httpOnly, true);
  assert.equal(options.sameSite, "lax");
  assert.equal(options.path, "/");
  // NODE_ENV is `development` in the dev container; `secure` follows it.
  assert.equal(options.secure, process.env.NODE_ENV !== "development");
});

test("newSession expires exactly seven days after it is issued", () => {
  const session = newSession(user, Date.UTC(2026, 0, 1));
  assert.equal(session.expiresAt - session.issuedAt, SESSION_MAX_AGE_SECONDS);
  assert.equal(session.issuedAt, Math.floor(Date.UTC(2026, 0, 1) / 1000));
});

test("a signed session round-trips with every field intact", async () => {
  const session = newSession(user);
  const verified = await verify(await sign(session));
  assert.deepEqual(verified, session);
});

test("a salesManager role survives the round trip as itself", async () => {
  const session = newSession({ ...user, role: "salesManager" });
  const verified = await verify(await sign(session));
  assert.equal(verified?.role, "salesManager");
});

/**
 * Table-driven so a new rejection case is a new row, not a new test. Each
 * entry mutates a validly signed cookie, or forges one, and must be refused.
 */
const rejected: Array<[name: string, build: () => Promise<string | undefined>]> = [
  ["no cookie at all", async () => undefined],
  ["an empty cookie", async () => ""],
  ["a value with no signature", async () => (await sign(newSession(user))).split(".")[0]],
  ["a value with a third segment", async () => `${await sign(newSession(user))}.extra`],
  [
    "a tampered signature",
    async () => {
      const [body, signature] = (await sign(newSession(user))).split(".");
      const flipped = signature[0] === "A" ? "B" : "A";
      return `${body}.${flipped}${signature.slice(1)}`;
    },
  ],
  [
    "a tampered payload keeping the original signature",
    async () => {
      const [, signature] = (await sign(newSession(user))).split(".");
      const forged = { ...newSession(user), role: "salesManager" };
      const body = Buffer.from(JSON.stringify(forged)).toString("base64url");
      return `${body}.${signature}`;
    },
  ],
  ["a body that is not base64url", async () => `not base64!.${"x".repeat(43)}`],
  [
    "a correctly signed body that is not JSON",
    async () => {
      // Signed with the real key, so only the payload shape can reject it.
      const notJson = { toJSON: () => "" } as unknown as SessionPayload;
      return sign(notJson);
    },
  ],
  ["an expired session", async () => sign({ ...newSession(user), expiresAt: Math.floor(Date.now() / 1000) - 1 })],
];

for (const field of ["userId", "agencyId", "role"] as const) {
  rejected.push([
    `a payload missing ${field}`,
    async () => {
      const incomplete = { ...newSession(user) };
      delete (incomplete as Record<string, unknown>)[field];
      return sign(incomplete);
    },
  ]);
}

rejected.push([
  "a payload carrying a role that is not in the enum",
  async () => sign({ ...newSession(user), role: "admin" as unknown as "broker" }),
]);

for (const [name, build] of rejected) {
  test(`rejects ${name}`, async () => {
    assert.equal(await verify(await build()), null);
  });
}
