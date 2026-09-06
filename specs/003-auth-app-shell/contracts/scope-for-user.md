# Contract: `scopeForUser` and `reassignLead`

The rule specs 005 (dashboard) and 006 (agenda) build their lead queries on.

## `scopeForUser(session: SessionPayload): LeadScope`

```ts
type LeadScope =
  | { agencyId: string; assignedBrokerId: string }   // role: broker
  | { agencyId: string };                             // role: salesManager
```

- `broker` → `{ agencyId: session.agencyId, assignedBrokerId: session.userId }`.
  A caller applies this as `WHERE agencyId = :agencyId AND assignedBrokerId = :assignedBrokerId`.
- `salesManager` → `{ agencyId: session.agencyId }` only. A caller applies
  this as `WHERE agencyId = :agencyId` — every lead of the agency, regardless
  of who it is assigned to.
- Pure function, no I/O. Later specs pass the returned shape into their own
  Drizzle `where` clause; `scopeForUser` never touches `db/` itself, so it is
  usable from `domain/`-adjacent code without pulling in a database import.

## `reassignLead(session: SessionPayload, leadId: string, newBrokerId: string): Promise<void>`

- Throws (or rejects) if `session.role !== "salesManager"` — a `broker`
  session gets no partial effect, not a downgraded write.
- Validates `newBrokerId` names a `users` row with `role = "broker"` and the
  same `agencyId` as the session before writing anything; rejects otherwise.
  A cross-agency or non-broker target is refused by the service itself, not
  left for the UI spec 005 builds to enforce alone.
- Updates `leads.assignedBrokerId = newBrokerId` for the row matching
  `leadId AND agencyId = session.agencyId` — cross-agency reassignment is
  impossible by construction, not by an extra check.
