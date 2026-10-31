import type { Db } from "@myrmidon/db";
import { logger } from "../../middleware/logger.js";
import { selectDueEscalations, type DueEscalationItem } from "./select-due.js";
import { escalateInteractionStep, type EscalationStepResult } from "./escalate-step.js";

export const DEFAULT_INTERACTION_ESCALATION_INTERVAL_SEC = 60;
export const DEFAULT_INTERACTION_ESCALATION_BATCH_SIZE = 50;
export const INTERACTION_ESCALATION_SETTINGS_KEY = "interactionEscalation";

export interface InteractionEscalationSettings {
  enabled: boolean;
  intervalSec: number;
}

export interface InteractionEscalationSweepDeps {
  db: Db;
  instanceSettings?: {
    getGeneral?: () => Promise<unknown>;
    getExperimental?: () => Promise<unknown>;
  };
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  enabled?: boolean;
  intervalSec?: number;
  batchSize?: number;
}

export interface InteractionEscalationSweepOptions {
  now?: Date;
  force?: boolean;
  enabled?: boolean;
  intervalSec?: number;
}

export interface InteractionEscalationSweepResult {
  due: number;
  escalated: number;
  unchanged: number;
  failed: number;
  skipped?: boolean;
  reason?: string;
}

export async function readInteractionEscalationSettings(
  deps: Pick<InteractionEscalationSweepDeps, "instanceSettings" | "env" | "enabled" | "intervalSec">,
): Promise<InteractionEscalationSettings> {
  const env = deps.env ?? process.env;

  let enabled: boolean | undefined = deps.enabled;
  let intervalSec: number | undefined = deps.intervalSec;

  if (deps.instanceSettings) {
    if (deps.instanceSettings.getGeneral) {
      try {
        const general = (await deps.instanceSettings.getGeneral()) as Record<string, unknown> | null;
        if (general && typeof general === "object") {
          const stored = general[INTERACTION_ESCALATION_SETTINGS_KEY] as Record<string, unknown> | undefined;
          if (stored && typeof stored === "object") {
            if (typeof stored.enabled === "boolean" && enabled === undefined) {
              enabled = stored.enabled;
            }
            if (typeof stored.intervalSec === "number" && stored.intervalSec > 0 && intervalSec === undefined) {
              intervalSec = stored.intervalSec;
            }
          }
          if (typeof general.enableInteractionEscalation === "boolean" && enabled === undefined) {
            enabled = general.enableInteractionEscalation;
          }
          if (
            typeof general.interactionEscalationIntervalSec === "number" &&
            general.interactionEscalationIntervalSec > 0 &&
            intervalSec === undefined
          ) {
            intervalSec = general.interactionEscalationIntervalSec;
          }
        }
      } catch {
        // Fall back gracefully
      }
    }

    if (deps.instanceSettings.getExperimental && enabled === undefined) {
      try {
        const experimental = (await deps.instanceSettings.getExperimental()) as Record<string, unknown> | null;
        if (experimental && typeof experimental === "object") {
          if (typeof experimental.enableInteractionEscalation === "boolean") {
            enabled = experimental.enableInteractionEscalation;
          }
        }
      } catch {
        // Fall back gracefully
      }
    }
  }

  if (enabled === undefined) {
    const rawEnvEnabled = env.MYRMIDON_INTERACTION_ESCALATION_ENABLED?.trim().toLowerCase();
    if (rawEnvEnabled === "false" || rawEnvEnabled === "0" || rawEnvEnabled === "off") {
      enabled = false;
    } else if (rawEnvEnabled === "true" || rawEnvEnabled === "1" || rawEnvEnabled === "on") {
      enabled = true;
    }
  }

  if (intervalSec === undefined) {
    const rawEnvInterval = env.MYRMIDON_INTERACTION_ESCALATION_INTERVAL_SEC?.trim();
    if (rawEnvInterval && /^\d+$/.test(rawEnvInterval)) {
      const parsed = Number(rawEnvInterval);
      if (parsed > 0) {
        intervalSec = parsed;
      }
    }
  }

  return {
    enabled: enabled ?? true,
    intervalSec: intervalSec ?? DEFAULT_INTERACTION_ESCALATION_INTERVAL_SEC,
  };
}

export function createInteractionEscalationSweep(
  deps: InteractionEscalationSweepDeps,
): (options?: InteractionEscalationSweepOptions) => Promise<InteractionEscalationSweepResult> {
  let lastPassAt = 0;
  let inFlight: Promise<InteractionEscalationSweepResult> | null = null;

  return async function interactionEscalationSweep(
    options: InteractionEscalationSweepOptions = {},
  ): Promise<InteractionEscalationSweepResult> {
    const settings = await readInteractionEscalationSettings({
      ...deps,
      enabled: options.enabled ?? deps.enabled,
      intervalSec: options.intervalSec ?? deps.intervalSec,
    });

    if (!settings.enabled) {
      return { due: 0, escalated: 0, unchanged: 0, failed: 0, skipped: true, reason: "disabled" };
    }

    const now = options.now ?? (deps.now ? deps.now() : new Date());
    const intervalMs = settings.intervalSec * 1000;

    if (!options.force && intervalMs > 0 && lastPassAt > 0 && now.getTime() - lastPassAt < intervalMs) {
      return { due: 0, escalated: 0, unchanged: 0, failed: 0, skipped: true, reason: "interval_throttled" };
    }

    // Dedupe key: only one pass active at a time for this sweep instance
    if (inFlight) {
      return inFlight;
    }

    const runPass = async (): Promise<InteractionEscalationSweepResult> => {
      lastPassAt = now.getTime();
      const batchSize = deps.batchSize ?? DEFAULT_INTERACTION_ESCALATION_BATCH_SIZE;

      let due = 0;
      let escalated = 0;
      let unchanged = 0;
      let failed = 0;

      while (true) {
        const batch = await selectDueEscalations(deps.db, now, batchSize);
        if (!batch || batch.length === 0) {
          break;
        }

        due += batch.length;
        for (const item of batch) {
          try {
            const stepResult = await escalateInteractionStep(deps.db, item.interactionId, item.nextLevel);
            if (stepResult === "escalated") {
              escalated += 1;
            } else {
              unchanged += 1;
            }
          } catch (err) {
            failed += 1;
            logger.error(
              { err, interactionId: item.interactionId, nextLevel: item.nextLevel },
              "failed to execute escalation step",
            );
          }
        }
      }

      return {
        due,
        escalated,
        unchanged,
        failed,
        skipped: false,
      };
    };

    inFlight = runPass();
    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  };
}
