# Phase 1 Data Model: Data Model, Seed and Catalog

Source of truth is `docs/arquitetura/modelo-de-dados.md` §1. This file is the Drizzle-shaped translation task generation and implementation work from — column-for-column, not a paraphrase. All primary keys are `uuid` (`defaultRandom()`). All tables except `agencies` carry `agencyId: uuid` not-null, FK → `agencies.id`. All tables carry `createdAt: timestamptz` (`defaultNow()`); mutable tables also carry `updatedAt: timestamptz`.

## Enums

- `userRole`: `broker`, `salesManager`
- `leadChannel`: `web`, `telegram` (shared by `leads.channel` and `conversations.channel`)
- `leadIntent`: `purchase`, `rental`, `investment`, `undefined`
- `leadStatus`: `new`, `qualifying`, `qualified`, `scheduled`, `visited`, `won`, `lost` — forward only; broker may set `won`/`lost` from any stage (ADR 19)
- `conversationStatus`: `active`, `paused`, `closed`
- `followupState`: `none`, `pending`, `exhausted`
- `actorType`: `lead`, `user`, `agent`, `worker`, `system`
- `messageRole`: `lead`, `agent`, `broker`, `system`
- `propertyType`: `apartment`, `house`, `commercial`, `land`
- `propertyTransaction`: `sale`, `rent`
- `appointmentType`: `viewing`, `call`
- `appointmentStatus`: `proposed`, `confirmed`, `cancelled`, `done`
- `followupStatus`: `pending`, `running`, `sent`, `cancelled`, `failed`

## Tables

**agencies** — `id`, `name: text`, `slug: text unique`, `createdAt`.

**users** — `id`, `agencyId`, `name: text`, `email: text`, `passwordHash: text`, `role: userRole`, `specializations: jsonb intent[] default '[]'` (intents the broker serves — `purchase`/`rental`/`investment`; empty on the manager), `availability: jsonb default '{}'` (per weekday: `{ mon: { enabled, start, end }, … }`), `createdAt`, `updatedAt`. Unique (`agencyId`,`email`).

**leads** — `id`, `agencyId`, `name: text null`, `phone: text null`, `email: text null`, `channel: leadChannel`, `externalId: text`, `intent: leadIntent default 'undefined'`, `status: leadStatus default 'new'` (pipeline stage, forward only — see `leadStatus` above), `score: int default 0`, `assignedBrokerId: uuid null` FK → `users.id`, `consentAt: timestamptz null`, `doNotContact: boolean default false`, `createdAt`, `updatedAt`. Unique (`agencyId`,`channel`,`externalId`).

**conversations** — `id`, `agencyId`, `leadId` FK → `leads.id`, `channel: leadChannel`, `status: conversationStatus default 'active'`, `heldByUserId: uuid null` FK → `users.id` (who assumed the conversation; null with `paused` = "Aguardando corretor"), `followupState: followupState default 'none'`, `processingSince: timestamptz null` (in-flight turn; one turn per conversation), `slots: jsonb default '{}'`, `summary: text null`, `previewLine: text null`, `summaryUpdatedAt: timestamptz null`, `lastLeadMessageAt: timestamptz null`, `lastAgentMessageAt: timestamptz null`, `fallbackStreak: int default 0`, `followupAttempts: int default 0`, `createdAt`, `updatedAt`.

**messages** — `id`, `conversationId` FK → `conversations.id`, `role: messageRole`, `content: text`, `repliesToMessageId: uuid null` FK → `messages.id` (agent messages only — the last lead message the turn read), `metadata: jsonb default '{}'`, `createdAt`. Index (`conversationId`,`createdAt`). (No `agencyId` on this table in the source document — it is reached only through its conversation; FR-002 applies to the nine tables the document lists as carrying it, and `messages` is scoped transitively.)

**properties** — `id`, `agencyId`, `code: text`, `title: text`, `type: propertyType`, `transaction: propertyTransaction`, `price: int`, `condoFee: int null`, `areaM2: int`, `bedrooms: int`, `bathrooms: int`, `parkingSpots: int`, `neighborhood: text`, `city: text`, `region: text`, `description: text`, `features: jsonb string[] default '[]'`, `estimatedRent: int null`, `imageUrl: text`, `isActive: boolean default true`, `createdAt`. Unique (`agencyId`,`code`). Indexes: (`agencyId`,`transaction`), (`agencyId`,`neighborhood`) — FR-020's pagination and FR-023's search filter both lead with `agencyId` and branch on one of these two columns.

**appointments** — `id`, `agencyId`, `leadId` FK → `leads.id`, `conversationId` FK → `conversations.id`, `brokerId` FK → `users.id`, `propertyId: uuid null` FK → `properties.id`, `scheduledAt: timestamptz`, `type: appointmentType`, `status: appointmentStatus default 'proposed'`, `createdAt`.

