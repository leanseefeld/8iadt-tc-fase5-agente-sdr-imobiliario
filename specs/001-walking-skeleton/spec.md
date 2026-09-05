# Feature Specification: Walking Skeleton

**Feature Branch**: `001-walking-skeleton`

**Created**: 2026-08-31

**Status**: Draft

**Input**: User description: "backlog item 1"

Backlog item 1 — *Walking skeleton*: Next.js app, Dockerfile, `docker-compose.yml`
(`app`, `worker`, `db`), health endpoints on both processes, env config, JSON
structured logging, worker entrypoint. Resolves the oMLX networking question from
the constraints register. Covers the *Arquitetura: organização, escalabilidade,
componentização* grading criterion.

This is the ground every later slice stands on. It carries no business behaviour:
nothing here qualifies a lead, searches a property or sends a message. Its whole
value is that the next eleven slices can assume a running system instead of
building one.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The whole system starts with one command (Priority: P1)

A developer clones the repository onto a machine that has Docker and nothing else
project-specific installed, copies the example environment file, and runs a single
documented command. Application, worker and database all come up. No host-side
package install, no build step run by hand, no "and also start X first".

**Why this priority**: This is the promise the entire development environment
rests on, and the one that gets exercised most — every later slice starts by
running it. If it does not hold, every subsequent slice pays for it daily, and the
demonstration becomes machine-dependent.

**Independent Test**: On a clean checkout with only Docker available, copy the
example environment file and run the documented start command. All three services
reach a running state without further intervention. Delivers a usable development
environment on its own.

**Acceptance Scenarios**:

1. **Given** a clean clone and a copied example environment file, **When** the
   developer runs the documented start command, **Then** application, worker and
   database all reach a running state without any additional manual step.
2. **Given** the system is running, **When** the developer edits an application
   source file, **Then** the change is reflected in the running application
   without rebuilding the image by hand.
3. **Given** a machine with no host toolchain for this project installed, **When**
   the developer follows the README from a clean clone, **Then** every step listed
   is either the start command or an exception already recorded in the deployment
   constraints register.
4. **Given** the system was started once and then stopped, **When** the developer
   starts it again, **Then** it comes back up without manual cleanup of stale
   state.

---

### User Story 2 - Both processes report their own health (Priority: P1)

An operator — locally the developer, in the cloud a container orchestrator — can
ask each process whether it is alive and whether it is ready to do work, and can
tell those two answers apart. The worker answers for itself, not by proxy through
the application.

**Why this priority**: Any container runtime requires it, the constitution
mandates a health endpoint on both processes, and it is the only way the rest of
this slice can be verified at all. It is also what makes the worker visibly a
first-class process rather than a background thread.

**Independent Test**: With the system running, query each process's health
surface and confirm both answer. Stop the database and confirm each process
distinguishes "I am alive" from "I cannot do my work". Delivers supervisable
processes on its own.

**Acceptance Scenarios**:

1. **Given** the system is running, **When** the application's health surface is
   queried, **Then** it reports a healthy status.
2. **Given** the system is running, **When** the worker's health surface is
   queried, **Then** it reports a healthy status independently of the application.
3. **Given** the database is unreachable, **When** either process's health surface
   is queried, **Then** it still answers, reporting itself alive but not ready,
   and names the database as the unmet dependency.
4. **Given** either process is still starting, **When** its health surface is
   queried, **Then** it reports not-ready rather than failing to answer.

---

### User Story 3 - The application container reaches the model provider (Priority: P2)

From inside the running application container — not from the host — the system can
reach the configured OpenAI-compatible model provider and confirm it responds.
The route from container to provider is exercised and written down, so the first
slice that actually calls a model is debugging prompts, not networking.

**Why this priority**: The backlog assigns the oMLX networking question to this
slice, and the constraints register leaves it open pending verification. Deferring
it means slice 4 — the orchestrator, the heart of the demonstration — opens with an
infrastructure problem instead of agent work. It is P2 rather than P1 because the
skeleton is still useful without a reachable provider, which is precisely why the
system must also start without one.

**Independent Test**: With the system running, execute the provider diagnostic
from inside the application container and confirm it reports the provider
reachable. Then stop the provider and confirm the system keeps running and the
diagnostic reports it unreachable. Delivers a closed networking question on its
own.

**Acceptance Scenarios**:

