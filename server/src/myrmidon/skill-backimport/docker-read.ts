// server/src/myrmidon/skill-backimport/docker-read.ts
//
// myrmidon(1.6.5-SKILL-BACKIMPORT): the docker seam of the back-import — the
// one place that knows how to pull a bot's skills root out of its container.
// The sweep only knows the SkillBackImportReadPort; this module is the
// production implementation, kept separate so the orchestration stays
// driver-free and testable.
//
// Two pieces, both read-only against the bot:
//
//  - listRunningBotKeys: the driver's listRunning() filtered to the bots the
//    board asked about (dockergate allows no global listing, so the driver
//    answers per bot);
//  - readBotSkillFiles: the driver's readContainerPath of the bot's skills
//    root, parsed with the shared ustar reader (the same pair the
//    clone-report collection uses for its archive reads). The container path
//    comes from botRealRootFromBinds on the inspect the status already
//    carries — one inspect per bot per pass, no second read.
//
// The driver contract this port needs beyond BotContainerDriver (a raw
// container-path read) is declared here as SkillBackImportDriver; the local
// docker driver satisfies it, a driver that cannot (fleetd) simply is not
// wired, and the index then reports the feature as unavailable instead of
// guessing.

import type { BotContainerDriver, BotContainerStatus } from "../bot-containers/driver.js";
import { botRealRootFromBinds } from "../bot-containers/template.js";
import { parseUstarArchive } from "../bot-containers/ustar.js";
import type { BackImportCandidateFile, SkillBackImportReadPort } from "./sweep.js";

/** The driver surface the back-import needs on top of BotContainerDriver:
 *  read one path out of the container as an archive stream. The docker
 *  driver has it (it powers readCloneReport); the type lives here so the
 *  bot-containers module — the dockergate zone — is not touched. */
export interface SkillBackImportDriver extends BotContainerDriver {
  readContainerPath(
    botKey: string,
    containerPath: string,
  ): AsyncIterable<{ kind: "file"; content: Buffer } | { kind: "other" }>;
}

interface DockerInspectForRoot {
  HostConfig?: { Binds?: string[] };
}

/** Keys of the bots whose containers exist and are running. Uses the
 *  driver's listRunning when it has one (dockergate-safe per-bot reads);
 *  falls back to list + a state filter for a driver without it. */
export async function listRunningBotKeys(
  driver: BotContainerDriver,
  botKeys: readonly string[],
): Promise<Set<string>> {
  const statuses = driver.listRunning
    ? await driver.listRunning(botKeys)
    : (await driver.list(botKeys)).filter((bot) => bot.state === "running");
  return new Set(statuses.map((bot: BotContainerStatus) => bot.botKey));
}

export interface DockerSkillReadPortOptions {
  /** Bot key -> container skills-root path (`<root>/hermes/skills`) already
   *  known. When absent the port derives it from the status's inspect. */
  skillsPaths?: Map<string, string>;
}

/** Production read port: the bot's hermes/skills as a ustar listing.
 *  Returns null when the container is not running or the directory is absent
 *  (a bot without skills is normal); a read error is logged by the caller's
 *  try/catch as a failed bot, never thrown across the sweep. */
export function dockerSkillReadPort(
  driver: SkillBackImportDriver,
  options: DockerSkillReadPortOptions = {},
): SkillBackImportReadPort {
  const skillsPaths = options.skillsPaths ?? new Map<string, string>();

  async function skillsPathForBot(botKey: string): Promise<string | null> {
    const cached = skillsPaths.get(botKey);
    if (cached) return cached;
    const status = await driver.status(botKey);
    if (status.state !== "running") return null;
    const inspect = status.inspect as DockerInspectForRoot | undefined;
    const root = botRealRootFromBinds(inspect?.HostConfig?.Binds, botKey);
    const path = `${root}/hermes/skills`;
    skillsPaths.set(botKey, path);
    return path;
  }

  return {
    async readBotSkillFiles(botKey: string): Promise<BackImportCandidateFile[] | null> {
      const containerPath = await skillsPathForBot(botKey);
      if (!containerPath) return null;
      const files: BackImportCandidateFile[] = [];
      try {
        for await (const entry of driver.readContainerPath(botKey, containerPath)) {
          if (entry.kind !== "file") continue;
          const parsed = parseUstarArchive(entry.content);
          for (const file of parsed) {
            if (file.type !== "file") continue;
            files.push({ path: file.path, content: file.content.toString("utf8") });
          }
        }
      } catch {
        // The path read fails when the directory is absent (bot without
        // skills) — normal, reported as "nothing read", not a sweep failure.
        return null;
      }
      return files;
    },
  };
}
