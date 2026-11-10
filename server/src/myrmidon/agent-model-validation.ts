import type { Db } from "@myrmidon/db";
import { listAdapterModels } from "../adapters/registry.js";
import { unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { effortForModel } from "./effort-policy/effort-policy.js";
import { enrichWithPoolModels } from "./model-providers/pool-models.js";

/**
 * myrmidon(S4/M1): a model that is not in the adapter's model list is
 * rejected when the agent card is saved.
 *
 * The list is the one the adapter serves to the UI
 * (`GET /companies/:id/adapters/:type/models`), which includes the instance
 * admin list from `PAPERCLIP_ADAPTER_MODELS`. When the list is empty (Hermes
 * without an admin list, the process adapter) any name is accepted.
 */

/** Values that mean "let the adapter decide" and are never rejected. */
export const ADAPTER_SPECIAL_MODEL_VALUES: readonly string[] = ["default", "auto"];

/**
 * Adapters whose model list depends on something other than the adapter
 * type (provider, remote catalog) or that validate models themselves.
 */
const ADAPTERS_WITHOUT_STATIC_MODEL_LIST: readonly string[] = [
  // Validated by the adapter itself against `opencode models`, and the
  // OpenRouter catalog is provider-specific.
  "opencode_local",
  // The list depends on adapterConfig.provider.
  "paperclip_runner",
];

/** Model fields of the card (M1): single values. */
export const AGENT_CARD_MODEL_FIELDS: readonly string[] = [
  "model",
  "models.vision",
  "models.video",
  "models.stt",
  "models.tts",
];

/** Model fields of the card (M1): ordered lists. */
export const AGENT_CARD_MODEL_LIST_FIELDS: readonly string[] = ["models.fallbacks"];

/**
 * myrmidon(BOT-TUNING-C): adapters whose card carries the Hermes
 * "Thinking effort" field (`adapterConfig.effort`) that this validation
 * applies to. Other adapters use their own level sets and are untouched.
 */
const EFFORT_VALIDATED_ADAPTER_TYPES: readonly string[] = ["hermes_local"];

/**
 * myrmidon(BOT-TUNING-C): a saved card is rejected (422) when the selected
 * model does not accept the declared effort — a silently dropped value makes
 * the runtime send a default the model refuses (e.g. GLM vs "medium") and the
 * LLM gateway then falls back to a different model on every call. An empty
 * effort is fine: it resolves to the model's safe default at compile time.
 */
export function assertAgentEffortAccepted(
  adapterType: string,
  nextAdapterConfig: Record<string, unknown> | null | undefined,
): void {
  if (!EFFORT_VALIDATED_ADAPTER_TYPES.includes(adapterType)) return;
  const effort = nextAdapterConfig?.effort;
  if (typeof effort !== "string" || effort.trim().length === 0) return;
  const model =
    typeof nextAdapterConfig?.model === "string" ? nextAdapterConfig.model : undefined;
  const resolved = effortForModel(model, effort);
  if (resolved.source === "invalid") {
    throw unprocessable(
      `Model "${model ?? ""}" does not accept effort "${effort.trim()}" (accepted: ${resolved.efforts.join(", ")}).`,
      { code: "invalid_effort", adapterType, model: model ?? null, effort: effort.trim(), accepted: resolved.efforts },
    );
  }
}


function readPath(config: Record<string, unknown> | null | undefined, path: string): unknown {
  let current: unknown = config;
  for (const part of path.split(".")) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function normalizedModelNames(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && !ADAPTER_SPECIAL_MODEL_VALUES.includes(item.toLowerCase()));
}

/** Model names on the card that are new compared to the stored card. */
export function collectChangedModelNames(
  previous: Record<string, unknown> | null | undefined,
  next: Record<string, unknown> | null | undefined,
): Array<{ field: string; model: string }> {
  const changed: Array<{ field: string; model: string }> = [];
  for (const field of [...AGENT_CARD_MODEL_FIELDS, ...AGENT_CARD_MODEL_LIST_FIELDS]) {
    const before = new Set(normalizedModelNames(readPath(previous, field)));
    for (const model of normalizedModelNames(readPath(next, field))) {
      if (!before.has(model)) changed.push({ field: `adapterConfig.${field}`, model });
    }
  }
  return changed;
}

/**
 * myrmidon(OPE-12633 OMP-MODEL-IDS): omp addresses a model as
 * `<provider>/<model>`, where the provider is a key of the agent's custom
 * provider config (MYRMIDON_OMP_PROVIDERS, deprecated alias
 * PAPERCLIP_OMP_PROVIDERS). The board's list holds the gateway names
 * (`antigravity/gemini-3.8-flash-medium`), so the only working omp id
 * (`litellm/antigravity/gemini-3.8-flash-medium`) was refused on save and the
 * card could only be repaired in the database. A name is accepted when it is
 * one of these provider keys followed by a known gateway model.
 */
const OMP_PROVIDER_ENV_NAMES = ["MYRMIDON_OMP_PROVIDERS", "PAPERCLIP_OMP_PROVIDERS"] as const;

export function ompCustomProviderKeys(adapterConfig: Record<string, unknown> | null | undefined): string[] {
  const env = adapterConfig?.env;
  if (!env || typeof env !== "object" || Array.isArray(env)) return [];
  for (const name of OMP_PROVIDER_ENV_NAMES) {
    const entry = (env as Record<string, unknown>)[name];
    const raw = typeof entry === "string"
      ? entry
      : entry && typeof entry === "object" && (entry as { type?: unknown }).type === "plain"
        ? (entry as { value?: unknown }).value
        : undefined;
    if (typeof raw !== "string" || raw.trim().length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
      return Object.keys(parsed).filter((key) => key.length > 0 && !key.includes("/"));
    } catch {
      return [];
    }
  }
  return [];
}

function isKnownModelName(model: string, knownIds: Set<string>, providerPrefixes: string[]): boolean {
  if (knownIds.has(model)) return true;
  return providerPrefixes.some((key) => model.startsWith(`${key}/`) && knownIds.has(model.slice(key.length + 1)));
}

export async function assertAgentModelsKnown(input: {
  adapterType: string;
  previousAdapterConfig: Record<string, unknown> | null | undefined;
  nextAdapterConfig: Record<string, unknown> | null | undefined;
  listModels?: (adapterType: string) => Promise<Array<{ id: string }>>;
  companyId?: string;
  db?: Db;
}): Promise<void> {
  assertAgentEffortAccepted(input.adapterType, input.nextAdapterConfig);
  if (ADAPTERS_WITHOUT_STATIC_MODEL_LIST.includes(input.adapterType)) return;
  // Switching adapters starts from an empty card: every model is new.
  const changed = collectChangedModelNames(input.previousAdapterConfig, input.nextAdapterConfig);
  if (changed.length === 0) return;

  let known: Array<{ id: string }>;
  try {
    const baseKnown = await (input.listModels ?? listAdapterModels)(input.adapterType);
    known = input.companyId && input.db
      ? await enrichWithPoolModels(input.db, input.companyId, baseKnown as any)
      : baseKnown;
  } catch (err) {
    // Model discovery failing must not make every agent uneditable.
    logger.warn({ err, adapterType: input.adapterType }, "model list unavailable; skipping model validation");
    return;
  }
  if (known.length === 0) return;
  const knownIds = new Set(known.map((model) => model.id));
  const providerPrefixes = input.adapterType === "omp_local" ? ompCustomProviderKeys(input.nextAdapterConfig) : [];
  const unknown = changed.filter((entry) => !isKnownModelName(entry.model, knownIds, providerPrefixes));
  if (unknown.length === 0) return;
  throw unprocessable(
    `Unknown model for adapter ${input.adapterType}: ${unknown
      .map((entry) => `${entry.field}="${entry.model}"`)
      .join(", ")}. Choose a model from the adapter model list.`,
    { code: "unknown_model", adapterType: input.adapterType, unknownModels: unknown },
  );
}
