// server/src/myrmidon/bot-containers/skill-backimport.myrmidon.test.ts
//
// myrmidon(1.6.5-BOT-SKILL-BACKIMPORT, OPE-6401): the back-import rules against
// in-memory ports — no DB, no Docker. Covers the acceptance criterion: a skill
// that appears in the container is visible in the company catalog on the next
// pass, a change updates it, an identical pass touches nothing, and the flag
// off is exactly the previous behavior.

import { describe, expect, it } from "vitest";

import {
  backimportBotSkills,
  isBotSkillBackimportEnabled,
  skillFilesHash,
  skillSlugFromDirName,
  type BackimportSkill,
  type BotSkillBackimportPorts,
} from "./skill-backimport.js";

function memoryPorts(initial: Record<string, { path: string; content: string }[]> = {}) {
  const store = new Map<string, { path: string; content: string }[]>(Object.entries(initial));
  let nextId = 1;
  const calls = { reads: 0, creates: 0, updates: 0 };
  const ports: BotSkillBackimportPorts = {
    readSkillByKey: async (_companyId, key) => {
      calls.reads += 1;
      const slug = key.split("/").pop()!;
      const files = store.get(slug);
      return files ? { id: `skill-${slug}`, files } : null;
    },
    createSkill: async (_companyId, input) => {
      calls.creates += 1;
      store.set(input.slug, [...input.files]);
      return { id: `skill-${input.slug}`, versionId: `v-${nextId++}` };
    },
    updateSkill: async (_companyId, skillId, input) => {
      calls.updates += 1;
      const slug = skillId.replace(/^skill-/, "");
      const before = store.get(slug) ?? [];
      const changed = JSON.stringify(before) !== JSON.stringify(input.files);
      store.set(slug, [...input.files]);
      return { versionId: changed ? `v-${nextId++}` : null, changed };
    },
  };
  return { ports, calls, store };
}

const dir = (name: string, files: { path: string; content: string }[]): BackimportSkill => ({ name, files });

describe("isBotSkillBackimportEnabled", () => {
  it("is off by default and off for any value but the truthy set", () => {
    expect(isBotSkillBackimportEnabled({})).toBe(false);
    expect(isBotSkillBackimportEnabled({ MYRMIDON_BOT_SKILL_BACKIMPORT: "0" })).toBe(false);
    expect(isBotSkillBackimportEnabled({ MYRMIDON_BOT_SKILL_BACKIMPORT: "yes please" })).toBe(false);
    expect(isBotSkillBackimportEnabled({ MYRMIDON_BOT_SKILL_BACKIMPORT: "1" })).toBe(true);
    expect(isBotSkillBackimportEnabled({ MYRMIDON_BOT_SKILL_BACKIMPORT: "true" })).toBe(true);
    expect(isBotSkillBackimportEnabled({ MYRMIDON_BOT_SKILL_BACKIMPORT: "on" })).toBe(true);
  });
});

describe("skillSlugFromDirName", () => {
  it("keeps slug-shaped names and normalizes the rest", () => {
    expect(skillSlugFromDirName("deploy")).toBe("deploy");
    expect(skillSlugFromDirName("My Deploy!")).toBe("my-deploy");
    expect(skillSlugFromDirName("!!!")).toBe("skill");
  });
});

describe("skillFilesHash", () => {
  it("is order-insensitive over the file list", () => {
    const a = skillFilesHash([
      { path: "SKILL.md", content: "---\nname: x\n---\n" },
      { path: "ref/a.md", content: "a" },
    ]);
    const b = skillFilesHash([
      { path: "ref/a.md", content: "a" },
      { path: "SKILL.md", content: "---\nname: x\n---\n" },
    ]);
    expect(a).toBe(b);
  });

  it("changes with content and with the file set", () => {
    const base = skillFilesHash([{ path: "SKILL.md", content: "x" }]);
    expect(skillFilesHash([{ path: "SKILL.md", content: "y" }])).not.toBe(base);
    expect(skillFilesHash([{ path: "SKILL.md", content: "x" }, { path: "b.md", content: "" }])).not.toBe(base);
  });
});

describe("backimportBotSkills", () => {
  const files = [
    { path: "SKILL.md", content: "---\nname: deploy\ndescription: d\n---\n\nBody.\n" },
    { path: "references/steps.md", content: "steps" },
  ];

  it("creates a catalog skill for a directory the catalog does not have", async () => {
    const { ports, calls } = memoryPorts();
    const summary = await backimportBotSkills("co-1", [dir("deploy", files)], ports);
    expect(calls.creates).toBe(1);
    expect(calls.updates).toBe(0);
    expect(summary.failed).toEqual([]);
    expect(summary.imported).toHaveLength(1);
    expect(summary.imported[0]).toMatchObject({
      name: "deploy",
      key: "company/co-1/deploy",
      outcome: "created",
    });
  });

  it("skips a directory whose content matches the catalog skill (no version cut)", async () => {
    const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
    const { ports, calls } = memoryPorts({ deploy: sorted });
    const summary = await backimportBotSkills("co-1", [dir("deploy", files)], ports);
    expect(calls.creates).toBe(0);
    expect(calls.updates).toBe(0);
    expect(summary.imported[0]).toMatchObject({ outcome: "unchanged", versionId: null });
  });

  it("updates a catalog skill whose content drifted from the container copy", async () => {
    const { ports, calls, store } = memoryPorts({ deploy: [{ path: "SKILL.md", content: "old" }] });
    const summary = await backimportBotSkills("co-1", [dir("deploy", files)], ports);
    expect(calls.updates).toBe(1);
    expect(summary.imported[0]).toMatchObject({ outcome: "updated" });
    expect(store.get("deploy")).toEqual([...files].sort((a, b) => a.path.localeCompare(b.path)));
  });

  it("a volume recreation re-delivers the skill: after import the catalog copy matches the container", async () => {
    // Pass 1 imports; pass 2 (as after a volume loss, when the profile has
    // delivered the catalog copy back into hermes/skills-board and the bot's
    // own dir is unchanged) sees identical content and writes nothing.
    const { ports, calls } = memoryPorts();
    await backimportBotSkills("co-1", [dir("deploy", files)], ports);
    const second = await backimportBotSkills("co-1", [dir("deploy", files)], ports);
    expect(second.imported[0]).toMatchObject({ outcome: "unchanged" });
    expect(calls.updates).toBe(0);
  });

  it("contains a broken directory (no SKILL.md) to `failed` and still imports the rest", async () => {
    const { ports, calls } = memoryPorts();
    const summary = await backimportBotSkills(
      "co-1",
      [dir("broken", [{ path: "ref.md", content: "x" }]), dir("deploy", files)],
      ports,
    );
    expect(summary.failed).toHaveLength(1);
    expect(summary.failed[0]?.name).toBe("broken");
    expect(summary.imported).toHaveLength(1);
    expect(calls.creates).toBe(1);
  });

  it("scopes the catalog key by company: two companies' bots never collide", async () => {
    const { ports } = memoryPorts();
    const a = await backimportBotSkills("co-1", [dir("deploy", files)], ports);
    const b = await backimportBotSkills("co-2", [dir("deploy", files)], ports);
    expect(a.imported[0]?.key).toBe("company/co-1/deploy");
    expect(b.imported[0]?.key).toBe("company/co-2/deploy");
  });
});