1. **Given** the model provider is running and correctly configured, **When** the
   provider diagnostic is run from inside the application container, **Then** it
   reports the provider as reachable.
2. **Given** the model provider is not running, **When** the system is started,
   **Then** application and worker start normally and both report ready, because
   neither process's readiness depends on the provider.
3. **Given** the provider credential is absent or wrong, **When** the diagnostic is
   run, **Then** it reports failure with the authentication error distinguished
   from a network error.
4. **Given** the working route from container to provider is established, **When**
   a developer reads the deployment constraints register, **Then** it states the
   verified route, the date it was verified, and the fallback if the provider is
   bound to loopback again.

---

### User Story 4 - Every run is configured by environment and legible in logs (Priority: P2)

All configuration reaches both processes as environment variables, validated at
startup so a missing or malformed value fails loudly and immediately instead of
surfacing as a confusing error hours later. Everything either process writes to
its output is a single-line JSON record with a consistent shape, so a run can be
filtered and read after the fact.

**Why this priority**: Both are twelve-factor requirements the architecture
document commits to, and both are far cheaper to establish now than to retrofit
across twelve slices. Log correlation fields become genuinely useful once
conversations exist, but the shape has to be in place before there is anything to
correlate.

**Independent Test**: Start the system with a required variable removed and
confirm the affected process refuses to start with a message naming the variable.
Start it correctly and confirm every emitted line parses as JSON. Delivers
configurable, machine-readable operation on its own.

**Acceptance Scenarios**:

1. **Given** a required environment variable is missing or malformed, **When**
   either process starts, **Then** it exits with a message naming the specific
   variable and what was expected, rather than starting in a broken state.
2. **Given** the system is running normally, **When** the output of either process
   is captured, **Then** every line parses as JSON and carries at least a
   timestamp, level, process identity and message.
3. **Given** a configured log level, **When** either process runs, **Then** records
   below that level are not emitted.
4. **Given** a value that is a secret, **When** the repository is inspected,
   **Then** the value appears only in the example environment file as an empty
   placeholder, never as a committed value.
5. **Given** a request is handled, **When** its log records are inspected, **Then**
   they carry a correlation identifier shared across the records for that request.

---

### Edge Cases

- **Database not yet accepting connections when the application starts.** Postgres
  takes seconds to become ready; the application and worker must wait or retry
  rather than crash-looping into a failed state.
- **Model provider absent, unauthenticated, or bound to loopback.** The system must
  start and stay up. This is the normal state on a machine where the local
  inference server is not running.
- **Observability backend absent.** Constitution principle VII makes telemetry
  fire-and-forget; a system started with no observability configuration at all must
  behave identically, minus the traces.
- **Port already in use on the host.** Fails with a message that identifies the
  conflicting port, not an opaque bind error.
- **Host file-watching events lost on macOS bind mounts.** Recorded in the
  constraints register as a known cost; the fallback must be documented and
  switchable by configuration, not by editing files.
- **Dependencies installed on the host leaking into the container**, or compiled
  artefacts from one leaking into the other. Container-internal build output must
  not be shared with the host filesystem.
- **The worker has no work to do**, because no table it polls exists yet — the
  schema arrives in backlog item 2. It must idle cleanly on its interval and stay
  healthy rather than erroring on every sweep.
- **Stopping and restarting.** Restart must not require deleting volumes or
  clearing state by hand.
- **A stale example environment file.** A variable added to the configuration
  contract but missing from the example file makes the one-command promise false
  on the next clean clone.

## Requirements *(mandatory)*

### Functional Requirements

**Composition and startup**

- **FR-001**: The system MUST define three runnable services — application, worker
  and database — startable together with one documented command.
- **FR-002**: The application and the worker MUST run from the **same image**,
  differing only in the command they are started with.
- **FR-003**: The application and the worker MUST tolerate the database not being
  ready at start, retrying until it is, without entering a failed state.
- **FR-004**: The database MUST retain its data across a stop and start of the
  system, without manual cleanup.
- **FR-005**: The system MUST start successfully with the model provider absent and
  with the observability backend absent, in any combination.
- **FR-006**: Source changes MUST be reflected in the running application without a
  manual image rebuild, and the mechanism for doing so MUST NOT share
  container-internal dependency or build artefacts with the host filesystem.
- **FR-007**: Any step that must run on the host rather than in a container MUST
  have a corresponding entry in the deployment constraints register.

**Health**

