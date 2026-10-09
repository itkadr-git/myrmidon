// myrmidon(X8c): the "which value can this chat pick" toolkit shared by
// /model and /think — candidate lists, argument resolution and formatting.
// myrmidon(1.7-TG-LOCALE): prose lives only in the ../locales catalogs
// (keyed text, rendered in the chat owner's locale); command names, model
// ids and reasoning levels stay here as data.

import { listAdapterModels } from "../../../adapters/registry.js";
import { ADAPTER_SPECIAL_MODEL_VALUES } from "../../agent-model-validation.js";
// myrmidon(F06-A): the reasoning-effort policy of a model — /think must not
// write an effort the model refuses (see effortPolicyRefusal below).
import { effortsForModel } from "../../effort-policy/effort-policy.js";
import { t, type BridgeLocale } from "../locales/index.js";
import type { BridgeTextKey } from "../locales/en.js";
import type { BridgedCommandAgentContext } from "./context.js";

/**
 * "default" / "auto" (ADAPTER_SPECIAL_MODEL_VALUES, agent-model-validation.ts)
 * mean "let the adapter decide" on the card — they are a valid card value,
 * not a real model name, so /model and /think must never list or report
 * them as if a specific model were chosen.
 */
function isSpecialModelValue(value: string): boolean {
  return ADAPTER_SPECIAL_MODEL_VALUES.includes(value.trim().toLowerCase());
}

export interface ChatModelCandidate {
  id: string;
  label: string;
  /**
   * myrmidon(F06-A): the provider family of a gateway model id
   * (`dashscope-qwen3-max` → `dashscope`), used to group the rendered list.
   * Absent for the card's own values and for ids without a known prefix.
   */
  provider?: string;
}

/**
 * myrmidon(F06-D): the list must fit a phone screen (owner 09.10: «Список не
 * длиннее экрана»). Buttons make selection the main path, but the numbered
 * text list is what a plain `/model` still answers, so the cap is the screen,
 * not the catalog. The ranked families (the owner's channels, see
 * GATEWAY_PROVIDER_RANK) are never cut by the general cap — a list that hides
 * the owner's own second channel is the failure this cap used to cause (a live
 * catalog had 18 DashScope chat models, which left no room for z.ai) — they
 * are bounded only by the hard ceiling. The rest fills what is left of the
 * general cap, and the reply says how many were left out.
 */
export const MAX_LISTED_CHAT_MODEL_CANDIDATES = 20;
export const MAX_LISTED_RANKED_CHAT_MODEL_CANDIDATES = 30;

/**
 * Adapter types whose `config.model` is read on a run (design doc fact F13).
 * Kept here, not imported from each adapter, so a change to any adapter's
 * execute.ts cannot silently widen or narrow what /model claims to control.
 * myrmidon(F06-A): `hermes_gateway` is in the list now that gap G4 has landed
 * — the gateway adapter passes `model`/`model_options` to the run, and a chat
 * override reaches its container through the agent profile (see the apply path
 * in overrides.ts). It used to be absent precisely because it did not.
 */
export const MODEL_OVERRIDE_ALLOWED_ADAPTER_TYPES: readonly string[] = [
  "hermes_gateway",
  "hermes_local",
  "claude_local",
  "codex_local",
  "cursor",
  "cursor_cloud",
  "gemini_local",
  "grok_local",
  "kimi_local",
  "opencode_local",
  "pi_local",
];

/** Adapter types whose `config.effort` is honored today. myrmidon(F06-A): the
 *  gateway adapter compiles the same hermes profile, so it honors it too. */
export const THINK_OVERRIDE_ALLOWED_ADAPTER_TYPES: readonly string[] = ["hermes_local", "hermes_gateway"];

/**
 * myrmidon(F06-A): the adapters that run a bot container — their written value
 * has to be applied to the agent profile to take effect (overrides.ts), and
 * their `/model` list comes from the gateway catalog (below).
 */
export const GATEWAY_ADAPTER_TYPES: readonly string[] = ["hermes_gateway"];

/**
 * myrmidon(F06-A): adapters whose reasoning-effort choices are checked against
 * effort-policy.ts (incident 02.10: an effort a model does not accept makes the
 * gateway answer from another model, so `/think` must refuse it rather than
 * write it). Both hermes adapters compile the same hermes profile.
 */
