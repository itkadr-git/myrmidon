// myrmidon(PARALLEL-HELPERS): the card -> Hermes `delegation` contract.
//
// One place decides what the "Parallel helpers" block on an agent card means:
// whether helpers are allowed, how many may run at once, which model the
// children use, and how much of a turn budget each child gets. The server
// profile compiler reads the same helpers (server/src/myrmidon/bot-containers/
// profile-compiler.ts) and the agent card UI writes them
// (ui/src/components/myrmidon/AgentCardParallelHelpersFields.tsx), so the
// rules live here rather than in either side.
//
// Hermes already ships everything runtime-side: `delegate_task` in its
// `delegation` toolset, `delegation.max_concurrent_children` (parallel
// children per call AND concurrent background units) and
// `delegation.max_iterations` (per-child turn budget). Nothing here invents a
// new runtime knob; it *drives* the existing ones from the board so an owner
// changes them in the card instead of editing a container's config.yaml.
//
// myrmidon(HELPERS-NO-CAP): there is NO built-in cap on parallel helpers. With
// no settings row and no card value the limit is "unlimited"; the number
// written to Hermes (which needs an integer) is {@link HELPERS_UNLIMITED}, far
// above anything a bot fans out to. The owner can still set a ceiling
// (`maxPerAgent`) and a per-agent default (`defaultMaxPerAgent`) in settings,
// without a restart, but nothing here supplies one. What actually protects the
// host is the run-admission host-memory floor (MYRMIDON_MIN_FREE_HOST_MEMORY_MB),
// which holds new runs while host memory is short, not a small helper count.

import { z } from "zod";

/**
 * adapterConfig key holding the card's "Parallel helpers" block. Stored on the
 * agent card like `container` and `models`, so it rides the existing
 * `agents:configure` permission and change log and needs no schema change.
 */
export const PARALLEL_HELPERS_CARD_KEY = "parallelHelpers";

/** Instance setting holding the company ceiling and the default. */
export const PARALLEL_HELPERS_SETTINGS_KEY = "parallelHelpers";

/**
 * Environment variable naming the model delegated children run on when neither
 * the card nor the stored settings name one; empty (the default) means "inherit
 * the parent agent's model", which is Hermes' own behavior for an unset
 * `delegation.model`. The variable exists so an instance can point helpers at a
 * cheaper model without this module naming one — model names are deployment
 * data, not product code.
 */
export const PARALLEL_HELPERS_DEFAULT_MODEL_ENV = "MYRMIDON_BOT_HELPER_MODEL";

/**
 * The value written to Hermes' integer `max_concurrent_children` when no cap is
 * configured anywhere. It stands for "no cap", not for a recommendation.
 */
export const HELPERS_UNLIMITED = 1000;

/** Bounds of a single helper budget, so a card cannot ask for an absurd child turn cap. */
export const HELPER_TURN_BUDGET_MIN = 1;
export const HELPER_TURN_BUDGET_MAX = 500;

/**
 * Upper bound of any configured limit (card, ceiling, default): the same value
 * as {@link HELPERS_UNLIMITED}, so a configured number can never exceed "no cap".
 */
export const HELPERS_CEILING_MAX = HELPERS_UNLIMITED;

/** The card block, exactly as stored in adapterConfig. */
export interface ParallelHelpersCard {
  /** Master switch. `false` removes the `delegation` toolset from the agent. */
  enabled?: boolean;
  /** Parallel children per delegate_task call; clamped to 1..ceiling. */
  maxConcurrent?: number;
  /** `delegation.model` for the children; empty/absent = inherit the parent's model. */
  model?: string;
  /** `delegation.max_iterations` per child; absent = leave Hermes' own default. */
  childTurnBudget?: number;
}

/**
 * Company-level bounds, stored in `instance_settings.general.parallelHelpers`.
 * `buildSlots` and `hostMemoryMb` are inputs to the capacity hint only: they
 * describe the host, they never clamp a card value.
 */