- **FR-008**: The application MUST expose a health surface reporting whether the
  process is alive.
- **FR-009**: The worker MUST expose its own health surface, answering
  independently of the application.
- **FR-010**: Each process's health surface MUST distinguish liveness from
  readiness, and MUST name which dependency is unmet when it is not ready.
- **FR-011**: Health surfaces MUST answer within a bounded time even when a
  dependency is unreachable, and MUST NOT be blocked by a hanging dependency.
- **FR-012**: Readiness MUST report the reachability of the database. It MUST NOT
  depend on the model provider: a provider outage leaves both processes able to
  serve their traffic, and failing readiness for it would remove a healthy
  container from rotation. Provider reachability is FR-013's diagnostic instead.

**Model provider reachability**

- **FR-013**: The application MUST be able to reach the configured
  OpenAI-compatible model provider from inside its container, using only
  environment configuration.
- **FR-014**: The provider check MUST be a one-shot diagnostic runnable on demand
  inside the container, and MUST verify reachability without generating a
  completion.
- **FR-015**: A provider check MUST distinguish a network failure from an
  authentication failure in what it reports.
- **FR-016**: The verified container-to-provider route MUST be recorded in the
  deployment constraints register, with the date of verification and the fallback
  to use if the provider becomes unreachable on that route.
- **FR-017**: All provider configuration MUST be reachable through environment
  variables alone, so that pointing the system at a hosted endpoint requires no
  code change.

**Configuration**

- **FR-018**: All configuration MUST be supplied as environment variables. No
  environment-specific value may be hard-coded.
- **FR-019**: Configuration MUST be validated when each process starts; a missing
  or malformed required value MUST stop that process with a message naming the
  variable and the expectation.
- **FR-020**: The example environment file MUST list every variable the system
  reads, with a non-secret default or an empty placeholder, and MUST be complete
  enough that a clean clone starts by copying it.
- **FR-021**: No secret value may be committed to the repository.
- **FR-022**: Configuration values that are optional MUST have documented defaults,
  and their absence MUST NOT stop a process.

**Logging**

- **FR-023**: Both processes MUST write logs to standard output as single-line JSON
  records.
- **FR-024**: Every log record MUST carry at minimum a timestamp, a severity level,
  the identity of the emitting process, and a message.
- **FR-025**: The logging module MUST be the only module that imports the logging
  library, and MUST support attaching child bindings to a record. Correlation
  identifiers are not required in this slice — health checks make no downstream
  calls, so there is nothing to correlate — but the single import point is what
  allows item 4 to add request-scoped context without touching a call site.
- **FR-026**: The minimum severity emitted MUST be configurable by environment
  variable.
- **FR-027**: *Moved to backlog item 2.* A masking seam for personally identifiable
  information has no implementations in this slice — no PII exists and no telemetry
  sink is configured — and the constitution's Governance section rejects a pattern
  with no concrete case. The single masking rule of principle VIII is authored where
  the `leads` schema gives it something to mask.

**Worker**

- **FR-028**: The worker MUST run as its own process with its own entrypoint, and
  MUST NOT depend on the application process being up in order to run.
- **FR-029**: The worker MUST wake on a configurable interval and, finding nothing
  to do, idle without erroring and without leaking resources.
- **FR-030**: The worker MUST shut down cleanly on a termination signal, finishing
  or abandoning its current sweep rather than being killed mid-write.

**Structure**

- **FR-031**: The source layout MUST match the folder structure fixed by the
  architecture document, with placeholder directories where a slice has not landed
  yet, so no later slice has to invent where its code goes.
- **FR-032**: The dependency rule — `app → services → db`, `agent → services`,
  `domain → nothing` — MUST be checkable automatically rather than by inspection
  alone.

**Observability**

- **FR-033**: Observability MUST be wired such that its absence changes nothing
  except that traces are not recorded — no failure, no delay, no error surfaced to
  a user or to a health surface.
- **FR-034**: This slice MUST NOT choose where the observability backend is hosted.
  It ships the fire-and-forget seam of FR-033 and nothing more: the backend is
  selected entirely by environment variable, so that adopting either a self-hosted
  or a hosted instance later is a configuration and composition change with no
  application code impact. `docs/decisoes-pendentes.md` item 3 stays open and is
  re-targeted to backlog item 4, where the span taxonomy is authored and the choice
  finally has to be made.

### Key Entities