export const EFFORT_POLICY_ADAPTER_TYPES: readonly string[] = ["hermes_local", "hermes_gateway"];

/** myrmidon(F06-A): the provider families grouped in a `/model` list; any other
 *  model id is listed without a family header. */
const GATEWAY_MODEL_PROVIDER_PREFIXES: readonly string[] = ["dashscope", "zai", "nous"];

/**
 * myrmidon(F06-D): the owner's channel policy for a `/model` candidate order —
 * the families an owner chat should reach first. Anything else keeps its
 * alphabetical order at the tail.
 */
const GATEWAY_PROVIDER_RANK: readonly string[] = ["dashscope", "zai"];

/** myrmidon(F06-D): family rank of a provider name (0 first). Tolerates the
 *  collected catalog's spellings of the same family (`z.ai`, `z-ai`, `zai`). */
function gatewayProviderRank(provider: string | null): number {
  if (!provider) return GATEWAY_PROVIDER_RANK.length + 1;
  const normalized = provider.trim().toLowerCase().replace(/[.\s_-]+/g, "");
  const index = GATEWAY_PROVIDER_RANK.findIndex(
    (family) => family.replace(/[.\s_-]+/g, "") === normalized,
  );
  return index >= 0 ? index : GATEWAY_PROVIDER_RANK.length;
}

/**
 * myrmidon(F06-D): id fragments that mark a gateway model as not a chat model —
 * embeddings, OCR/vision service, rerank/moderation/TTS and the board's own
 * maintenance models (`hindsight-mem`, `deepseek-v4-flash-mem`, …). A gateway
 * catalog is the union of everything every agent key may run, so `/model` has
 * to filter it before showing it (owner 09.10: «без эмбеддингов/OCR/служебных»).
 */
const NON_CHAT_MODEL_ID_PATTERNS: readonly RegExp[] = [
  /embed/,
  // Short tokens only count as whole id segments: `tts` must not match inside
  // `...-matts-...`, nor `asr` inside `...-casrl`.
  /(?:^|[-_./])ocr(?:[-_./]|$)/,
  /(?:^|[-_./])tts(?:[-_./]|$)/,
  /(?:^|[-_./])asr(?:[-_./]|$)/,
  /rerank/,
  /moderation/,
  /transcribe/,
  /classifier/,
  // The board's own maintenance models, by suffix and by family.
  /-mem(?:[-_./]|$)/,
  /-consolidation(?:[-_./]|$)/,
  /-summary(?:[-_./]|$)/,
  /-summarizer(?:[-_./]|$)/,
  /^hindsight(?:[-_./]|$)/,
];

/** myrmidon(F06-D): whether a gateway catalog id is a chat model `/model` may offer. */
export function isChatGatewayModelId(modelId: string): boolean {
  const lowered = modelId.trim().toLowerCase();
  if (!lowered) return false;
  return !NON_CHAT_MODEL_ID_PATTERNS.some((pattern) => pattern.test(lowered));
}

/** myrmidon(F06-A): the family of a gateway model id, by its prefix. */
export function providerPrefixOfModelId(modelId: string): string | null {
  const lowered = modelId.trim().toLowerCase();
  for (const prefix of GATEWAY_MODEL_PROVIDER_PREFIXES) {
    if (lowered.startsWith(`${prefix}-`)) return prefix;
  }
  return null;
}

/**
 * myrmidon(F06-D): why this agent's own model list was not used. `no_gateway_url`
 * — the board has no gateway address; `no_key` — no gateway key for the agent
 * (its card binds none and there is no shared company secret); `secret_error` —
 * the secret store could not be read; `gateway_error` — the gateway refused the
 * key or did not answer a model list; `empty_list` — the key allows no models.
 */
export type GatewayCatalogKeyFailure =
  | "no_gateway_url"
  | "no_key"
  | "secret_error"
  | "gateway_error"
  | "empty_list";

/**
 * myrmidon(F06-A): the gateway catalog for one agent, as the `/model` list
 * needs it — read through the caller's bound reader (see
 * gateway-model-catalog.ts for the real read; tests pass a stub).
 */