export interface ParallelHelpersSettings {
  /** Highest `maxConcurrent` any agent may be given; absent = no ceiling. */
  maxPerAgent?: number;
  /** What an agent gets when its card is silent; absent = no cap. */
  defaultMaxPerAgent?: number;
  /** Build slots shared by the team, for the capacity hint; null/absent = unknown. */
  buildSlots?: number | null;
  /** Memory of the host running the bots, in MB, for the capacity hint; null/absent = unknown. */
  hostMemoryMb?: number | null;
}

const positiveInt = z.number().int().positive();

export const parallelHelpersSettingsSchema = z
  .object({
    maxPerAgent: positiveInt.max(HELPERS_CEILING_MAX).optional(),
    defaultMaxPerAgent: positiveInt.max(HELPERS_CEILING_MAX).optional(),
    buildSlots: positiveInt.nullable().optional(),
    hostMemoryMb: positiveInt.nullable().optional(),
  })
  .strict();

/** Body of `PATCH /api/myrmidon/parallel-helpers`. */
export const patchParallelHelpersSettingsSchema = parallelHelpersSettingsSchema.partial();

/** The card value after normalization: always explicit, so the compiler needs no second lookup. */
export interface ResolvedParallelHelpers {
  enabled: boolean;
  /** 1..ceiling; {@link HELPERS_UNLIMITED} stands for "no cap". Meaningless when `enabled` is false, but always present. */
  maxConcurrent: number;
  /** Empty string = inherit the parent's model. */
  model: string;
  /** Undefined = leave Hermes' own per-child default in place. */
  childTurnBudget?: number;
}

