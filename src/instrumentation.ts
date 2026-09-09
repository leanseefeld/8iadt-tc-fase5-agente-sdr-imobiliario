/**
 * Runs once when the Next.js server starts.
 *
 * Without this the configuration would first be parsed by whichever request
 * happened to need it, which is not what "validated at startup" means — a
 * misconfigured application would look healthy until someone used it.
 *
 * It is also where tracing is registered (T049). `registerLangfuse` is a no-op
 * — imports included — unless all three `LANGFUSE_*` keys are set, so the
 * application starts identically with the `observability` profile down, which
 * is how the demo usually runs.
 *
 * Everything real lives in `instrumentation.node.ts` and is reached through a
 * dynamic import, because Next compiles this file for the Edge runtime too and
 * a static import would drag Node-only code in there whatever the guard says.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { registerNode } = await import("./instrumentation.node");
  await registerNode();
}