**events** — `id`, `agencyId`, `leadId: uuid null`, `conversationId: uuid null`, `type: text`, `actorType: actorType` (who did it), `actorUserId: uuid null` FK → `users.id` (set iff `actorType = 'user'`), `traceId: text null` (Langfuse trace id when `agent`/`worker` called the model), `payload: jsonb default '{}'`, `createdAt`, `processedAt: timestamptz null`. Indexes: (`conversationId`,`createdAt`) and (`agencyId`,`type`,`createdAt`) — the latter serves the dashboard metrics (§4).

**followup_jobs** — `id`, `agencyId`, `conversationId` FK → `conversations.id`, `attempt: int`, `scheduledFor: timestamptz`, `status: followupStatus default 'pending'`, `lockedAt: timestamptz null`, `sentAt: timestamptz null`, `createdAt`. Index on (`status`,`scheduledFor`) — serves `where status = 'pending' and scheduledFor <= now()`.

## Seed data shape

**Agency**: one row, `name = "Imobiliária Demo"`, `slug = "demo"`.

**Users** (all `agencyId` = the seeded agency): `ana@demo.com.br` / `broker`, specializations `["purchase","rental"]`; `bruno@demo.com.br` / `broker`, specializations `["investment","purchase"]`; `carla@demo.com.br` / `salesManager`, specializations `[]`. `passwordHash = bcrypt.hash("demo1234", 10)`. `availability`: Ana and Bruno get Mon–Fri `{ enabled: true, start: "09:00", end: "18:00" }`, weekend `enabled: false`; Carla (manager, not scheduled) gets `{}`.

**Properties**: 100 rows from `src/db/seed/properties.json`, each carrying every `properties` column except `id`, `agencyId` (assigned at insert) and `imageUrl` (computed as `https://picsum.photos/seed/${code}/640/480`). Dataset entry shape (validated by `properties.schema.ts` before insert):

```ts
{
  code: string;              // "MOE-0042" pattern, unique within the file
  title: string;
  type: "apartment" | "house" | "commercial" | "land";
  transaction: "sale" | "rent";
  price: number;              // integer BRL
  condoFee: number | null;
  areaM2: number; bedrooms: number; bathrooms: number; parkingSpots: number;
  neighborhood: string; city: string; region: string;
  description: string;        // 2-4 pt-BR sentences
  features: string[];
  estimatedRent: number | null;  // required iff transaction === "sale"
  isActive: true;
}
```

**Price bands** — the concrete numbers `validateDataset()` checks against (a dataset-validation detail, not itself a business rule modelo-de-dados.md fixes, so it lives here rather than in spec.md):

| Zone | Neighborhoods | Sale price (BRL) | Rent price (BRL/month) |
|---|---|---|---|
| Zona sul (premium) | Moema, Vila Mariana, Brooklin, Campo Belo, Saúde | 600,000 – 3,500,000 | 3,000 – 15,000 |
| Zona oeste (premium) | Pinheiros, Vila Madalena, Perdizes, Butantã | 550,000 – 3,200,000 | 2,800 – 14,000 |
| Centro | Centro | 250,000 – 900,000 | 1,500 – 5,000 |
| Zona norte | Santana | 280,000 – 950,000 | 1,600 – 5,500 |

`validateDataset()` fails a row whose `price` falls outside its zone's band for its `transaction`. Bands are wide on purpose — the 100 rows span every `type` (`apartment`/`house`/`commercial`/`land`), and a commercial or land listing legitimately sits at either edge; the rule catches a data-entry mistake (a Santana apartment priced like a Moema penthouse), not fine-grained realism.

**Leads**: three rows, `channel = "web"`, `externalId ∈ {"seed-hot","seed-warm","seed-cold"}`, one per the three state axes (ADR 19, §7):

| Lead | intent | `leads.status` | score | `conversations.status` | `followupState` | Slots | Extra |
|---|---|---|---|---|---|---|---|
| hot | `purchase` | `scheduled` | ≥ 70 | `active` | `none` | all routed slots filled, `contact` set | one `appointments` row, `status='confirmed'`, `scheduledAt` in the future |
| warm | `purchase` | `qualifying` | 40–69 | `active` | `none` | `priceMax`/`bedrooms` filled, later slots empty | — |
| cold | `rental` | `qualifying` | < 40 | `active` | `pending` | `lastLeadMessageAt` = now − 2 days | none here — spec 006 adds the due `followup_jobs` row |

Each lead's `events` trail uses the types from modelo-de-dados.md §4 consistent with its state (e.g. the hot lead carries `lead.created`, `intent.identified`, a `slot.filled` per filled slot, `lead.qualified`, `appointment.confirmed`; the cold lead stops after a couple of `slot.filled` events, nothing after the two-day gap). Every seeded event carries `actorType = 'agent'` except the row for `lead.created`, which carries `actorType = 'system'`; `actorUserId` is `null` throughout the seed — no seeded event is attributed to a human. `followup_jobs` stays empty for all three (see spec Clarifications).
