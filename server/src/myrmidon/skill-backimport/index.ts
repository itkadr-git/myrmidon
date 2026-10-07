// server/src/myrmidon/skill-backimport/index.ts
//
// myrmidon(1.6.5-SKILL-BACKIMPORT): entry point — scheduler and wiring.
//
// A bot that authors a skill keeps it in its own container volume; recreating
// the volume loses it. This module sweeps the running bots' skills roots on a
// timer and imports every new bot-authored skill into the company catalog
// (catalog row + version snapshot + managed-root materialization + lifecycle
// candidate), so the board owns a copy and the next profile compile of any
// bot of the company can deliver it again. Everything is off unless
// MYRMIDON_BOT_SKILL_BACKIMPORT is set (settings.ts).
//
// Deliberately NOT here: the agents-table query (listAgents — startup.ts
// hands it in, like the container reconciliation does), the database services
// behind the catalog/lifecycle writes (wired lazily in createDbSweepPorts so
// this module never imports the services barrel at load time), and anything
// docker beyond the read port's driver interface (docker-read.ts).

import type { Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { readSkillBackImportSettings } from "./settings.js";
import {
  createSkillBackImportSweep,
  type SkillBackImportBot,
  type SkillBackImportDeps,
} from "./sweep.js";
import { dockerSkillReadPort, listRunningBotKeys, type SkillBackImportDriver } from "./docker-read.js";

export { SKILL_BACKIMPORT_ENABLED_ENV, SKILL_BACKIMPORT_INTERVAL_SEC_ENV } from "./settings.js";
export { readSkillBackImportSettings } from "./settings.js";
export type { SkillBackImportSettings } from "./settings.js";
export { createSkillBackImportSweep } from "./sweep.js";
export type {
  SkillBackImportBot,
  SkillBackImportCatalogPort,
  SkillBackImportDeps,
  SkillBackImportLifecyclePort,
  SkillBackImportReadPort,
  SkillBackImportResult,
} from "./sweep.js";
export { dockerSkillReadPort, listRunningBotKeys } from "./docker-read.js";
export type { SkillBackImportDriver } from "./docker-read.js";

export interface SkillBackImportSweepHandle {
  stop(): void;
}

/**
 * Periodic sweep: immediately checks the gate, then ticks at the configured
 * interval. The gate is re-read every pass — turning the env off stops the
 * work without a restart (the timer idles). Safe to call unconditionally from
 * startup; with the gate off it is a no-op timer.
 */
export function startSkillBackImportSweep(
  deps: SkillBackImportDeps,
  env: NodeJS.ProcessEnv = process.env,
): SkillBackImportSweepHandle {
  const sweep = createSkillBackImportSweep({ ...deps, env, log: deps.log ?? logger });
  const settings = readSkillBackImportSettings(env);
  if (!settings.enabled) {
    logger.info("skill back-import disabled (MYRMIDON_BOT_SKILL_BACKIMPORT not set) — sweep not started");
    return { stop: () => {} };
  }
  logger.info({ intervalMs: settings.intervalMs }, "skill back-import sweep started");
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    void sweep().catch((err) => logger.warn({ err }, "skill back-import pass failed"));
  };
  const timer = setInterval(tick, settings.intervalMs);
  timer.unref?.();
  // First pass after one interval, not at boot: startup already has the
  // reconciliation sweeps running; a back-import can wait one tick.
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

/**
 * The production deps, bound to the database and the bot-container driver.
 * `listAgents` comes from the caller (startup.ts already owns the agents
 * query for the container reconciliation); the driver is whatever the
 * container runtime built (the local docker driver satisfies
 * SkillBackImportDriver; a driver without a raw path read makes the port
 * answer null for every bot — the sweep then imports nothing).
 */
export function createDbSweepPorts(
  db: Db,
  driver: SkillBackImportDriver,
  listAgents: () => Promise<SkillBackImportBot[]>,
): SkillBackImportDeps {
  return {
    async listBots(): Promise<SkillBackImportBot[]> {
      return listAgents();
    },
    listRunningBotKeys: (botKeys) => listRunningBotKeys(driver, botKeys),
    readPort: dockerSkillReadPort(driver),
    catalog: {
      async listExisting(companyId) {
        const { companySkillService } = await import("../../services/company-skills.js");
        const skills = await companySkillService(db).list(companyId);
        return {
          keys: new Set(skills.map((skill) => skill.key)),
          slugs: new Set(skills.map((skill) => skill.slug)),
        };
      },
      async upsertImportedSkill(companyId, input) {
        const { companySkillService } = await import("../../services/company-skills.js");
        const service = companySkillService(db);
        const existing = await service.getByKey(companyId, input.key);
        if (existing) {
          // Never overwrite the board's own record from a bot: the catalog
          // is the authority once the skill is there. The drift between the
          // bot's copy and the board copy is resolved by a human through the
          // lifecycle, not by an unattended sweep.
          return { id: existing.id };
        }
        const created = await service.createLocalSkill(companyId, {
          name: input.name,
          slug: input.slug,
          description: input.description,
          markdown: input.markdown,
          metadata: input.metadata,
        } as never);
        return { id: created.id };
      },
      async createVersion(companyId, skillId, input) {
        const { companySkillService } = await import("../../services/company-skills.js");
        const version = await companySkillService(db).createVersion(companyId, skillId, { label: input.label });
        return { id: version.id };
      },
      async materializeSkill(companyId, skillId) {
        // The runtime source for a local-source skill is the managed root;
        // listRuntimeSkillEntries materializes it on demand at compile time,
        // so there is nothing to do here at import time — the skill survives
        // a volume loss because the catalog row holds the content.
        void companyId;
        void skillId;
      },
    },
    lifecycle: {
      async setCandidate(companyId, skillId) {
        const { skillLifecycleService } = await import("../skill-lifecycle/index.js");
        await skillLifecycleService(db).setCandidate(companyId, skillId, {
          actorType: "system",
          actorId: "skill-backimport",
        });
      },
    },
  };
}
