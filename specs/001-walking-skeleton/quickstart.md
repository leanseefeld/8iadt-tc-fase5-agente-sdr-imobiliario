# Quickstart: Walking Skeleton

Two parts: how to run it, and how to prove it does what the specification claims.
The second part is the acceptance script — every success criterion in
[spec.md](spec.md) has a command here that passes or fails.

## Prerequisites

Docker. That is the whole list.

The one thing Docker cannot supply is `PROVIDER_API_KEY` — the local oMLX server
rejects unauthenticated requests, and only you have its key. Everything else in
`.env.example` is a working default.

## Run it

```bash
cp .env.example .env
```

Put your oMLX key in `PROVIDER_API_KEY`, then:

```bash
docker compose up
```

The application is on http://localhost:3100, the worker's health surface on
http://localhost:3101, and Postgres is published on 55432. Those defaults avoid
the ports most projects take; change `APP_PORT`, `WORKER_HEALTH_PORT` or
`DB_PORT` in `.env` to move them. Nothing else to start, no host toolchain to
install.

## Verify it

### SC-001 · Clone to running, one command

From a clean clone: `cp .env.example .env`, set the key, `docker compose up`.
Nothing else. If any other step is needed, either the step is a defect or it
belongs in `docs/arquitetura/restricoes-de-implantacao.md`.

### SC-002 · Cold start under 90 seconds

```bash
docker compose down -v && docker builder prune -af
time (docker compose up -d && until curl -sf localhost:3100/api/health && curl -sf localhost:3101/health; do sleep 2; done)
```

### SC-003 · Starts with dependencies absent

Four combinations of provider present/absent and observability present/absent. With
observability deferred by FR-034 there is nothing to configure, so the two provider
cases carry it: stop oMLX, `docker compose up`, confirm both processes report alive
**and ready** — readiness does not depend on the provider.

### SC-004 · Everything is JSON

```bash
docker compose logs --no-log-prefix app worker | while read -r l; do [ -z "$l" ] || echo "$l" | python3 -c "import sys,json;json.loads(sys.stdin.read())" || echo "NOT JSON: $l"; done
```

Silence is a pass.

### SC-005 · No undocumented variables

```bash
docker compose exec app npm test -- tests/env-example.test.ts
```

Fails if the config schema and `.env.example` disagree in either direction. This is
the [Environment Contract gate](plan.md#environment-contract-gate-new--standing-rule)
and it runs with the rest of the suite.

### SC-006 · No secrets committed

```bash
git log -p --all -- .env.example | grep -iE '(api[_-]?key|secret|password)=.+' || echo "clean"
```

`.env` itself is gitignored; confirm it stayed that way.

### SC-007 · Missing config stops the process

```bash
docker compose run --rm -e DATABASE_URL= app npm run start:worker
```

Exits within 10 seconds naming `DATABASE_URL`. Repeat per required key; the
table-driven case in `tests/config.test.ts` covers all of them at once.

### SC-008 · Provider reachable from inside the container

```bash
docker compose exec app npm run doctor
```

Reports reachable, or distinguishes an authentication failure from a network
failure. This is the check that closes the oMLX networking question — run it from
the container, never from the host, since the host has always worked.

### SC-009 · Health answers with the database down

```bash
docker compose stop db
curl -s -m 5 localhost:3100/api/health        # 200, alive
curl -s -m 5 localhost:3100/api/health/ready  # 503, names "database"
curl -s -m 5 localhost:3101/health/ready      # 503, names "database"
docker compose start db
```

Both readiness responses must arrive inside the 5-second bound rather than hanging
with the connection.

### SC-010 · Edit reflected in 15 seconds

Change the copy in `src/app/page.tsx` and reload. If it does not appear, set
`WATCHPACK_POLLING=true` in `.env` and restart — the macOS bind-mount fallback from
restriction §3, and a configuration change rather than a file edit by design.

### SC-011 · Worker idles cleanly

```bash
docker compose exec app sh -c 'sed -i "s/^WORKER_SWEEP_INTERVAL_MS=.*/WORKER_SWEEP_INTERVAL_MS=5000/" /app/.env'
```

Simpler: set the interval to `5000` in `.env` before starting. Watch three sweeps
pass with no errors, then confirm the worker still reports ready — the `sweep`
check proves the loop is turning, not merely that the process is up.

### SC-012 · The dependency rule is enforced

```bash
echo "import { db } from '@/db/client';" >> src/app/page.tsx
docker compose exec app npm run lint   # must fail
git checkout src/app/page.tsx
```

A lint pass here means the rule is decorative. Verify the failure, not the success.

### SC-013 · The register is current

`docs/arquitetura/restricoes-de-implantacao.md` §1 carries a dated entry for the
verified container-to-provider route, and no startup step exists that is not either
`docker compose up` or an entry in that file.

### T044 · The type-checking gate

```bash
docker build --target build -t sdr-build-check .
```

Run this rather than `npm run build` inside the dev container: the development
`app` service shares its `.next` directory with a named volume and a running dev
server, and building into that produces failures that belong to the setup rather
than to the code. The production stage has neither, which is also the point — it
is the image that would run in the cloud.

## Shutting down

```bash
docker compose down
```

State survives. `docker compose down -v` drops the volumes, which is only needed
when you want a genuinely cold start.
