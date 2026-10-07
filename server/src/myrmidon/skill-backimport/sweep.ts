// server/src/myrmidon/skill-backimport/sweep.ts
//
// myrmidon(1.6.5-SKILL-BACKIMPORT): the back-import pass. For every running
// hermes_gateway bot it reads the bot's skills root out of the container
// (through the injected read port — the docker seam lives in docker-read.ts,
// never in this module), classifies the files into bot-authored skills
// (policy.ts), and imports each new one into the company catalog through the
// existing services: the catalog upsert creates the skill row, a version is
// recorded from the snapshot, and the lifecycle marks the skill a candidate —
// so the board sees it, and the next profile compile of any bot of the
// company can deliver it even after the bot's volume is recreated.
//
// Every side effect is an injected port: the sweep itself has no docker, fs,
// or env access, and the per-bot work is wrapped so one failing bot never
// stops the pass. Re-entrancy is single-flight per process; the interval
// throttle lives in the scheduler (index.ts), not here, so a pass asked for
// explicitly (a route, a test) always runs.

import {
  buildBackImportInventory,
  classifyBotSkillFiles,
  deriveBackImportTrustLevel,
  type BackImportCandidateFile,
} from "./policy.js";
import { readSkillBackImportSettings, type SkillBackImportSettings } from "./settings.js";

/** What the sweep needs to know about one bot to read its skills. */
export interface SkillBackImportBot {
  /** Agent id (uuid) — also the bot key the driver knows the container by. */
  botKey: string;
  companyId: string;
}

/** One file below a bot's skills root, as the read port returns it. */
export type { BackImportCandidateFile };

export interface SkillBackImportReadPort {
  /** All regular files below the running bot's skills root
   *  (`<bot root>/hermes/skills`), paths relative to that root, or null when
   *  the container/the directory is not there or cannot be read. Must never
   *  throw for a missing directory — a bot without skills is normal. */
  readBotSkillFiles(botKey: string): Promise<BackImportCandidateFile[] | null>;
}

/** The catalog-side writes, injected so the sweep is testable without the
 *  database services barrel (and so the wiring can lazy-import them). */
export interface SkillBackImportCatalogPort {
  /** Keys and slugs the company catalog already holds (to skip the board's
   *  own delivered copies and slug collisions). */
  listExisting(companyId: string): Promise<{ keys: Set<string>; slugs: Set<string> }>;
  /** Create-or-update the skill row from the import. Returns the skill id. */
  upsertImportedSkill(companyId: string, input: {
    key: string;
    slug: string;
    name: string;
    description: string | null;
    markdown: string;
    sourceLocator: string | null;
    trustLevel: "markdown_only" | "assets" | "scripts_executables";
    fileInventory: Array<{ path: string; kind: string; content: string }>;
    metadata: Record<string, unknown>;
  }): Promise<{ id: string }>;
  /** Record a version snapshot of the just-imported content. */
  createVersion(companyId: string, skillId: string, input: { label: string }): Promise<{ id: string }>;
  /** Materialize the skill's files onto the managed skills root so the
   *  runtime source resolves even with the bot's volume gone. */
  materializeSkill(companyId: string, skillId: string): Promise<void>;
}

/** The lifecycle-side write. */
export interface SkillBackImportLifecyclePort {
  /** Mark the skill a candidate (unverified until a human promotes it). */
  setCandidate(companyId: string, skillId: string): Promise<void>;
}

export interface SkillBackImportDeps {
  /** The bots to sweep: every hermes_gateway bot with an enabled container
   *  block, with its company. */
  listBots(): Promise<SkillBackImportBot[]>;
  /** Keys of the bots whose containers are running right now. */
  listRunningBotKeys(botKeys: readonly string[]): Promise<Set<string>>;
  readPort: SkillBackImportReadPort;
  catalog: SkillBackImportCatalogPort;
  lifecycle: SkillBackImportLifecyclePort;
  env?: NodeJS.ProcessEnv;
  log?: {
    warn(obj: Record<string, unknown>, msg: string): void;
    info(obj: Record<string, unknown>, msg: string): void;
  };
}

export interface SkillBackImportResult {
  enabled: boolean;
  /** Bots whose skills root was read. */
  botsRead: number;
  imported: number;
  /** Already-present or otherwise not imported directories. */
  skipped: number;
  failed: number;
}

const noopLog = {
  warn: () => {},
  info: () => {},
};

export function createSkillBackImportSweep(deps: SkillBackImportDeps) {
  const env = deps.env ?? process.env;
  const log = deps.log ?? noopLog;
  let inFlight: Promise<SkillBackImportResult> | null = null;

  async function runOnce(settings: SkillBackImportSettings): Promise<SkillBackImportResult> {
    const result: SkillBackImportResult = { enabled: settings.enabled, botsRead: 0, imported: 0, skipped: 0, failed: 0 };
    if (!settings.enabled) return result;

    const bots = await deps.listBots();
    if (bots.length === 0) return result;
    const running = await deps.listRunningBotKeys(bots.map((bot) => bot.botKey));

    for (const bot of bots) {
      if (!running.has(bot.botKey)) continue;
      result.botsRead += 1;
      try {
        const files = await deps.readPort.readBotSkillFiles(bot.botKey);
        if (!files || files.length === 0) continue;
        const existing = await deps.catalog.listExisting(bot.companyId);
        const classified = classifyBotSkillFiles({
          companyId: bot.companyId,
          files,
          existingKeys: existing.keys,
          existingSlugs: existing.slugs,
        });
        result.skipped += classified.skipped.length;
        for (const note of classified.skipped) {
          log.warn({ botKey: bot.botKey, directory: note.directory, reason: note.reason }, "skill back-import skipped a directory");
        }
        for (const skill of classified.skills) {
          try {
            const inventory = buildBackImportInventory(skill);
            const trustLevel = deriveBackImportTrustLevel(inventory);
            const persisted = await deps.catalog.upsertImportedSkill(bot.companyId, {
              key: skill.key,
              slug: skill.slug,
              name: skill.name,
              description: skill.description,
              markdown: skill.markdown,
              sourceLocator: null,
              trustLevel,
              fileInventory: inventory,
              metadata: {
                sourceKind: "bot_backimport",
                originAgentId: bot.botKey,
                originDirectory: skill.directory,
              },
            });
            await deps.catalog.createVersion(bot.companyId, persisted.id, {
              label: `Back-imported from bot ${bot.botKey}`,
            });
            await deps.catalog.materializeSkill(bot.companyId, persisted.id);
            await deps.lifecycle.setCandidate(bot.companyId, persisted.id);
            result.imported += 1;
            log.info({ botKey: bot.botKey, skillKey: skill.key, trustLevel }, "bot-authored skill back-imported into the company catalog");
          } catch (err) {
            result.failed += 1;
            log.warn({ err, botKey: bot.botKey, skillKey: skill.key }, "skill back-import failed for one skill");
          }
        }
      } catch (err) {
        result.failed += 1;
        log.warn({ err, botKey: bot.botKey }, "skill back-import read failed for one bot");
      }
    }
    return result;
  }

  return async function sweep(): Promise<SkillBackImportResult> {
    if (inFlight) return inFlight;
    inFlight = runOnce(readSkillBackImportSettings(env))
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}