This slice introduces no persistent domain data. The data model is backlog item 2.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A developer on a machine with only Docker installed goes from a clean
  clone to a fully running system in under 10 minutes and with exactly one command
  beyond copying the example environment file.
- **SC-002**: Both processes report healthy within 90 seconds of the start command,
  on a cold start with no cached image layers.
- **SC-003**: The system starts and both processes report themselves alive **and
  ready** with the model provider present and with it absent — two of two. The
  observability dimension collapses to one case while FR-034 keeps the backend
  unwired; it returns as a second axis in item 4.
- **SC-004**: 100% of log records emitted by the application itself — everything
  written through the logging module — parse as JSON, verified across a full
  start-idle-stop cycle on both processes. Output written by the framework or the
  package manager is excluded: the development server's banner and npm's script
  echo are not application log records and are not ours to shape. The worker,
  which has no such framing, is 100% JSON end to end.
- **SC-005**: Every environment variable the system reads appears in the example
  environment file — zero variables read but undocumented.
- **SC-006**: Zero secret values are present anywhere in the repository history for
  this slice.
- **SC-007**: Removing any single required configuration value causes the affected
  process to stop within 10 seconds with a message naming that value; verified for
  every required value.
- **SC-008**: The provider diagnostic, run inside the application container after a
  clean start, reports the provider reachable on the first attempt, using only the
  values shipped in the example environment file plus the provider credential.
- **SC-009**: With the database stopped, both health surfaces still answer within 5
  seconds and both name the database as the unmet dependency.
- **SC-010**: A source edit is reflected in the running application within 15
  seconds without a manual rebuild.
- **SC-011**: The worker idles across at least three consecutive sweep intervals
  with no work available, emitting no errors and staying healthy.
- **SC-012**: An automated check fails when a forbidden import is introduced —
  verified by deliberately adding one and observing the failure.
- **SC-013**: The deployment constraints register contains a dated entry for the
  verified container-to-provider route, and no undocumented host-side step remains
  in the startup path.

## Assumptions

- **The oMLX bind restriction recorded on 30/08/2026 has been lifted.** The
  application does offer the option, and the developer has since configured it to
  listen on all interfaces. Verified on 2026-08-31: the server listens on `*:8990`,
  not on loopback alone, and still rejects unauthenticated requests with a 401. The
  direct route from a container is therefore expected to work without a host-side
  port forward. The register has been updated to match — but FR-016 keeps the
  fallback documented, because this is an application setting that can revert.
- **The provider credential is not a placeholder.** The local server requires a key,
  so a clean clone needs one real value supplied by the developer before provider
  reachability can succeed. Everything else in the example file is a working
  default.
- **The database container runs Postgres but this slice defines no schema.** Tables,
  migrations and seed data are backlog item 2. Readiness here means the connection
  succeeds, not that any table exists.
- **Health surfaces are HTTP for both processes.** The worker is not otherwise an
  HTTP server; it gains a minimal listener purely to satisfy the constitution's
  requirement that both processes expose a health endpoint, because that is what a
  container orchestrator can consume.
- **The provider diagnostic lists available models** rather than generating a
  completion — enough to prove the route and the credential, cheap enough to run
  freely.
- **No authentication is required on the health surfaces.** They expose no lead
  data. Authentication is backlog item 3 and applies to the dashboard.
- **The host's own Node.js version is irrelevant.** Everything runs in containers;
  the version installed on this machine is old and will not be used.
- **Cloud deployment is out of scope**, per the backlog's *Requirements not yet
  mapped* table. What this slice guarantees is container parity, not a deployment.

## Out of Scope

Named explicitly so the slice does not grow while it is being built:

- Any database schema, migration or seed data — backlog item 2.
- Any authentication, login screen or user — backlog item 3.
- Any agent, prompt, slot machine, tool or model call beyond a reachability probe —
  backlog item 4.
- Any lead-facing or broker-facing screen. The application serves a placeholder
  landing page only; the chat widget is item 5 and the dashboard is item 8.
- Any job, queue table or follow-up logic. The worker sweeps and finds nothing;
  `JobQueue` and its implementations arrive with the slices that need them.
- The concrete observability span taxonomy, which constitution principle VII
  assigns to the orchestrator specification — item 4. The hosting of the
  observability backend goes with it, by the decision recorded in FR-034.
- A CI pipeline, and deployment to any cloud environment.