export interface ChatModelCatalog {
  models: string[];
  /** Set with `scope: "catalog"`: why the agent's own list was not read. */
  keyFailure?: GatewayCatalogKeyFailure;
  /** Provider family by model id, when the board's collected catalog knows it. */
  providers?: Record<string, string>;
  /**
   * `agentKey` — this agent's own gateway key allowlist (the models it may
   * run); `catalog` — the whole gateway catalog, used when that per-key read
   * was not available, and the reply says so.
   */
  scope: "agentKey" | "catalog";
}

/** myrmidon(F06-A): reads the catalog for one agent. Null = nothing readable. */
export type ChatModelCatalogReader = () => Promise<ChatModelCatalog | null>;

/** myrmidon(F06-A): the candidates of a chooser, plus where a gateway list came
 *  from (the whole catalog instead of this agent's own key allowlist). */
export interface ChatModelList {
  candidates: ChatModelCandidate[];
  wholeCatalog: boolean;
  /** myrmidon(F06-D): with `wholeCatalog`, the reason the agent's own list was not used. */
  keyFailure?: GatewayCatalogKeyFailure;
}

/**
 * packages/adapters/hermes/src/server/myrmidon-profile-config.ts:232
 * (`HERMES_REASONING_EFFORTS`, not exported — that package is hot, see
 * docs/myrmidon/CONVENTIONS.md section 8, so the list is duplicated here).
 */
