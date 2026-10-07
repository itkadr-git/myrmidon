// server/src/myrmidon/skill-backimport/startup.ts
//
// myrmidon(1.6.5-SKILL-BACKIMPORT): the boot wiring server/src/index.ts
// calls. Kept out of bot-containers/startup.ts (the dockergate zone): the
// sweep reads the runtime the container reconciliation already registered
// (getBotContainerRuntime) and reuses its own agents query, so this module
// never edits the zone's file and never builds a second driver.
//
// The sweep's agents query needs the company id (the catalog write is
// company-scoped), which the reconciliation query deliberately leaves out;
// so this module carries its own thin select of the same filter plus
// companyId.

import { agents, type Db } from "@paperclipai/db";
import { and, eq, ne, sql } from "drizzle-orm";
import { logger } from "../../middleware/logger.js";
import { getBotContainerRuntime } from "../bot-containers/routes-wiring.js";
import type { SkillBackImportDriver } from "./docker-read.js";
import { createDbSweepPorts, startSkillBackImportSweep, type SkillBackImportSweepHandle } from "./index.js";
import { readSkillBackImportSettings } from "./settings.js";
import type { SkillBackImportBot } from "./sweep.js";

const HERMES_GATEWAY_ADAPTER_TYPE = "hermes_gateway";

/** The same filter as the reconciliation query (agents-query.ts), plus the
 *  company id the catalog write needs. Only hermes_gateway bots whose card
 *  has container.enabled === true, never a terminated one. */
function listBackImportBots(db: Db): () => Promise<SkillBackImportBot[]> {
  return async () => {
    const rows = await db
      .select({ agentId: agents.id, companyId: agents.companyId })
      .from(agents)
      .where(
        and(
          eq(agents.adapterType, HERMES_GATEWAY_ADAPTER_TYPE),
          ne(agents.status, "terminated"),
          sql`${agents.adapterConfig} #> '{container,enabled}' = 'true'::jsonb`,
        ),
      );
    return rows.map((row: { agentId: string; companyId: string }) => ({ botKey: row.agentId, companyId: row.companyId }));
  };
}

let running: SkillBackImportSweepHandle | null = null;

/**
 * Start the back-import sweep, once. A no-op unless
 * MYRMIDON_BOT_SKILL_BACKIMPORT is on AND a bot-container runtime is
 * registered (the sweep reads through its driver); both misses are logged,
 * never thrown. Returns the stop handle (also reachable through
 * stopSkillBackImport).
 */
export function startSkillBackImport(db: Db, env: NodeJS.ProcessEnv = process.env): SkillBackImportSweepHandle {
  if (!readSkillBackImportSettings(env).enabled) {
    return { stop: () => {} };
  }
  stopSkillBackImport();
  const runtime = getBotContainerRuntime();
  if (!runtime) {
    logger.warn(
      "MYRMIDON_BOT_SKILL_BACKIMPORT is on but no bot-container runtime is registered (MYRMIDON_BOT_CONTAINERS off?) — sweep not started",
    );
    return { stop: () => {} };
  }
  const driver = runtime.driver as SkillBackImportDriver;
  if (typeof driver.readContainerPath !== "function") {
    logger.warn("MYRMIDON_BOT_SKILL_BACKIMPORT is on but the container driver cannot read container paths — sweep not started");
    return { stop: () => {} };
  }
  const deps = createDbSweepPorts(db, driver, listBackImportBots(db));
  running = startSkillBackImportSweep(deps, env);
  return running;
}

export function stopSkillBackImport(): void {
  running?.stop();
  running = null;
}
