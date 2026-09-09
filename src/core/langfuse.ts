import type { Telemetry, TelemetryOptions } from "ai";
import { getConfig } from "./config.ts";
import { createLogger, type ProcessName } from "./logging.ts";
import { maskName, maskPII } from "./security.ts";

/**
 * The only module in the repository that knows Langfuse or OpenTelemetry exist.
 *
 * ADR 13 and `contracts/observability.md`: spans are produced around the model
 * calls, `@langfuse/otel`'s span processor exports them, and `maskPII` — the
 * same function `core/logging.ts` installs on the log sink — is the processor's
 * mask, so principle VIII has one definition and two sinks.
 *
 * **Absent changes nothing.** When any of `LANGFUSE_PUBLIC_KEY`,
 * `LANGFUSE_SECRET_KEY` or `LANGFUSE_BASE_URL` is missing, no tracer provider is
 * registered, no telemetry integration is installed, and the three OpenTelemetry
 * packages are never even imported — hence the dynamic `import()` below rather
 * than a top-level one. That is the cheapest possible form of the constitution's
 * rule that telemetry never blocks or fails a reply (principle VII/IX), and it
 * is the state the demo runs in most of the time: the `observability` Compose
 * profile is off by default.
 *
 * The same rule applies once it *is* configured. Every entry point here is
 * wrapped so that a broken exporter, an unreachable Langfuse or a bug in this
 * file costs a turn one `warn` line and nothing else. Nothing in this module
 * ever rethrows.
 *
 * **A note on the AI SDK.** Up to v5 `experimental_telemetry` emitted
 * OpenTelemetry spans by itself and Langfuse only had to export them. AI SDK 7
 * replaced that with a callback interface (`Telemetry`, `registerTelemetry`) and
 * emits no spans at all — verified against the installed `ai@7.0.93`, which does
 * not import `@opentelemetry/*` anywhere. So the translation from the SDK's
 * lifecycle events to Langfuse observations lives here, which is where the
 * contract wanted the OpenTelemetry knowledge anyway.
 */

type LangfuseTracing = typeof import("@langfuse/tracing");
type Generation = import("@langfuse/tracing").LangfuseGeneration;

interface Registration {
  tracing: LangfuseTracing;
  flush: (timeoutMs: number) => Promise<void>;
}

/**
 * The registration lives on `globalThis`, not in a module-level `let`.
 *
 * Next bundles `src/instrumentation.ts` separately from the route handlers, so
 * the module instance that runs `registerLangfuse` is **not** the instance a
 * turn imports — a plain module variable is set in one graph and still `null`
 * in the other. That failure is silent and looks exactly like "Langfuse is not
 * configured": the model spans arrive (the AI SDK's own integration registry is
 * process-global) while the turn trace, its attributes and `events.trace_id`
 * are all missing. Measured on 09/09/2026, then fixed here.
 */
const STATE = Symbol.for("sdr.core.langfuse");

interface State {
  registration: Registration | null;
  attempted: boolean;
}

function state(): State {
  const container = globalThis as unknown as Record<symbol, State | undefined>;
  container[STATE] ??= { registration: null, attempted: false };
  return container[STATE];
}

let log = createLogger("app", { module: "core/langfuse" });

/** The bound on every shutdown flush: a slow exporter must not delay an exit. */
const FLUSH_TIMEOUT_MS = 2_000;

/**
 * The three-key gate of `contracts/observability.md`, and the off switch for
 * everything in this file. `LANGFUSE_UI_PORT` is deliberately not part of it —
 * only the Compose file reads that one.
 */
export function isLangfuseConfigured(): boolean {
  const config = getConfig();
  return (
    config.LANGFUSE_PUBLIC_KEY !== undefined &&
    config.LANGFUSE_SECRET_KEY !== undefined &&
    config.LANGFUSE_BASE_URL !== undefined
  );
}

