# Data Model: Authentication and App Shell

This slice adds no table. It introduces one ephemeral, non-persisted shape
and consumes two entities spec 002 owns.

## Session (not persisted)

Decoded from the signed cookie; never written to Postgres.

| Field | Type | Notes |
|---|---|---|
| userId | uuid | matches `users.id` |
| agencyId | uuid | matches `users.agencyId`, carried so scoping needs no join |
| role | `broker` \| `salesManager` | copied at login; not re-read from the database until next login |
| issuedAt | epoch seconds | for logging/debugging only |
| expiresAt | epoch seconds | `issuedAt + 7 days`; verification rejects past this |

Encoding: `base64url(JSON.stringify(payload)) + "." + base64url(HMAC-SHA256(payload, AUTH_SECRET))`.
Verification recomputes the HMAC over the decoded payload and compares in
constant time before trusting `expiresAt`.

## Consumed: User (spec 002)

| Field | Type | Used here for |
|---|---|---|
| id | uuid | `session.userId` |
| agencyId | uuid | `session.agencyId`, tenant scoping |
| name | text | top bar display |
| email | text | login lookup |
| passwordHash | text | `bcrypt.compare` against the submitted password |
| role | enum `broker` \| `salesManager` | `session.role`, `scopeForUser()` |

## Consumed: Lead (spec 002/005, read/write by `scopeForUser`/`reassignLead`)

Only the two fields this slice's service layer touches:

| Field | Type | Used here for |
|---|---|---|
| agencyId | uuid | every scoped query's tenant filter |
| assignedBrokerId | uuid, nullable | broker's visibility filter; the field `reassignLead()` writes |

## Ephemeral: login attempt counter

In-memory only, per app instance, never persisted or logged as a table.

| Field | Type | Notes |
|---|---|---|
| ip | string | map key |
| failures | int | consecutive failures since the last reset |
| windowStartedAt | epoch ms | resets `failures` to 0 once the configured window elapses |
