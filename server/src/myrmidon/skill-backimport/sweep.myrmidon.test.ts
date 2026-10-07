// server/src/myrmidon/skill-backimport/sweep.myrmidon.test.ts
//
// myrmidon(1.6.5-SKILL-BACKIMPORT): the sweep against fake ports. The
// acceptance points of the ticket are here:
//
//  - a skill that appears in a bot's container is visible in the company
//    catalog after the next pass (imported, versioned, lifecycle candidate);
//  - a second pass over the same bot does not duplicate or overwrite the
//    catalog row (volume recreation does not lose the skill, and the board
//    stays the authority);
//  - with the gate off nothing is read and nothing is written (current
//    behaviour);
//  - one failing bot never stops the pass.

import { describe, expect, it } from "vitest";
import { createSkillBackImportSweep, type SkillBackImportDeps } from "./sweep.js";
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

interface FakeCatalog {
  keys: Set<string>;
  slugs: Set<string>;
  upserts: Array<{ key: string; slug: string }>;
  versions: Array<{ skillId: string; label: string }>;
  materialized: string[];
}

function fakeDeps(overrides: Partial<SkillBackImportDeps> = {}) {
  const catalog: FakeCatalog = {
    keys: new Set(),
    slugs: new Set(),
    upserts: [],
    versions: [],
    materialized: [],
  };
  const candidates: string[] = [];
  const reads: string[] = [];
  const deps: SkillBackImportDeps = {
    listBots: async () => [{ botKey: BOT, companyId: COMPANY }],
    listRunningBotKeys: async () => new Set([BOT]),
    readPort: {
      async readBotSkillFiles(botKey: string) {
        reads.push(botKey);
        return [{ path: "vendor-triage/SKILL.md", content: SKILL_MD }];
      },
    },
    catalog: {
      async listExisting() {
        return { keys: catalog.keys, slugs: catalog.slugs };
      },
      async upsertImportedSkill(_companyId: string, input) {
        catalog.upserts.push({ key: input.key, slug: input.slug });
        catalog.keys.add(input.key);
        catalog.slugs.add(input.slug);
        return { id: `skill-${catalog.upserts.length}` };
      },
      async createVersion(_companyId: string, skillId: string, input: { label: string }) {
        catalog.versions.push({ skillId, label: input.label });
        return { id: `version-${catalog.versions.length}` };
      },
      async materializeSkill(_companyId: string, skillId: string) {
        catalog.materialized.push(skillId);
      },
    },
    lifecycle: {
      async setCandidate(_companyId: string, skillId: string) {
        candidates.push(skillId);
      },
    },
    env: { [SKILL_BACKIMPORT_ENABLED_ENV]: "1" },
    ...overrides,
  };
  return { deps, catalog, candidates, reads };
}

describe("createSkillBackImportSweep", () => {
  it("does nothing while the gate is off", async () => {
    const { deps, reads, catalog } = fakeDeps({ env: {} });
    const sweep = createSkillBackImportSweep(deps);
    const result = await sweep();
    expect(result).toMatchObject({ enabled: false, botsRead: 0, imported: 0 });
    expect(reads).toEqual([]);
    expect(catalog.upserts).toEqual([]);
  });

  it("imports a skill that appeared in a bot's container into the catalog", async () => {
    const { deps, catalog, candidates } = fakeDeps();
    const sweep = createSkillBackImportSweep(deps);
    const result = await sweep();
    expect(result).toMatchObject({ enabled: true, botsRead: 1, imported: 1, failed: 0 });
    expect(catalog.upserts).toEqual([{ key: `company/${COMPANY}/vendor-triage`, slug: "vendor-triage" }]);
    // A version snapshot is recorded, and the lifecycle marks the skill a
    // candidate — the board sees it and the next profile compile can deliver
    // it to any bot of the company.
    expect(catalog.versions).toHaveLength(1);
    expect(candidates).toEqual(["skill-1"]);
  });

  it("does not import twice (the volume can be recreated; the catalog keeps the skill)", async () => {
    const { deps, catalog } = fakeDeps();
    const sweep = createSkillBackImportSweep(deps);
    await sweep();
    const second = await sweep();
    expect(second.imported).toBe(0);
    expect(catalog.upserts).toHaveLength(1);
    expect(catalog.versions).toHaveLength(1);
  });

  it("skips a bot that is not running", async () => {
    const { deps, reads } = fakeDeps({ listRunningBotKeys: async () => new Set() });
    const sweep = createSkillBackImportSweep(deps);
    const result = await sweep();
    expect(result).toMatchObject({ botsRead: 0, imported: 0 });
    expect(reads).toEqual([]);
  });

  it("treats a bot without a skills directory as nothing to import", async () => {
    const { deps } = fakeDeps({
      readPort: { async readBotSkillFiles() { return null; } },
    });
    const sweep = createSkillBackImportSweep(deps);
    const result = await sweep();
    expect(result).toMatchObject({ botsRead: 1, imported: 0, failed: 0 });
  });

  it("keeps the pass going when one bot fails", async () => {
    const OTHER = "10000000-0000-4000-8000-0000000000b2";
    const { deps, catalog } = fakeDeps({
      listBots: async () => [
        { botKey: BOT, companyId: COMPANY },
        { botKey: OTHER, companyId: COMPANY },
      ],
      listRunningBotKeys: async () => new Set([BOT, OTHER]),
      readPort: {
        async readBotSkillFiles(botKey: string) {
          if (botKey === BOT) throw new Error("docker unreachable");
          return [{ path: "vendor-triage/SKILL.md", content: SKILL_MD }];
        },
      },
    });
    const sweep = createSkillBackImportSweep(deps);
    const result = await sweep();
    expect(result).toMatchObject({ botsRead: 2, imported: 1, failed: 1 });
    expect(catalog.upserts).toHaveLength(1);
  });

  it("is single-flight: a second call while a pass runs joins it", async () => {
    let resolveRead: ((files: null) => void) | null = null;
    let readStarted!: () => void;
    const readStartedPromise = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    const { deps, reads } = fakeDeps({
      readPort: {
        readBotSkillFiles: (botKey: string) => {
          reads.push(botKey);
          readStarted();
          return new Promise<null>((resolve) => {
            resolveRead = resolve;
          });
        },
      },
    });
    const sweep = createSkillBackImportSweep(deps);
    const first = sweep();
    // Wait until the first pass has actually started its read.
    await readStartedPromise;
    const second = sweep();
    expect(reads).toHaveLength(1);
    resolveRead!(null);
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
  });
});
