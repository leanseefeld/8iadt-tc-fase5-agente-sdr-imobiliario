# Contract: Health Surfaces

Both processes answer for themselves. The worker does not report through the
application, and the application does not report on the worker's behalf — that is
what makes the worker a first-class process rather than a background thread, and it
is what a container orchestrator needs in order to restart the right one.

**Liveness** means the process is running and its event loop responds. It calls no
dependency, so a sick database can never make it fail — a liveness failure means
restart me, and restarting will not fix Postgres.

**Readiness** means the process can do its work. It probes dependencies under a
bounded timeout and names any that are unmet.

**The model provider is not a readiness dependency of either process.** A provider
outage leaves the application able to serve every page and the worker able to run
every sweep that does not call a model. Provider reachability is checked by
`npm run doctor`, on demand.

## Application

### `GET /api/health` — liveness

`200` always, while the process is alive.

```json
{
  "status": "alive",
  "process": "app",
  "uptimeMs": 84213
}
```

### `GET /api/health/ready` — readiness

`200` when every check passes, `503` when any check fails. The body is identical in
shape either way, so a client parses one thing.

```json
{
  "status": "ready",
  "process": "app",
  "checks": [
    { "name": "database", "ok": true, "latencyMs": 3 }
  ]
}
```

Failing:

```json
{
  "status": "not_ready",
  "process": "app",
  "checks": [
    { "name": "database", "ok": false, "latencyMs": 2000, "detail": "timeout" }
  ]
}
```

## Worker

Served by a minimal `node:http` listener on `WORKER_HEALTH_PORT`, which exists for
no other purpose. Same paths, same shapes, `"process": "worker"`.

Worker readiness carries a second check the application has no equivalent of:

```json
{
  "status": "ready",
  "process": "worker",
  "checks": [
    { "name": "database", "ok": true, "latencyMs": 3 },
    { "name": "sweep", "ok": true, "latencyMs": 0, "detail": "last sweep 42s ago" }
  ]
}
```

The `sweep` check fails when the last completed sweep is older than **three sweep
intervals**. A polling loop that has hung still answers liveness perfectly — the
process is up, the event loop turns — so without this check a wedged worker looks
healthy forever. Three intervals rather than one absorbs a slow sweep without
flapping. The threshold is a constant, not a configuration key: it is derived from
`WORKER_SWEEP_INTERVAL_MS`, and a second knob would only create a way to set the
two inconsistently.

## Field notes

- `checks[].detail` is present only on failure, or where a passing check carries
  something worth reading, as `sweep` does.
- `latencyMs` is the probe's own duration, and it is capped by the probe timeout —
  a hanging dependency reports the timeout value, not an unbounded wait. This is
  what keeps SC-009's five-second bound true.
- No authentication. These surfaces expose no lead data, and an orchestrator cannot
  present a credential.
- Shapes are additive from here. Items 3 through 12 may add checks; they may not
  rename or remove these fields.