/**
 * Names to redact from free text, and why this exists at all.
 *
 * `maskPII` recognises a name by the **key** above it, which is the only way a
 * bare string can be known to be a name. That leaves the case SC-011 cares
 * about: a lead who writes "meu nome é Camila Duarte" puts their name in a
 * message body, and the body is what the prompt and the completion carry. No
 * rule can pick a Brazilian surname out of a sentence — but this system does
 * not need one, because by then it knows the name: it is a slot.
 *
 * So the turn registers the name it holds and the span mask redacts exactly
 * that string, in the same `C*** D***` shape `maskPII` produces, wherever it
 * appears. Bounded, because the process is long-lived and this is a demo.
 *
 * The residual, stated plainly: on the single turn where a name is first typed,
 * the extraction prompt is built before anything knows a name is in it. Every
 * later turn, and every span that names the lead as data, is covered.
 */
const MAX_REMEMBERED_NAMES = 200;

/**
 * On `globalThis` for the same reason the registration is (see `state()`): the
 * orchestrator that registers a name and the span processor that redacts it are
 * in two different module instances under Next's bundling. A plain module-level
 * Map is written in one and read, empty, in the other — and the failure is
 * invisible, because everything else about the mask keeps working.
 */
const REDACTIONS = Symbol.for("sdr.core.langfuse.redactions");

function redactions(): Map<string, string> {
  const container = globalThis as unknown as Record<symbol, Map<string, string> | undefined>;
  container[REDACTIONS] ??= new Map<string, string>();
  return container[REDACTIONS];
}

export function rememberLeadName(name: string | null | undefined): void {
  if (typeof name !== "string") return;
  const known = redactions();
  for (const word of [name, ...name.trim().split(/\s+/)]) {
    const trimmed = word.trim();
    // Two-letter fragments are not worth redacting and would shred ordinary
    // text; the full name is always registered whatever its length.
    if (trimmed.length < 3 && trimmed !== name.trim()) continue;
    if (trimmed === "" || known.has(trimmed)) continue;
    if (known.size >= MAX_REMEMBERED_NAMES) {
      const oldest = known.keys().next();
      if (!oldest.done) known.delete(oldest.value);
    }
    known.set(trimmed, maskName(trimmed));
  }
}

/** Exposed for the tests; the process keeps its registry otherwise. */
export function forgetLeadNames(): void {
  redactions().clear();
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactKnownNames(text: string): string {
  const known = redactions();
  if (known.size === 0) return text;
  let result = text;
  // Longest first, so "Camila Duarte" is replaced whole rather than leaving
  // "C*** Duarte" behind from a single-word pass.
  for (const [name, masked] of [...known].sort((a, b) => b[0].length - a[0].length)) {
    if (!result.includes(name)) continue;
    result = result.replace(new RegExp(escapeForRegExp(name), "g"), masked);
  }
  return result;
}

/**
 * The span mask.
 *
 * `maskPII` is key-aware — it masks a value because of the key above it, which
 * is the only way a bare name like "Camila Duarte" can be recognised as a name
 * at all. But the AI SDK hands OpenTelemetry its payloads **already serialized**:
 * tool arguments, prompts and completions arrive as JSON *strings*, and a string
 * reaching `maskPII` is treated as free text, where only phone- and e-mail-shaped
 * substrings are recognised. The observable result was a span reading
 * `{"name": "Camila Duarte", "contact": "(11) *****-**21"}` — the phone masked by
 * its shape, the name beside it untouched, under a key literally called `name`.
 *
 * So: parse first when the payload is JSON, mask the structure, re-serialize.
 * Anything that is not JSON is free text and goes through exactly as before.
 */
export function maskSpanData(data: unknown): unknown {
  if (typeof data !== "string") return redactDeep(maskPII(data));

  const trimmed = data.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return redactKnownNames(maskPII(data));
  }

  try {
    // The masked forms carry no JSON-special characters, so redacting the
    // serialized form is safe and reaches every nested string in one pass.
    return redactKnownNames(JSON.stringify(maskPII(JSON.parse(trimmed))));
  } catch {
    // Not JSON after all — a reply that merely opens with a brace, say.
    return redactKnownNames(maskPII(data));
  }
}

