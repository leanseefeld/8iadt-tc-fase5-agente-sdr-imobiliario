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

Spec 002 also adds `specializations` and `availability` to `users`. Neither
is read here: the session cookie does not carry them, and the shell's role
badge (FR-013) is unaffected — it shows only `name` and `role`.

## Consumed: Lead (spec 002/005, read/write by `scopeForUser`/`reassignLead`)

Only the one field this slice's service layer touches:

| Field | Type | Used here for |
|---|---|---|
| agencyId | uuid | every scoped query's tenant filter — the only filter `scopeForUser()` applies; every role sees every lead of the agency |
| assignedBrokerId | uuid, nullable | the field `reassignLead()` reads (for the `lead.reassigned` event's `fromBrokerId`) and writes |
