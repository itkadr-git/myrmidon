// server/src/myrmidon/foraging/settings.ts
//
// myrmidon(1.6-FORAGING): where the FORAGING sweep gets its switch, its period,
// its per-pass budget and the name of the company secret it reads with.
//
// 1.6.1 (FORAGING-LIMITS-UI): the same values became instance settings edited
// from the interface (the "Foraging" block on Instance → General, saved through
// PATCH /api/myrmidon/foraging-settings). The precedence — the stored row, a
// per-key environment override, the built-in default — is decided once in
// `@paperclipai/shared` (`myrmidon-foraging.ts`); this module only adapts the
// resolved settings to the shape the sweep and the routes consume, and hosts
// the read/write service of the stored row. `readForagingSettings` stays
// exported (the startup, the wiring and the routes call it on every use, so a
// change applies with the next pass, never a restart).
//
// The key is named, never carried: `MYRMIDON_FORAGING_KEY_SECRET` holds the NAME
// of a company secret whose value is sent as a bearer token to the source. The
// value is read from the company's secrets at call time and never logged.

import type { Db } from "@paperclipai/db";
import {
  FORAGING_SETTINGS_KEY,
  mergeForagingSettings,
  resolveForagingSettings,
  type ForagingSettings,
  type ForagingSettingsPatch,
  type ResolvedForagingSettings,
} from "@paperclipai/shared";
import type { instanceSettingsService } from "../../services/instance-settings.js";
import type { ForagingBudget } from "./domain.js";

export const FORAGING_ENABLED_ENV = "MYRMIDON_FORAGING_ENABLED";
export const FORAGING_BUDGET_CENTS_ENV = "MYRMIDON_FORAGING_BUDGET_CENTS";
export const FORAGING_INTERVAL_SEC_ENV = "MYRMIDON_FORAGING_INTERVAL_SEC";
export const FORAGING_KEY_SECRET_ENV = "MYRMIDON_FORAGING_KEY_SECRET";
export const FORAGING_MIN_HOST_INTERVAL_SEC_ENV = "MYRMIDON_FORAGING_MIN_HOST_INTERVAL_SEC";

/** Activity action written for every foraging settings change. */
export const FORAGING_SETTINGS_UPDATED_ACTION = "instance.foraging.updated";

export interface ForagingEffectiveSettings extends ResolvedForagingSettings {
  /** Name of the company secret carrying the read token, or null (env only). */
  keySecret: string | null;
  intervalMs: number;
  minHostIntervalMs: number;
  /** The per-pass budget in the shape the sweep domain uses. */
  budget: ForagingBudget;
}

/**
 * The effective settings the sweep runs with right now. The stored row is read
 * on every call: a value changed in the interface applies with the next pass,
 * without a restart (the same live-read contract the swarm-claim sweep uses).
 */
export async function resolveForagingEffectiveSettings(
  settings: Pick<ReturnType<typeof instanceSettingsService>, "getGeneral">,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ForagingEffectiveSettings> {
  const general = (await settings.getGeneral()) as unknown as Record<string, unknown>;
  const resolved = resolveForagingSettings({ stored: general[FORAGING_SETTINGS_KEY], env });
  const keySecret = env[FORAGING_KEY_SECRET_ENV]?.trim() || null;
  return {
    ...resolved,
    keySecret,
    intervalMs: resolved.settings.intervalSec * 1000,
    minHostIntervalMs: resolved.settings.minHostIntervalSec * 1000,
    budget: {
      maxCostCents: resolved.settings.passBudgetCents ?? 0,
      enabled: resolved.settings.passBudgetCents !== null,
    },
  };
}

/**
 * The legacy entry the old callers use: the effective settings from the
 * environment alone (the stored row is read by the wiring through
 * `resolveForagingEffectiveSettings`). Kept so the reader construction and the
 * tests that pin the env reading do not duplicate the env parsing.
 */
export function readForagingSettings(env: NodeJS.ProcessEnv = process.env): {
  enabled: boolean;
  intervalMs: number;
  budget: ForagingBudget;
  keySecret: string | null;
  minHostIntervalMs: number;
} {
  const resolved = resolveForagingSettings({ env });
  const settings = resolved.settings;
  return {
    enabled: settings.enabled,
    intervalMs: settings.intervalSec * 1000,
    budget: {
      maxCostCents: settings.passBudgetCents ?? 0,
      enabled: settings.passBudgetCents !== null,
    },
    keySecret: env[FORAGING_KEY_SECRET_ENV]?.trim() || null,
    minHostIntervalMs: settings.minHostIntervalSec * 1000,
  };
}

// ---------------------------------------------------------------------------
// 1.6.1 (FORAGING-LIMITS-UI): the read/write service of the stored row.
// ---------------------------------------------------------------------------

export interface ForagingSettingsPorts {
  /** The instance settings service (general block read/write). */
  settings: Pick<ReturnType<typeof instanceSettingsService>, "getGeneral" | "updateGeneral">;
  /** Activity log; absent in unit tests. */
  logActivity?: (input: {
    companyId: string;
    actorType: string;
    actorId: string;
    action: string;
    entityType: string;
    entityId: string;
    details: Record<string, unknown>;
  }) => Promise<void>;
  env?: Record<string, string | undefined>;
}

export interface ForagingSettingsService {
  /** Effective settings and where each value came from. */
  read(): Promise<ResolvedForagingSettings>;
  /** Persist, audit and apply a patch; returns the settings now in force. */
  update(
    patch: ForagingSettingsPatch,
    actor: { actorType: string; actorId: string },
  ): Promise<ResolvedForagingSettings>;
}

type GeneralRecord = Record<string, unknown>;

function asGeneral(value: unknown): GeneralRecord {
  return typeof value === "object" && value !== null ? (value as GeneralRecord) : {};
}

export function foragingSettingsService(
  _db: Db,
  ports: ForagingSettingsPorts,
): ForagingSettingsService {
  const env = ports.env ?? process.env;

  async function readGeneral(): Promise<GeneralRecord> {
    return asGeneral(await ports.settings.getGeneral());
  }

  async function read(): Promise<ResolvedForagingSettings> {
    const general = await readGeneral();
    return resolveForagingSettings({ stored: general[FORAGING_SETTINGS_KEY], env });
  }

  return {
    read,
    async update(patch, actor) {
      const general = await readGeneral();
      const current = resolveForagingSettings({ stored: general[FORAGING_SETTINGS_KEY], env });
      const next = mergeForagingSettings(current.settings, patch);
      await ports.settings.updateGeneral({ [FORAGING_SETTINGS_KEY]: next });
      await ports.logActivity?.({
        companyId: "",
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: FORAGING_SETTINGS_UPDATED_ACTION,
        entityType: "instance_settings",
        entityId: FORAGING_SETTINGS_KEY,
        details: { settings: next, patch },
      });
      return resolveForagingSettings({ stored: next, env });
    },
  };
}