/** `redactKnownNames` over every string in a structure the mask was handed. */
function redactDeep(value: unknown): unknown {
  if (typeof value === "string") return redactKnownNames(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value !== null && typeof value === "object" && value.constructor === Object) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactDeep(v)]),
    );
  }
  return value;
}

/** Telemetry degrades, never propagates (principle IX). */
function safely(what: string, action: () => void): void {
  try {
    action();
  } catch (error) {
    log.warn({ err: (error as Error).message, what }, "telemetry failed, turn unaffected");
  }
}

/** Contract §2 wants the provider host, never the full URL with its key. */
function providerHost(): string {
  try {
    return new URL(getConfig().PROVIDER_BASE_URL).host;
  } catch {
    return "unknown";
  }
}

/**
 * Principle VIII: the raw lead uuid is never the trace's user id on its own.
 * The first segment is enough to follow one lead across their own traces and
 * not enough to join them back to a row without the database.
 */
function maskedLeadId(leadId: string): string {
  return `lead-${leadId.slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Called once per process, from `src/instrumentation.ts` and from
 * `src/worker/index.ts` (T049). Idempotent, and a no-op — including the imports
 * — unless all three keys are present.
 */
export async function registerLangfuse(process: ProcessName): Promise<void> {
  if (state().attempted) return;
  state().attempted = true;
  log = createLogger(process, { module: "core/langfuse" });

  const config = getConfig();
  const publicKey = config.LANGFUSE_PUBLIC_KEY;
  const secretKey = config.LANGFUSE_SECRET_KEY;
  const baseUrl = config.LANGFUSE_BASE_URL;
  if (publicKey === undefined || secretKey === undefined || baseUrl === undefined) {
    log.info("langfuse keys absent, tracing disabled");
    return;
  }

  try {
    const [{ NodeTracerProvider }, { LangfuseSpanProcessor }, tracing, { registerTelemetry }] =
      await Promise.all([
        import("@opentelemetry/sdk-trace-node"),
        import("@langfuse/otel"),
        import("@langfuse/tracing"),
        import("ai"),
      ]);

    const processor = new LangfuseSpanProcessor({
      publicKey,
      secretKey,
      baseUrl,
      // FR-031 / principle VIII: one masking rule, both sinks. Everything a span
      // carries — the prompt, the reply, tool arguments — goes through the same
      // function the logger uses.
      mask: ({ data }) => maskSpanData(data),
      environment: config.NODE_ENV,
    });

    const provider = new NodeTracerProvider({ spanProcessors: [processor] });
    // `register()` also installs the AsyncLocalStorage context manager, which is
    // what makes the turn's span the parent of the model spans across awaits.
    provider.register();
    tracing.setLangfuseTracerProvider(provider);
    registerTelemetry(aiSdkIntegration(tracing));

    state().registration = {
      tracing,
      flush: async (timeoutMs) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const bound = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        });
        try {
          await Promise.race([provider.shutdown(), bound]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      },
    };

    log.info({ baseUrl }, "langfuse tracing registered");
  } catch (error) {
    // A missing package or a bad key must not stop a process from starting.
    log.warn({ err: (error as Error).message }, "langfuse registration failed, tracing disabled");
    state().registration = null;
  }
}

/**
 * Flushes what is batched, with a bound. `contracts/observability.md` §5: a
 * failed flush does not delay shutdown, so the timeout wins the race and the
 * pending batch is simply lost — which is the correct trade for telemetry.
 */
export async function flushLangfuse(timeoutMs: number = FLUSH_TIMEOUT_MS): Promise<void> {
  const active = state().registration;
  if (active === null) return;
  state().registration = null;
  try {
    await active.flush(timeoutMs);
  } catch (error) {
    log.warn({ err: (error as Error).message }, "langfuse flush failed on shutdown");
  }
}

// ---------------------------------------------------------------------------
// The trace of one turn (contract §1)
// ---------------------------------------------------------------------------

export interface TurnTraceAttributes {
  agencyId: string;
  leadId: string;
  conversationId: string;
  channel: string;
  intent: string;
  /** The slot the deterministic question targets, when there is one. */
  pendingSlot: string | null;
  /**
   * The lead's name as the conversation already holds it, registered for
   * redaction from this turn's prompts and completions. Never becomes a span
   * attribute — it is the one thing here that must not be traced.
   */
  leadName: string | null;
}

/** What the turn learns about itself on the way out (contract §1). */
export interface TurnOutcome {
  score: number;
  stage: string;
  outcome: string;
}

export interface TurnTrace {
  /** This turn's Langfuse trace id, or `null` when nothing is registered. */
  traceId: string | null;
  /** Recorded on the trace once the turn knows how it ended. */
  finish: (outcome: TurnOutcome) => void;
}

const NO_TRACE: TurnTrace = { traceId: null, finish: () => {} };

/**
 * Wraps one whole turn in the `conversation.turn` trace of contract §1, and
 * hands the caller the trace id so every `events` row it writes can carry it
 * (FR-050). With Langfuse unconfigured this is `fn(NO_TRACE)` and nothing else —
 * no span, no context, no allocation worth the name.
 *
 * The attributes go on the trace through `propagateAttributes`, so every child
 * span inherits them exactly as the contract's table promises, rather than each
 * call site having to repeat them.
 */
export async function withTurnTrace<T>(
  attributes: TurnTraceAttributes,
  fn: (trace: TurnTrace) => Promise<T>,
): Promise<T> {
  // Before anything is traced: the name this turn's prompts will contain has to
  // be redactable by the time the spans are exported.
  rememberLeadName(attributes.leadName);

  const active = state().registration;
  if (active === null) return fn(NO_TRACE);

  const { tracing } = active;
  // Once the turn's own function has been entered, an exception is the turn's
  // and belongs to the caller. Before that, it is this file's, and the turn
  // simply runs untraced — telemetry never fails a reply (principle VII).
  let entered = false;

  try {
    return await tracing.propagateAttributes(
      {
        // Contract §1's Name row. Without it every row in Langfuse's trace list
        // is blank and the turns are told apart only by their timestamps: the
        // root span carries the name, but the trace does not inherit it.
        traceName: "conversation.turn",
        sessionId: attributes.conversationId,
        userId: maskedLeadId(attributes.leadId),
        metadata: {
          "agency.id": attributes.agencyId,
          "lead.id": attributes.leadId,
          "conversation.id": attributes.conversationId,
          channel: attributes.channel,
        },
      },
      () =>
        tracing.startActiveObservation(
          "conversation.turn",
          async (span) => {
            const trace: TurnTrace = {
              traceId: span.traceId,
              finish: (outcome) =>
                safely("turn outcome", () => {
                  span.update({
                    metadata: {
                      "turn.score": outcome.score,
                      "turn.stage": outcome.stage,
                      "turn.outcome": outcome.outcome,
                    },
                  });
                }),
            };
            safely("turn attributes", () => {
              span.update({
                metadata: {
                  "turn.intent": attributes.intent,
                  "turn.pending_slot": attributes.pendingSlot ?? "none",
                },
              });
            });
            entered = true;
            return fn(trace);
          },
          { asType: "agent" },
        ),
    );
  } catch (error) {
    if (entered) throw error;
    log.warn({ err: (error as Error).message }, "could not start the turn trace, running untraced");
    return fn(NO_TRACE);
  }
}

// ---------------------------------------------------------------------------
// The model calls (contract §2)
// ---------------------------------------------------------------------------

/**
 * The telemetry option every model call carries (T050), meant to be spread:
 *
 *   streamText({ ...modelCall(), ...modelTelemetry("model.reply"), … })
 *
 * `functionId` becomes the span name, and the agency, lead and conversation
 * attributes reach the span through the turn's context rather than being
 * repeated at each call site. With Langfuse unconfigured this spreads nothing.
 */
export function modelTelemetry(name: string): { experimental_telemetry?: TelemetryOptions } {
  if (state().registration === null) return {};
  return { experimental_telemetry: { isEnabled: true, functionId: name } };
}

/**
 * Translates the AI SDK's telemetry callbacks into Langfuse generations. One
 * span per provider call, which for this agent is one per `streamText` /
 * `generateObject` — the loop never takes a second step, because the tools are
 * invoked from code (`agent/tools/index.ts`).
 */
function aiSdkIntegration(tracing: LangfuseTracing): Telemetry {
  const open = new Map<string, { generation: Generation; startedAt: number }>();

  return {
    onLanguageModelCallStart(event) {
      safely("model call start", () => {
        if (event.functionId === undefined) {
          // Not a span the taxonomy has: a call that reached the model without
          // `modelTelemetry(...)`, or — the way this actually happened — with a
          // `modelTelemetry` that returned nothing because it read a different
          // module instance's registration. Twelve `model.call` spans were the
          // only visible symptom of that bug. Say so rather than name it and
          // move on.
          log.warn("a model call carried no functionId; tracing it as model.call");
        }

        const generation = tracing.startObservation(
          event.functionId ?? "model.call",
          {
            model: event.modelId,
            input: { instructions: event.instructions, messages: event.messages },
            metadata: {
              "model.id": event.modelId,
              "provider.base_url": providerHost(),
            },
          },
          { asType: "generation" },
        );
        open.set(event.callId, { generation, startedAt: Date.now() });
      });
    },

    onLanguageModelCallEnd(event) {
      safely("model call end", () => {
        const started = open.get(event.callId);
        if (started === undefined) return;
        open.delete(event.callId);
        // `cache_read` is the prefix-cache hit the lead brief asks us to watch:
        // oMLX reports `prompt_tokens_details.cached_tokens`, and a turn whose
        // shared prefix is stable should show most of its input tokens here.
        // Both extra keys are omitted rather than sent as zero, so a provider
        // that does not report them leaves no misleading row in Langfuse.
        const cacheRead = event.usage.inputTokenDetails?.cacheReadTokens;
        const reasoning = event.usage.outputTokenDetails?.reasoningTokens;

        started.generation
          .update({
            output: event.content,
            usageDetails: {
              input: event.usage.inputTokens ?? 0,
              output: event.usage.outputTokens ?? 0,
              total: event.usage.totalTokens ?? 0,
              ...(cacheRead === undefined ? {} : { cache_read: cacheRead }),
              ...(reasoning === undefined ? {} : { reasoning: reasoning }),
            },
            metadata: {
              "latency.ms": Math.round(event.performance.responseTimeMs),
              "finish.reason": event.finishReason,
            },
          })
          .end();
      });
    },
  };
}

// ---------------------------------------------------------------------------
// The tool calls (contract §2)
// ---------------------------------------------------------------------------

export interface ToolSpan {
  /** `updateSlots`, `searchProperties`, `requestHandoff`, `optOut`, … */
  name: string;
  /** The call's own arguments; masked by the span processor like everything else. */
  attributes: Record<string, unknown>;
}

/**
 * Records the tool invocations of one turn, as `tool.<name>` spans.
 *
 * Contract §2 expected these from the AI SDK's tool instrumentation, but this
 * agent never lets the model *execute* a tool: `searchProperties`,
 * `proposeMeeting` and the rest are decided in code and invoked from
 * `agent/orchestrator.ts`, so the SDK has nothing to instrument. They are
 * written here instead, from the same list `commitTurn` persists — one place,
 * every commit path, and the span set the contract asks for.
 */
export function recordToolSpans(calls: readonly ToolSpan[]): void {
  const active = state().registration;
  if (active === null || calls.length === 0) return;
  const { tracing } = active;
  for (const call of calls) {
    safely("tool span", () => {
      tracing
        .startObservation(`tool.${call.name}`, { input: call.attributes }, { asType: "tool" })
        .end();
    });
  }
}
