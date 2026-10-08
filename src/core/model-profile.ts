import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";

/**
 * A model profile: everything about one model on one endpoint, in a YAML file
 * under `config/models/` (constitution VI as amended 08/10/2026, ADR 23).
 *
 * `.env` names the profile (`MODEL_PROFILE`) and holds the secrets; the profile
 * holds the rest. A profile never carries a secret itself: it names the
 * environment key its API key is read from, and may do the same for its base
 * URL. Those keys must be declared in the config schema, so the Environment
 * Contract (`.env.example` ↔ schema) still covers every value a profile reads.
 */

/**
 * `reasoning_effort` stops at `low` (developer, 08/10/2026): a model that needs
 * more than that to follow the script is the wrong model, and the answer is a
 * different profile rather than a bigger budget.
 */
export const REASONING_EFFORTS = ["none", "minimal", "low"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

const envKey = z.string().regex(/^[A-Z][A-Z0-9_]*$/, "an environment key, like AZURE_OPENAI_API_KEY");
const ceiling = z.number().int().positive();

const profileSchema = z
  .object({
    base_url: z.url().optional(),
    base_url_env: envKey.optional(),
    api_key_env: envKey,
    // Header carrying the key when the endpoint refuses `Authorization: Bearer`.
    auth_header: z.string().min(1).optional(),
    model: z.string().min(1),
    // oMLX's switch: `chat_template_kwargs.enable_thinking`.
    thinking: z.boolean().default(false),
    // OpenAI's: sent as `reasoning_effort`.
    reasoning_effort: z.enum(REASONING_EFFORTS).optional(),
    // Reasoning tokens count against both: the API has one ceiling per call,
    // not one for the reasoning and another for the answer.
    max_output_tokens: z.object({ reply: ceiling, extraction: ceiling }).strict(),
  })
  .strict()
  .refine((profile) => (profile.base_url === undefined) !== (profile.base_url_env === undefined), {
    message: "exactly one of base_url and base_url_env",
  });

export interface ModelProfile {
  name: string;
  baseUrl: string;
  apiKey: string;
  authHeader?: string;
  modelId: string;
  thinking: boolean;
  reasoningEffort?: ReasoningEffort;
  maxOutputTokens: { reply: number; extraction: number };
}

export const PROFILE_NAME = /^[a-z0-9][a-z0-9_]*$/;

/**
 * Reads and resolves one profile. `env` supplies the keys the profile names,
 * and `declared` is the schema's key set: a profile may only read a key the
 * Environment Contract knows about. Throws with every problem in one message.
 */
export function loadModelProfile(
  name: string,
  directory: string,
  env: Record<string, string>,
  declared: readonly string[],
): ModelProfile {
  if (!PROFILE_NAME.test(name)) {
    throw new Error(`MODEL_PROFILE: "${name}" is not a profile name (lowercase letters, digits and _)`);
  }
  const file = path.resolve(directory, `${name}.yaml`);

  let raw: unknown;
  try {
    raw = parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`MODEL_PROFILE: cannot read ${file}: ${(error as Error).message}`);
  }

  const parsed = profileSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
    throw new Error(`MODEL_PROFILE ${name}: ${problems.join("; ")}`);
  }
  const profile = parsed.data;

  const problems: string[] = [];
  const read = (key: string): string => {
    if (!declared.includes(key)) problems.push(`${key} is not a key the config schema declares`);
    else if (env[key] === undefined) problems.push(`${key} is not set`);
    return env[key] ?? "";
  };
  const apiKey = read(profile.api_key_env);
  const baseUrl = profile.base_url ?? read(profile.base_url_env as string);
  if (problems.length === 0 && !z.url().safeParse(baseUrl).success) {
    problems.push(`${profile.base_url_env} is not a URL`);
  }
  if (problems.length > 0) throw new Error(`MODEL_PROFILE ${name}: ${problems.join("; ")}`);

  return {
    name,
    baseUrl,
    apiKey,
    ...(profile.auth_header === undefined ? {} : { authHeader: profile.auth_header }),
    modelId: profile.model,
    thinking: profile.thinking,
    ...(profile.reasoning_effort === undefined ? {} : { reasoningEffort: profile.reasoning_effort }),
    maxOutputTokens: profile.max_output_tokens,
  };
}