/** Unclamped read of whatever the card holds; every field optional. */
export interface ReadParallelHelpers {
  enabled?: boolean;
  maxConcurrent?: number;
  model?: string;
  childTurnBudget?: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asPositiveInt(value: unknown): number | undefined {
  const numeric =
    typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  if (!Number.isFinite(numeric)) return undefined;
  const floored = Math.floor(numeric);
  return floored > 0 ? floored : undefined;
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * The card's block as stored, with nothing invented. Unlike
 * {@link resolveParallelHelpers} this keeps "absent" distinguishable from
 * "off", which is what the settings page and a change-log diff want.
 */
export function readParallelHelpersCard(card: Record<string, unknown>): ReadParallelHelpers {
  const block = asRecord(card[PARALLEL_HELPERS_CARD_KEY]);
  return {
    enabled: typeof block.enabled === "boolean" ? block.enabled : undefined,
    maxConcurrent: asPositiveInt(block.maxConcurrent),
    model: asTrimmedString(block.model),
    childTurnBudget: asPositiveInt(block.childTurnBudget),
  };
}

/** True when the settings carry a usable (positive integer) company ceiling. */
export function helpersCeilingConfigured(settings: ParallelHelpersSettings | undefined): boolean {
  const raw = settings?.maxPerAgent;
  return typeof raw === "number" && Number.isInteger(raw) && raw > 0;
}

/** True when the settings carry a usable per-agent default. */
export function helpersDefaultConfigured(settings: ParallelHelpersSettings | undefined): boolean {
  const raw = settings?.defaultMaxPerAgent;
  return typeof raw === "number" && Number.isInteger(raw) && raw > 0;
}

/** The company ceiling; {@link HELPERS_UNLIMITED} (no cap) when none is configured. */
export function helpersCeiling(settings: ParallelHelpersSettings | undefined): number {
  if (!helpersCeilingConfigured(settings)) return HELPERS_UNLIMITED;
  return Math.min(HELPERS_CEILING_MAX, settings!.maxPerAgent!);
}

/**
 * The per-agent default, clamped into the ceiling (never above it). With no
 * default configured an agent inherits the ceiling, i.e. no cap by default.
 */
export function helpersDefault(settings: ParallelHelpersSettings | undefined): number {
  const ceiling = helpersCeiling(settings);
  if (!helpersDefaultConfigured(settings)) return ceiling;
  return Math.min(settings!.defaultMaxPerAgent!, ceiling);
}

/**
 * Card + settings -> the values the profile compiler writes.
 *
 * `enabled` defaults to false: a card that never mentions helpers must not
 * start spawning subagents the owner never asked for. `model` falls back to the
 * instance default (an environment value, so no model name is hard-coded here)
 * and then to empty, which means "inherit the parent".
 */
export function resolveParallelHelpers(
  card: Record<string, unknown>,
  settings: ParallelHelpersSettings | undefined,
  instanceDefaultModel = "",
): ResolvedParallelHelpers {
  const read = readParallelHelpersCard(card);
  const ceiling = helpersCeiling(settings);
  const fallback = helpersDefault(settings);
  const requested = read.maxConcurrent ?? fallback;
  const maxConcurrent = Math.max(1, Math.min(ceiling, requested));
  const model = read.model ?? asTrimmedString(instanceDefaultModel) ?? "";
  const budget = read.childTurnBudget;
  return {
    enabled: read.enabled === true,
    maxConcurrent,
    model,
    childTurnBudget:
      budget === undefined ? undefined : Math.max(HELPER_TURN_BUDGET_MIN, Math.min(HELPER_TURN_BUDGET_MAX, budget)),
  };
}

/** One agent's contribution to the capacity hint. */
export interface HelperCapacityAgent {
  /** True when the card has helpers switched on. */
  enabled: boolean;
  /** The resolved per-agent limit. */
  maxConcurrent: number;
}

export interface HelperCapacityHint {
  /** Sum of the per-agent limits over the enabled agents. */
  requestedTotal: number;
  /** Agents with helpers on. */
  enabledAgents: number;
  /** Build slots the shared build host can run at once, when known. */
  buildSlots: number | null;
  /** True when the requested total exceeds the build slots. */
  exceedsBuildSlots: boolean;
  /** A sentence for the settings page, or null when nothing is worth warning about. */
  warning: string | null;
}

/**
 * Sum of the helper limits against the host's build slots — a warning, never a
 * block. Helpers are cheap when idle and expensive when they all work at once,
 * so the honest thing is to show the arithmetic and let the owner decide.
 */
export function helperCapacityHint(
  agents: readonly HelperCapacityAgent[],
  settings: ParallelHelpersSettings | undefined,
): HelperCapacityHint {
  const enabled = agents.filter((agent) => agent.enabled);
  const unbounded = enabled.filter((agent) => agent.maxConcurrent >= HELPERS_UNLIMITED).length;
  const requestedTotal = enabled.reduce((sum, agent) => sum + agent.maxConcurrent, 0);
  const slots =
    typeof settings?.buildSlots === "number" && Number.isInteger(settings.buildSlots) && settings.buildSlots > 0
      ? settings.buildSlots
      : null;
  // An uncapped agent has no meaningful "total": say so instead of printing a
  // sentinel as if it were a plan, and never present it as an excess.
  const exceeds = slots !== null && unbounded === 0 && requestedTotal > slots;
  let warning: string | null = null;
  if (unbounded > 0) {
    warning = `${unbounded} of ${enabled.length} agent(s) with helpers have no helper cap; concurrency is bounded only by the host memory gate that holds new runs.`;
  } else if (exceeds) {
    warning =
      `Helpers across ${enabled.length} agent(s) can reach ${requestedTotal} at once, above the ` +
      `${slots} shared build slot(s). Builds queue; runs are not blocked.`;
  } else if (enabled.length > 0 && slots === null) {
    warning = `${requestedTotal} helper slot(s) across ${enabled.length} agent(s); the build-slot count for this host is not set, so this is not checked against it.`;
  }
  return {
    requestedTotal,
    enabledAgents: enabled.length,
    buildSlots: slots,
    exceedsBuildSlots: exceeds,
    warning,
  };
}