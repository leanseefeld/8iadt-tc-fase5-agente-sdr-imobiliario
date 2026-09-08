# Quickstart: Data Model, Seed and Catalog

Builds on the walking skeleton's `docker compose up`. This adds one boot step (migrations) and one manual step (seed) before the demo data exists.

## Run it

```bash
docker compose up          # now also runs `migrate` once, before app/worker start
docker compose exec app npm run db:seed
```

`/catalogo` is then live at http://localhost:3100/catalogo, unauthenticated (spec 003 wraps it).

## Verify it

### SC-001 · Fresh database migrates itself

```bash
docker volume rm <project>_pgdata   # force an empty database
docker compose up
docker compose exec app curl -sf localhost:3100/api/health/ready | jq .checks
```

Both processes reach ready within 90 s; the `checks` array includes a passing `migrations` entry.

### SC-002 · Seed is idempotent

```bash
docker compose exec app npm run db:seed
docker compose exec app psql "$DATABASE_URL" -c \
  "select (select count(*) from agencies) a, (select count(*) from users) u, (select count(*) from properties) p, (select count(*) from leads) l"
docker compose exec app npm run db:seed   # again
# same query — counts unchanged: a=1 u=3 p=100 l=3
```

### SC-003 · Dataset coherence

```bash
docker compose exec app npm test -- tests/properties-dataset.test.ts
```

Passes iff every one of the 100 rows in `src/db/seed/properties.json` satisfies the rules in `data-model.md`'s seed data shape.

### SC-004 · Catalog filters and pagination

Open `/catalogo?maxPrice=1`. Grid renders empty, no error. Open `/catalogo` with no filters — 24 cards, page 2 (`?page=2`) shows the next 24 in the same order. Open `/catalogo?code=MOE` — the grid narrows instantly to properties whose `code` starts with `MOE`, and `code` is printed on every remaining card (constitution X).

### SC-005 · Search returns ranked matches

```bash
docker compose exec app npm test -- tests/properties-service.test.ts   # INTEGRATION=1 required
```

Exercises `searchProperties` against the seeded catalog for an exact match, a relaxed match and an empty-agency case.

### SC-006 · Readiness fails on an unmigrated database

```bash
docker compose up db -d
docker compose run --rm -e SKIP_MIGRATE=1 app curl -sf localhost:3100/api/health/ready
# expect HTTP 503, checks include migrations: false
```

### SC-007 · Spec 001's health contract is unchanged

```bash
docker compose exec app npm test -- tests/health.test.ts
```

Still passes unmodified — this spec only appends a check, per FR-007.
