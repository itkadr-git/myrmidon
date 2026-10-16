/**
 * Foraging idle gate (myrmidon 1.6.3 FORAGING-IDLE-GATE, OPE-4142).
 *
 * Product rule: learning only when idle — working tasks always come first.
 * Before a foraging pass reads a role's sources, the pass checks that the
 * role is idle:
 *
 * - `queue_not_empty` — the role's swarm queue has open tasks with no
 *   assignee waiting for the role;
 * - `no_idle_agent` — no agent of the role is free of `todo`/`in_progress`
 *   tasks.
 *
 * The pass only reads a role's sources when both conditions hold (queue
 * empty AND an idle agent of the role exists). Other roles in the same pass
 * are unaffected: the gate filters sources per role inside one pass instead
 * of aborting the whole sweep.
 *
 * The toggle is a settings-page value with the RUNTIME-LIMITS precedence
 * shape: the stored `instance_settings.general.foragingIdleGate` value when
 * present; otherwise the environment variable
 * `MYRMIDON_FORAGING_IDLE_GATE_ENABLED` (forced override, deployment use;
 * the previous env-only read stays valid); otherwise the built-in default
 * (on). The pass re-reads the setting on every pass, so a settings-page
 * change reaches the next pass without a server restart, and the resolved
 * value carries its source for the settings screen.
 */

/** Where the toggle lives in the environment. */
export const FORAGING_IDLE_GATE_ENABLED_ENV = "MYRMIDON_FORAGING_IDLE_GATE_ENABLED";

/** The stored key inside `instance_settings.general`. */
export const FORAGING_IDLE_GATE_SETTINGS_KEY = "foragingIdleGate";

/** Where an effective value came from. */
export type ForagingIdleGateSource = "settings" | "env" | "default";

/** The canonical stored shape of `general.foragingIdleGate`. */
import { z } from "zod";

export const foragingIdleGateSettingsSchema = z
  .object({
    enabled: z.boolean(),
  })
  .strict();

export type ForagingIdleGateSettings = z.infer<typeof foragingIdleGateSettingsSchema>;

/** Body of `GET/PATCH /api/myrmidon/foraging/idle-gate`. */
export const patchForagingIdleGateSchema = z
  .object({
    enabled: z.boolean(),
  })
  .strict();

export type ForagingIdleGatePatch = z.infer<typeof patchForagingIdleGateSchema>;

export interface ResolvedForagingIdleGate {
  enabled: boolean;
  source: ForagingIdleGateSource;
}

/** The default until the owner explicitly switches it off. */
export const DEFAULT_FORAGING_IDLE_GATE_ENABLED = true;

/** An environment value as a boolean; anything unreadable reads as unset. */
export function parseForagingIdleGateEnabled(raw: string | undefined): boolean | null {
  const trimmed = raw?.trim().toLowerCase();
  if (trimmed === "1" || trimmed === "true" || trimmed === "on" || trimmed === "yes") return true;
  if (trimmed === "0" || trimmed === "false" || trimmed === "off" || trimmed === "no") return false;
  return null;
}

/** The stored settings value, or null when the row holds nothing usable. */
export function normalizeForagingIdleGateSettings(raw: unknown): ForagingIdleGateSettings | null {
  const parsed = foragingIdleGateSettingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Effective toggle and where it came from. An unreadable stored value counts
 * as absent, so the environment (or the default) applies instead — a
 * hand-edited row cannot wedge the foraging into a state nobody chose.
 */
export function resolveForagingIdleGate(options: {
  stored?: unknown;
  env?: Record<string, string | undefined>;
} = {}): ResolvedForagingIdleGate {
  const stored = normalizeForagingIdleGateSettings(options.stored);
  if (stored) {
    return { enabled: stored.enabled, source: "settings" };
  }
  const fromEnv = parseForagingIdleGateEnabled(
    (options.env ?? {})[FORAGING_IDLE_GATE_ENABLED_ENV],
  );
  if (fromEnv !== null) {
    return { enabled: fromEnv, source: "env" };
  }
  return { enabled: DEFAULT_FORAGING_IDLE_GATE_ENABLED, source: "default" };
}