export const HERMES_REASONING_EFFORTS: readonly string[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The chat-level override's `adapterConfig`, or `{}` if there is none. */
export function readOverrideAdapterConfig(
  assigneeAdapterOverrides: Record<string, unknown> | null,
): Record<string, unknown> {
  const config = assigneeAdapterOverrides?.adapterConfig;
  return isRecord(config) ? config : {};
}

function readStringField(config: Record<string, unknown>, key: string): string | null {
  const value = config[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** A named field's value, or null when unset or one of the "let the adapter decide" sentinels. */
function readSpecificModelField(config: Record<string, unknown>, key: string): string | null {
  const value = readStringField(config, key);
  return value && !isSpecialModelValue(value) ? value : null;
}

/**
 * myrmidon(1.7-TG-LOCALE): which decision produced a chat's effective value.
 * These are catalog keys (../locales), not prose — `sourceLabelFor()` renders
 * the label shown to the chat owner; the value beside it (a model name, a
 * reasoning level) stays exactly as the adapter spells it.
 */
export type ChatValueSource = "thisChat" | "agentDefault" | "adapterDefault";

const SOURCE_TEXT_KEYS: Record<ChatValueSource, BridgeTextKey> = {
  thisChat: "source.thisChat",
  agentDefault: "source.agentDefault",
  adapterDefault: "source.adapterDefault",
};

export function sourceLabelFor(source: ChatValueSource, locale: BridgeLocale): string {
  return t(locale, SOURCE_TEXT_KEYS[source]);
}

/** The card's own value for this key, or null when the card sets none (the callers render the "adapter default" label then). */
export function describeCardValue(
  cardAdapterConfig: Record<string, unknown>,
  key: "model" | "effort",
): string | null {
  return readSpecificModelField(cardAdapterConfig, key);
}

/** The value this chat actually uses right now, and who decided it. A null value means the adapter decides. */
export function describeEffectiveChatValue(
  overrideAdapterConfig: Record<string, unknown>,
  cardAdapterConfig: Record<string, unknown>,
  key: "model" | "effort",
): { value: string | null; source: ChatValueSource } {
  const override = readSpecificModelField(overrideAdapterConfig, key);
  if (override) return { value: override, source: "thisChat" };
  const card = readSpecificModelField(cardAdapterConfig, key);
  if (card) return { value: card, source: "agentDefault" };
  return { value: null, source: "adapterDefault" };
}

function readModelFallbacks(cardAdapterConfig: Record<string, unknown>): string[] {
  const models = cardAdapterConfig.models;
  if (!isRecord(models)) return [];
  const fallbacks = models.fallbacks;
  if (!Array.isArray(fallbacks)) return [];
  return fallbacks.filter(
    (entry): entry is string =>
      typeof entry === "string" && entry.trim().length > 0 && !isSpecialModelValue(entry),
  );
}

/**
 * Model names this chat can choose from: the card model, its fallbacks, the
 * gateway catalog (gateway adapters, myrmidon(F06-A)), then the adapter's own
 * list — deduplicated, in that order. The catalog is read through the caller's
 * reader, and its models are ordered by provider family so the rendered list
 * groups instead of interleaving.
 */
export async function listModelCandidates(
  adapterType: string,
  cardAdapterConfig: Record<string, unknown>,
  catalog: ChatModelCatalogReader | null = null,
): Promise<ChatModelList> {
  const seen = new Set<string>();
  const candidates: ChatModelCandidate[] = [];
  const push = (id: string, label: string, provider: string | null = null) => {
    const trimmedId = id.trim();
    if (!trimmedId || seen.has(trimmedId)) return;
    seen.add(trimmedId);
    const candidate: ChatModelCandidate = { id: trimmedId, label: label.trim() || trimmedId };
    if (provider) candidate.provider = provider;
    candidates.push(candidate);
  };

  const cardIds: string[] = [];
  const cardModel = readSpecificModelField(cardAdapterConfig, "model");
  if (cardModel) cardIds.push(cardModel);
  for (const fallback of readModelFallbacks(cardAdapterConfig)) cardIds.push(fallback);

  let wholeCatalog = false;
  let keyFailure: GatewayCatalogKeyFailure | undefined;
  let gatewayOrdered: ChatModelCandidate[] | null = null;
  if (GATEWAY_ADAPTER_TYPES.includes(adapterType) && catalog) {
    let read: ChatModelCatalog | null = null;
    try {
      read = await catalog();
    } catch {
      // A gateway read failing must not make /model unusable: the card's own
      // values still answer, and an empty result reads as "unavailable".
      read = null;
    }
    if (read) {
      wholeCatalog = read.scope === "catalog";
      keyFailure = wholeCatalog ? read.keyFailure : undefined;
      const providerOf = (id: string) => read?.providers?.[id] ?? providerPrefixOfModelId(id) ?? null;
      // myrmidon(F06-D): a gateway catalog is every model any key may run —
      // embeddings, OCR and service models included. `/model` may only offer
      // chat models (owner 09.10), so non-chat ids are dropped here, never
      // shown — the card's own models too. The whole list, the card's models
      // among it, is ordered by the owner's channel policy: DashScope first,
      // then z.ai, then the remaining families alphabetically; inside a
      // family, by id (numbers in ids compare as numbers).
      const ids: string[] = [];
      const listedIds = new Set<string>();
      for (const raw of [...cardIds, ...read.models]) {
        const id = raw.trim();
        if (!id || listedIds.has(id) || !isChatGatewayModelId(id)) continue;
        listedIds.add(id);
        ids.push(id);
      }
      ids.sort((left, right) => compareGatewayModelIds(left, providerOf(left), right, providerOf(right)));
      gatewayOrdered = ids.map((id) => {
        const provider = providerOf(id);
        return provider ? { id, label: id, provider } : { id, label: id };
      });
    }
  }
  if (gatewayOrdered) {
    for (const candidate of gatewayOrdered) push(candidate.id, candidate.label, candidate.provider ?? null);
  } else {
    for (const id of cardIds) push(id, id);
  }

  let discovered: { id: string; label: string }[] = [];
  try {
    discovered = await listAdapterModels(adapterType);
  } catch {
    // Model discovery failing must not make /model unusable; fall back to the card's own values.
    discovered = [];
  }
  for (const entry of discovered) {
    const id = entry.id ?? "";
    if (!id || isSpecialModelValue(id)) continue;
    push(id, entry.label ?? id);
  }

  return keyFailure ? { candidates, wholeCatalog, keyFailure } : { candidates, wholeCatalog };
}

/**
 * myrmidon(F06-D): the gateway candidate order — owner-ranked families first
 * (DashScope, then z.ai), then the other families alphabetically (ids with no
 * known family last), then by id, numbers inside an id compared as numbers
 * (`glm-4.6` before `glm-5.3`, `glm-5.3` before `glm-5.10`).
 */
function compareGatewayModelIds(
  leftId: string,
  leftProvider: string | null,
  rightId: string,
  rightProvider: string | null,
): number {
  const leftRank = gatewayProviderRank(leftProvider);
  const rightRank = gatewayProviderRank(rightProvider);
  if (leftRank !== rightRank) return leftRank - rightRank;
  const leftFamily = (leftProvider ?? "").trim().toLowerCase();
  const rightFamily = (rightProvider ?? "").trim().toLowerCase();
  if (leftFamily !== rightFamily) {
    if (!leftFamily) return 1;
    if (!rightFamily) return -1;
    return leftFamily.localeCompare(rightFamily);
  }
  return leftId.localeCompare(rightId, "en", { numeric: true });
}

/** Reasoning levels this chat can choose from — a fixed list, independent of the card. */
export function listThinkCandidates(): ChatModelCandidate[] {
  return HERMES_REASONING_EFFORTS.map((level) => ({ id: level, label: level }));
}

/** Resolves a /model or /think argument: exact name (any case), 1-based index, or an unambiguous "/"-suffix. */
export function resolveChatChoiceArgument(
  candidates: ChatModelCandidate[],
  arg: string,
): ChatModelCandidate | null {
  const trimmed = arg.trim();
  if (!trimmed) return null;
  const asIndex = Number(trimmed);
  if (Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= candidates.length) {
    return candidates[asIndex - 1]!;
  }
  const lower = trimmed.toLowerCase();
  const exact = candidates.find((candidate) => candidate.id.toLowerCase() === lower);
  if (exact) return exact;
  const suffix = `/${lower}`;
  const bySuffix = candidates.filter((candidate) => candidate.id.toLowerCase().endsWith(suffix));
  return bySuffix.length === 1 ? bySuffix[0]! : null;
}

/**
 * myrmidon(F06-D): how many leading candidates the numbered text list shows —
 * the general screen cap, widened to take every candidate of the owner-ranked
 * families (they lead a gateway list) up to the hard ceiling.
 */
function listedChoiceCount(candidates: ChatModelCandidate[]): number {
  let ranked = 0;
  while (ranked < candidates.length) {
    const candidate = candidates[ranked]!;
    const rank = gatewayProviderRank(candidate.provider ?? providerPrefixOfModelId(candidate.id));
    if (rank >= GATEWAY_PROVIDER_RANK.length) break;
    ranked++;
  }
  const limit = Math.max(MAX_LISTED_CHAT_MODEL_CANDIDATES, Math.min(MAX_LISTED_RANKED_CHAT_MODEL_CANDIDATES, ranked));
  return Math.min(limit, candidates.length);
}

/**
 * The numbered list shown after a chooser command: one continuous numbering,
 * one id per line — no family headers (owner 09.10: «без заголовков»; the
 * order already groups the families). A list longer than the screen is cut
 * (listedChoiceCount) and says how many were left out; any of them can still
 * be chosen by name or number.
 */
export function formatChatChoiceList(candidates: ChatModelCandidate[], locale: BridgeLocale): string {
  const shown = listedChoiceCount(candidates);
  const lines = candidates.slice(0, shown).map((candidate, index) => `${index + 1}) ${candidate.id}`);
  const hidden = candidates.length - shown;
  if (hidden > 0) lines.push(t(locale, "chooser.moreHidden", { count: hidden }));
  return lines.join("\n");
}

/** myrmidon(F06-D): the candidates the text list (and the buttons) show. */
export function listedChatChoices(candidates: ChatModelCandidate[]): ChatModelCandidate[] {
  return candidates.slice(0, listedChoiceCount(candidates));
}

/**
 * myrmidon(F06-D): the sentence under a whole-catalog list — that it is the
 * whole catalog, and why this agent's own list was not used.
 */
export function wholeCatalogText(locale: BridgeLocale, keyFailure: GatewayCatalogKeyFailure | undefined): string {
  const base = t(locale, "chooser.catalogWhole");
  if (!keyFailure) return base;
  return `${base} ${t(locale, "chooser.keyFailure", { reason: t(locale, KEY_FAILURE_TEXT_KEYS[keyFailure]) })}`;
}

const KEY_FAILURE_TEXT_KEYS: Record<GatewayCatalogKeyFailure, BridgeTextKey> = {
  no_gateway_url: "chooser.keyFailure.noGatewayUrl",
  no_key: "chooser.keyFailure.noKey",
  secret_error: "chooser.keyFailure.secretError",
  gateway_error: "chooser.keyFailure.gatewayError",
  empty_list: "chooser.keyFailure.emptyList",
};

/** One of /model or /think: what it is called, which adapterConfig key it edits, and how it lists candidates. */
export interface ChatModelChooser {
  /** Catalog key of the status-style label (Model / Reasoning per locale). */
  statusLabelKey: BridgeTextKey;
  /** Command name, used in "/model"/"/think" usage hints. */
  commandName: "model" | "think";
  adapterConfigKey: "model" | "effort";
  /** Catalog key of the sentence shown when this chooser cannot be used for the agent's adapter. */
  unavailableTextKey: BridgeTextKey;
  /** Catalog key naming the kind of value a rejected argument would have set. */
  unknownNounKey: BridgeTextKey;
  isAllowedAdapterType: (adapterType: string) => boolean;
  /** myrmidon(F06-A): the third argument is the caller's gateway catalog
   *  reader, bound to this chat's agent (null when the caller has none). */
  listCandidates: (
    adapterType: string,
    cardAdapterConfig: Record<string, unknown>,
    catalog: ChatModelCatalogReader | null,
  ) => Promise<ChatModelList>;
}

export const MODEL_CHOOSER: ChatModelChooser = {
  statusLabelKey: "model.statusLabel",
  commandName: "model",
  adapterConfigKey: "model",
  unavailableTextKey: "model.unavailable",
  unknownNounKey: "model.unknownNoun",
  isAllowedAdapterType: (adapterType) => MODEL_OVERRIDE_ALLOWED_ADAPTER_TYPES.includes(adapterType),
  listCandidates: listModelCandidates,
};

export const THINK_CHOOSER: ChatModelChooser = {
  statusLabelKey: "reasoning.statusLabel",
  commandName: "think",
  adapterConfigKey: "effort",
  unavailableTextKey: "reasoning.unavailable",
  unknownNounKey: "reasoning.unknownNoun",
  isAllowedAdapterType: (adapterType) => THINK_OVERRIDE_ALLOWED_ADAPTER_TYPES.includes(adapterType),
  listCandidates: async () => ({ candidates: listThinkCandidates(), wholeCatalog: false }),
};

export interface ChooserAvailability {
  available: boolean;
  candidates: ChatModelCandidate[];
  /** myrmidon(F06-A): why it is unavailable — a catalog key rendered with the
   *  adapter type and the reason by `unavailableChoiceText` below. */
  reasonKey?: BridgeTextKey;
  /** myrmidon(F06-A): the candidates are the whole gateway catalog, not this
   *  agent's own key allowlist (the reply says so). */
  wholeCatalog?: boolean;
  /** myrmidon(F06-D): with `wholeCatalog`, why the agent's own list was not used. */
  keyFailure?: GatewayCatalogKeyFailure;
}

/**
 * myrmidon(F06-A): the refusal text of a chooser — its own key with the adapter
 * type and the reason (a second catalog key) filled in, in the chat's locale.
 */
export function unavailableChoiceText(
  chooser: ChatModelChooser,
  agent: BridgedCommandAgentContext,
  locale: BridgeLocale,
  reasonKey: BridgeTextKey,
): string {
  return t(locale, chooser.unavailableTextKey, {
    adapterType: agent.adapterType,
    reason: t(locale, reasonKey),
  });
}

export async function checkChooserAvailability(
  chooser: ChatModelChooser,
  agent: BridgedCommandAgentContext,
  catalog: ChatModelCatalogReader | null = null,
): Promise<ChooserAvailability> {
  if (!chooser.isAllowedAdapterType(agent.adapterType)) {
    return { available: false, candidates: [], reasonKey: "chooser.reason.unsupportedAdapter" };
  }
  const list = await chooser.listCandidates(agent.adapterType, agent.adapterConfig, catalog);
  if (list.candidates.length === 0) {
    return {
      available: false,
      candidates: [],
      reasonKey: "chooser.reason.noCandidates",
      wholeCatalog: list.wholeCatalog,
      ...(list.keyFailure ? { keyFailure: list.keyFailure } : {}),
    };
  }
  return {
    available: true,
    candidates: list.candidates,
    wholeCatalog: list.wholeCatalog,
    ...(list.keyFailure ? { keyFailure: list.keyFailure } : {}),
  };
}

/**
 * myrmidon(1.7-TG-LOCALE): the turn-in-progress refusal used by the early
 * read here and by the caller's authoritative re-check in overrides.ts
 * (applyChatAdapterOverride's `refuseIfTurnInProgress`); both sides render
 * the same `turn.inProgress` catalog key, so the early refusal and the later
 * write-time refusal report the same thing in the same words.
 */
export function turnInProgressText(locale: BridgeLocale): string {
  return t(locale, "turn.inProgress");
}

export type ChooserSelectionResult =
  | { kind: "set"; candidate: ChatModelCandidate }
  | { kind: "default" }
  | { kind: "error"; text: string };

/**
 * myrmidon(F06-A): refuses an effort level the chat's model does not accept
 * (effort-policy.ts: a glm-class model takes low/high/max only — the incident
 * 02.10 rule: an unsupported effort makes the gateway answer from another
 * model). Returns the refusal text, or null when the choice is fine. An
 * adapter outside the policy, or a chat without a known model, is unrestricted.
 */
export function effortPolicyRefusal(input: {
  adapterType: string;
  model: string | null;
  effort: string;
  locale: BridgeLocale;
}): string | null {
  if (!EFFORT_POLICY_ADAPTER_TYPES.includes(input.adapterType)) return null;
  const allowed = effortsForModel(input.model);
  if (allowed.includes(input.effort)) return null;
  return t(input.locale, "chooser.effortNotAllowed", {
    value: input.effort,
    model: input.model ?? "",
    list: allowed.join(", "),
  });
}

/**
 * Resolves a /model or /think argument against this chat's agent: not
 * available, a reply in progress, an unknown value, "default", or a
 * resolved candidate. Does not write anything; callers apply the result.
 * myrmidon(1.7-TG-LOCALE): every error prose renders in the chat owner's
 * locale passed by the caller.
 * myrmidon(F06-A): a gateway agent's candidate list comes from `catalog`, and
 * an effort choice is checked against the chat's model (effortPolicyRefusal).
 */
export async function resolveChooserSelection(input: {
  chooser: ChatModelChooser;
  agent: BridgedCommandAgentContext;
  arg: string;
  turnInProgress: boolean;
  checkTurnInProgress: boolean;
  locale: BridgeLocale;
  /** myrmidon(F06-A): the caller's gateway catalog reader, if it has one. */
  catalog?: ChatModelCatalogReader | null;
  /** myrmidon(F06-A): the model this chat's effort applies to (chat override →
   *  card), needed for the effort policy check. */
  effectiveModel?: string | null;
}): Promise<ChooserSelectionResult> {
  const availability = await checkChooserAvailability(input.chooser, input.agent, input.catalog ?? null);
  if (!availability.available) {
    return {
      kind: "error",
      text: unavailableChoiceText(
        input.chooser,
        input.agent,
        input.locale,
        availability.reasonKey ?? "chooser.reason.unsupportedAdapter",
      ),
    };
  }
  if (input.checkTurnInProgress && input.turnInProgress) {
    return { kind: "error", text: turnInProgressText(input.locale) };
  }
  const trimmed = input.arg.trim();
  if (trimmed.toLowerCase() === "default") {
    return { kind: "default" };
  }
  const candidate = resolveChatChoiceArgument(availability.candidates, trimmed);
  if (!candidate) {
    return {
      kind: "error",
      text: t(input.locale, "chooser.unknownError", {
        noun: t(input.locale, input.chooser.unknownNounKey),
        value: trimmed,
        list: formatChatChoiceList(availability.candidates, input.locale),
      }),
    };
  }
  if (input.chooser.adapterConfigKey === "effort") {
    const refusal = effortPolicyRefusal({
      adapterType: input.agent.adapterType,
      model: input.effectiveModel ?? null,
      effort: candidate.id,
      locale: input.locale,
    });
    if (refusal) return { kind: "error", text: refusal };
  }
  return { kind: "set", candidate };
}
