# Contract: Session Cookie

What specs 004–006 and the app shell may rely on when they call
`core/auth.ts` or `services/auth.ts`. Changing any row here is a breaking
change to every spec that authenticates.

## Cookie

| Property | Value |
|---|---|
| Name | `session` |
| httpOnly | `true` |
| sameSite | `lax` |
| secure | `true` outside `NODE_ENV=development` |
| maxAge | 7 days |
| Signing | HMAC-SHA256 over `AUTH_SECRET`, via Web Crypto `subtle.sign`/`verify` |
| Payload | `{ userId, agencyId, role, issuedAt, expiresAt }`, base64url JSON |

## `core/auth.ts` exports

```ts
function sign(payload: SessionPayload): Promise<string>;              // -> cookie value
function verify(cookieValue: string): Promise<SessionPayload | null>; // null on any failure
function getSession(): Promise<SessionPayload | null>;    // reads the request's cookie via next/headers
function clearSessionCookie(): void;                       // used by logout, no crypto involved
```

`sign` and `verify` are `Promise`-returning because HMAC runs on Web Crypto's
`subtle.sign`/`subtle.verify` (see plan.md), which are asynchronous by
design — chosen so the same implementation works in `src/middleware.ts`,
which may execute on Next.js's edge runtime where `node:crypto` is
unavailable. Every caller (`getSession()`, the middleware, `login()`) awaits
them.

`verify` returns `null` — never throws — for: missing cookie, malformed
encoding, bad signature, missing field, or `expiresAt` in the past. Callers
must treat `null` as "unauthenticated," not as an error to surface.

## Guarantees

- No database round trip in `getSession()` or `verify()` — the cookie is
  self-contained for its full 7-day life (see spec.md Clarifications: no
  server-side revocation).
- `role` is exactly `"broker"` or `"salesManager"` — the same enum spec 002
  defines on `users.role`, not a separate string.
- The middleware at `src/middleware.ts` is the only place a failed `verify`
  produces a redirect; every other caller (`getSession()` in a Server
  Component or Server Action) just receives `null` and decides for itself.
