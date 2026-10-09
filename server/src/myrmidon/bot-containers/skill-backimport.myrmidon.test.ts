// server/src/myrmidon/bot-containers/skill-backimport.myrmidon.test.ts
//
// myrmidon(1.6.5-BOT-SKILL-BACKIMPORT, OPE-6401): the back-import rules against
// in-memory ports — no DB, no Docker. Covers the acceptance criterion: a skill
// that appears in the container is visible in the company catalog on the next
// pass, a change updates it, an identical pass touches nothing, and the flag
// off is exactly the previous behavior.
//
// Review, points 2-4: the ports track the origin agent per catalog entry and
// the agent's desired-skills list, so the tests also pin the volume-recreation
// criterion (the import re-delivers: the key lands in the author's desired
// skills), the candidate gate being the ports' contract, and the refusal to
// overwrite a human-created or another agent's entry.

import { describe, expect, it } from "vitest";

import {
  backimportBotSkills,
  isBotSkillBackimportEnabled,
  skillFilesHash,
  skillSlugFromDirName,
  type BackimportSkill,
  type BotSkillBackimportPorts,
} from "./skill-backimport.js";

const AGENT = "agent-1";

function memoryPorts(initial: Record<string, { path: string; content: string }[]> = {}) {
  const store = new Map<string, { path: string; content: string }[]>(Object.entries(initial));
  const origin = new Map<string, string | null>();
  const desired = new Set<string>();
  let nextId = 1;
  const calls = { reads: 0, creates: 0, updates: 0, deliveries: 0 };
  const ports: BotSkillBackimportPorts = {
    readSkillByKey: async (_companyId, key) => {
      calls.reads += 1;
      const slug = key.split("/").pop()!;
      const files = store.get(slug);
      return files ? { id: `skill-${slug}`, files, originAgentId: origin.get(slug) ?? null } : null;
    },
    createSkill: async (_companyId, agentId, input) => {
      calls.creates += 1;
      store.set(input.slug, [...input.files]);
      origin.set(input.slug, agentId);
      return { id: `skill-${input.slug}`, versionId: `v-${nextId++}` };
    },
    updateSkill: async (_companyId, agentId, skillId, input) => {
      const currentOrigin = origin.get(skillId.replace(/^skill-/, ""));
      if (currentOrigin !== agentId) {
        throw new Error(
          `skill ${skillId}: catalog entry is ${
            currentOrigin ? `another back-import (agent ${currentOrigin})` : "not a back-import"
          }, not overwritten`,
        );
      }
      calls.updates += 1;
      const slug = skillId.replace(/^skill-/, "");
      const before = store.get(slug) ?? [];
      const changed = JSON.stringify(before) !== JSON.stringify(input.files);
      store.set(slug, [...input.files]);
      return { versionId: changed ? `v-${nextId++}` : null, changed };
    },
    deliverSkillToAgent: async (_companyId, _agentId, key) => {
      calls.deliveries += 1;
      if (desired.has(key)) return { added: false };
      desired.add(key);
      return { added: true };
    },
  };
  return { ports, calls, store, origin, desired };
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
    const summary = await backimportBotSkills("co-1", AGENT, [dir("deploy", files)], ports);
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
    const { ports, calls, desired, origin } = memoryPorts({ deploy: sorted });
    origin.set("deploy", AGENT); // the author's own back-import from a previous pass
    const summary = await backimportBotSkills("co-1", AGENT, [dir("deploy", files)], ports);
    expect(calls.creates).toBe(0);
    expect(calls.updates).toBe(0);
    // Content matched, so no version is cut (versionId null) — and because
    // the agent's desired-skills list does not hold the key yet, the pass
    // re-delivers it (review, point 2), which is the volume-recreation case.
    expect(summary.imported[0]).toMatchObject({ outcome: "re-delivered", versionId: null });
    expect(calls.deliveries).toBe(1);
    expect(desired.has("company/co-1/deploy")).toBe(true);
  });

  it("updates a catalog skill whose content drifted from the container copy", async () => {
    const { ports, calls, store, origin } = memoryPorts({ deploy: [{ path: "SKILL.md", content: "old" }] });
    origin.set("deploy", AGENT); // the author's own back-import from a previous pass
    const summary = await backimportBotSkills("co-1", AGENT, [dir("deploy", files)], ports);
    expect(calls.updates).toBe(1);
    expect(summary.imported[0]).toMatchObject({ outcome: "updated" });
    expect(store.get("deploy")).toEqual([...files].sort((a, b) => a.path.localeCompare(b.path)));
  });

  it("a volume recreation re-delivers the skill: the key lands in the author's desired skills", async () => {
    // Pass 1 imports (creates the entry and adds the key to the author's
    // desired skills). A volume recreation wipes the agent's desired-skills
    // list (it lives in the agent's adapterConfig, which a reset can drop)
    // while the catalog entry survives; pass 2 must re-add the key so the
    // compiler delivers the catalog copy back into the recreated volume.
    const { ports, calls, desired } = memoryPorts();
    await backimportBotSkills("co-1", AGENT, [dir("deploy", files)], ports);
    expect(desired.has("company/co-1/deploy")).toBe(true);
    desired.clear();
    const second = await backimportBotSkills("co-1", AGENT, [dir("deploy", files)], ports);
    expect(second.imported[0]).toMatchObject({ outcome: "re-delivered" });
    expect(desired.has("company/co-1/deploy")).toBe(true);
    expect(calls.updates).toBe(0);
  });

  it("a steady state after delivery is unchanged, not re-delivered again", async () => {
    const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
    const fake = memoryPorts({ deploy: sorted });
    fake.origin.set("deploy", AGENT);
    fake.desired.add("company/co-1/deploy");
    const second = await backimportBotSkills("co-1", AGENT, [dir("deploy", files)], fake.ports);
    expect(second.imported[0]).toMatchObject({ outcome: "unchanged" });
    expect(fake.calls.updates).toBe(0);
    expect(fake.calls.creates).toBe(0);
    expect(fake.calls.deliveries).toBe(1);
  });

  it("refuses to overwrite a human-created catalog entry with the same key (no marker)", async () => {
    const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
    const { ports, calls, store } = memoryPorts({ deploy: sorted }); // origin unset = human/UI entry
    const summary = await backimportBotSkills("co-1", AGENT, [dir("deploy", files)], ports);
    expect(summary.failed).toHaveLength(1);
    expect(summary.failed[0]?.name).toBe("deploy");
    expect(calls.updates).toBe(0);
    expect(calls.creates).toBe(0);
    // The catalog copy is untouched.
    expect(store.get("deploy")).toEqual(sorted);
  });

  it("refuses to overwrite another agent's back-import (two bots, same slug)", async () => {
    const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
    const { ports, calls, origin } = memoryPorts({ deploy: sorted });
    origin.set("deploy", "agent-2");
    const summary = await backimportBotSkills("co-1", AGENT, [dir("deploy", files)], ports);
    expect(summary.failed).toHaveLength(1);
    expect(summary.failed[0]?.error).toContain("another back-import");
    expect(calls.updates).toBe(0);
    expect(origin.get("deploy")).toBe("agent-2");
  });

  it("contains a broken directory (no SKILL.md) to `failed` and still imports the rest", async () => {
    const { ports, calls } = memoryPorts();
    const summary = await backimportBotSkills(
      "co-1",
      AGENT,
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
    const a = await backimportBotSkills("co-1", AGENT, [dir("deploy", files)], ports);
    const b = await backimportBotSkills("co-2", AGENT, [dir("deploy", files)], ports);
    expect(a.imported[0]?.key).toBe("company/co-1/deploy");
    expect(b.imported[0]?.key).toBe("company/co-2/deploy");
  });

  it("delivers the key to the author on create and update, not only on re-import", async () => {
    const { ports, desired } = memoryPorts();
    await backimportBotSkills("co-1", AGENT, [dir("deploy", files)], ports);
    expect(desired.has("company/co-1/deploy")).toBe(true);
    const drifted = await backimportBotSkills(
      "co-1",
      AGENT,
      [dir("deploy", [{ ...files[0]!, content: "---\nname: deploy\ndescription: d2\n---\n\nBody.\n" }, files[1]!])],
      ports,
    );
    expect(drifted.imported[0]).toMatchObject({ outcome: "updated" });
    expect(desired.has("company/co-1/deploy")).toBe(true);
  });
});
