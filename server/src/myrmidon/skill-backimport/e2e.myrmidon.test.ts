// server/src/myrmidon/skill-backimport/e2e.myrmidon.test.ts
//
// myrmidon(1.6.5-SKILL-BACKIMPORT): the ticket's acceptance as one flow —
// a skill appears in a bot's container, a pass runs, and the board can then
// answer "give me the verified content for this skill" even with the bot's
// volume gone. The bot side is a fake driver with an in-memory volume; the
// board side is a minimal in-memory catalog whose files the lifecycle's
// verifiedContent reads — the same two reads the real wiring makes
// (getByKey/createLocalSkill + createVersion + setCandidate), without a
// database.

import { describe, expect, it } from "vitest";
import { buildUstarArchive } from "../bot-containers/ustar.js";
import type { BotContainerStatus } from "../bot-containers/driver.js";
import { createSkillBackImportSweep, type SkillBackImportCatalogPort } from "./sweep.js";
import { dockerSkillReadPort, listRunningBotKeys, type SkillBackImportDriver } from "./docker-read.js";
import { SKILL_BACKIMPORT_ENABLED_ENV } from "./settings.js";

const COMPANY = "10000000-0000-4000-8000-000000000001";
const BOT = "10000000-0000-4000-8000-0000000000b1";

const SKILL_MD = [
  "---",
  "name: Vendor Triage",
  "description: Classifies vendor replies into a queue.",
  "---",
  "",
  "Read the reply, decide the queue, move the ticket.",
].join("\n");

/** A bot container whose "volume" is a map of files — wiped to simulate a
 *  volume recreation. */
function fakeBotContainer() {
  const volume = new Map<string, string>();
  const driver: SkillBackImportDriver = {
    status: async () => ({ botKey: BOT, state: "running", inspect: { HostConfig: { Binds: [] } } }) as BotContainerStatus,
    list: async (botKeys: readonly string[]) =>
      botKeys.map((botKey) => ({ botKey, state: "running" }) as BotContainerStatus),
    templateDrift: async () => ({ drifted: false, fields: [] }),
    create: async () => {},
    recreate: async () => {},
    writeProfile: async () => {},
    start: async () => {},
    restart: async () => {},
    stop: async () => {},
    readContainerPath: async function* (_botKey: string, containerPath: string) {
      const prefix = `${containerPath}/`;
      const entries = [...volume.entries()].filter(([path]) => path.startsWith(prefix));
      if (entries.length === 0) throw new Error("no such file or directory");
      yield {
        kind: "file" as const,
        content: buildUstarArchive(
          entries.map(([path, content]) => ({
            path: path.slice(prefix.length),
            content: Buffer.from(content, "utf8"),
            mode: 0o644,
            uid: 0,
            gid: 0,
          })),
        ),
      };
    },
  } as unknown as SkillBackImportDriver;
  return {
    driver,
    /** The bot writes a skill into its volume (the acceptance "appears"). */
    botWritesSkill(directory: string, files: Record<string, string>) {
      for (const [path, content] of Object.entries(files)) {
        volume.set(`/bot/hermes/skills/${directory}/${path}`, content);
      }
    },
    /** The volume is recreated — everything the bot wrote is gone. */
    recreateVolume() {
      volume.clear();
    },
  };
}

/** The board side: an in-memory catalog with the two reads the wiring makes
 *  (existing keys/slugs, the persisted record) and the verified-content
 *  answer the profile compiler asks for. */
function fakeBoardCatalog() {
  interface StoredSkill {
    id: string;
    key: string;
    slug: string;
    markdown: string;
    files: Array<{ path: string; content: string }>;
    lifecycleState: string | null;
  }
  const skills = new Map<string, StoredSkill>();
  let nextId = 0;
  const catalog: SkillBackImportCatalogPort = {
    async listExisting() {
      return {
        keys: new Set([...skills.values()].map((skill) => skill.key)),
        slugs: new Set([...skills.values()].map((skill) => skill.slug)),
      };
    },
    async upsertImportedSkill(_companyId: string, input) {
      const existing = [...skills.values()].find((skill) => skill.key === input.key);
      if (existing) return { id: existing.id };
      nextId += 1;
      const skill: StoredSkill = {
        id: `skill-${nextId}`,
        key: input.key,
        slug: input.slug,
        markdown: input.markdown,
        files: input.fileInventory.map((file) => ({ path: file.path, content: file.content })),
        lifecycleState: null,
      };
      skills.set(skill.id, skill);
      return { id: skill.id };
    },
    async createVersion() {
      return { id: "version-1" };
    },
    async materializeSkill() {},
  };
  return {
    catalog,
    /** The profile compiler's question after a volume loss: the verified
     *  content of the skill, from the board's copy alone. */
    verifiedContent(skillKey: string) {
      const skill = [...skills.values()].find((entry) => entry.key === skillKey);
      if (!skill || skill.lifecycleState !== "candidate") return null;
      return { markdown: skill.markdown, files: skill.files };
    },
    markCandidate(skillId: string) {
      const skill = skills.get(skillId);
      if (skill) skill.lifecycleState = "candidate";
    },
  };
}

describe("back-import end-to-end (fake driver + in-memory board)", () => {
  it("a skill written in the container survives the volume recreation through the catalog", async () => {
    const bot = fakeBotContainer();
    const board = fakeBoardCatalog();
    const env = { [SKILL_BACKIMPORT_ENABLED_ENV]: "1" };

    const sweep = createSkillBackImportSweep({
      listBots: async () => [{ botKey: BOT, companyId: COMPANY }],
      listRunningBotKeys: (botKeys) => listRunningBotKeys(bot.driver, botKeys),
      readPort: dockerSkillReadPort(bot.driver),
      catalog: board.catalog,
      lifecycle: {
        async setCandidate(_companyId, skillId) {
          board.markCandidate(skillId);
        },
      },
      env,
    });

    // Before the bot authors anything, a pass imports nothing.
    expect((await sweep()).imported).toBe(0);

    // The bot authors a skill in its container.
    bot.botWritesSkill("vendor-triage", { "SKILL.md": SKILL_MD });

    // Next reconciliation: the skill is in the company catalog, a candidate.
    const pass = await sweep();
    expect(pass.imported).toBe(1);
    const key = `company/${COMPANY}/vendor-triage`;

    // The volume is recreated; the bot's copy is gone.
    bot.recreateVolume();

    // The board still serves the skill's content — the profile compiler of
    // any bot of the company gets it again.
    const delivered = board.verifiedContent(key);
    expect(delivered).not.toBeNull();
    expect(delivered!.markdown).toBe(SKILL_MD);

    // And a later pass (the recreated container has no skills) does not
    // duplicate or remove the catalog row.
    const after = await sweep();
    expect(after.imported).toBe(0);
    expect(board.verifiedContent(key)).not.toBeNull();
  });
});
