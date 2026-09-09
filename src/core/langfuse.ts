import type { Telemetry, TelemetryOptions } from "ai";
import { getConfig } from "./config.ts";
import { createLogger, type ProcessName } from "./logging.ts";
import { maskPII } from "./security.ts";

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

let registration: Registration | null = null;
let attempted = false;
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
  if (attempted) return;
  attempted = true;
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
      mask: ({ data }) => maskPII(data),
      environment: config.NODE_ENV,
    });

    const provider = new NodeTracerProvider({ spanProcessors: [processor] });
    // `register()` also installs the AsyncLocalStorage context manager, which is
    // what makes the turn's span the parent of the model spans across awaits.
    provider.register();
    tracing.setLangfuseTracerProvider(provider);
    registerTelemetry(aiSdkIntegration(tracing));

    registration = {
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
    registration = null;
  }
}

/**
 * Flushes what is batched, with a bound. `contracts/observability.md` §5: a
 * failed flush does not delay shutdown, so the timeout wins the race and the
 * pending batch is simply lost — which is the correct trade for telemetry.
 */
export async function flushLangfuse(timeoutMs: number = FLUSH_TIMEOUT_MS): Promise<void> {
  const active = registration;
  if (active === null) return;
  registration = null;
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
  const active = registration;
  if (active === null) return fn(NO_TRACE);

  const { tracing } = active;
  // Once the turn's own function has been entered, an exception is the turn's
  // and belongs to the caller. Before that, it is this file's, and the turn
  // simply runs untraced — telemetry never fails a reply (principle VII).
  let entered = false;

  try {
    return await tracing.propagateAttributes(
      {
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
  if (registration === null) return {};
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
        started.generation
          .update({
            output: event.content,
            usageDetails: {
              input: event.usage.inputTokens ?? 0,
              output: event.usage.outputTokens ?? 0,
              total: event.usage.totalTokens ?? 0,
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
  if (registration === null || calls.length === 0) return;
  const { tracing } = registration;
  for (const call of calls) {
    safely("tool span", () => {
      tracing
        .startObservation(`tool.${call.name}`, { input: call.attributes }, { asType: "tool" })
        .end();
    });
  }
}
