# Contract: `scopeForUser` and `reassignLead`

The rule specs 005 (dashboard) and 006 (agenda) build their lead queries on.

## `scopeForUser(session: SessionPayload): LeadScope`

```ts
type LeadScope = { agencyId: string; defaultOwnLeadsOnly: boolean };
```

- Every role → `{ agencyId: session.agencyId, defaultOwnLeadsOnly }`. A
  caller applies this as `WHERE agencyId = :agencyId` only — every lead of
  the agency, for both roles. There is no cross-role query restriction; a
  broker is not scoped to `assignedBrokerId` at the data layer.
- `defaultOwnLeadsOnly` is `true` for `broker`, `false` for `salesManager`.
  It is a **UI default**, not a permission: spec 005's "Meus leads" list
  reads it to decide whether the list starts filtered to the signed-in
  broker's own leads or shows the whole agency. A broker can still switch the
  filter off in the UI; the query underneath is unrestricted either way.
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
- On success, records a `lead.reassigned` event: `actorType: "user"`,
  `actorUserId = session.userId`, `payload = { fromBrokerId, toBrokerId }`
  (`fromBrokerId` is the lead's `assignedBrokerId` before the write,
  `toBrokerId` is `newBrokerId`). The service writes this event itself, in
  the same operation as the update — the caller (spec 005's UI) does not
  emit it separately.
