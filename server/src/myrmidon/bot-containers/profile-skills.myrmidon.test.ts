import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { PaperclipSkillEntry } from "@paperclipai/adapter-utils/server-utils";
import { HERMES_GATEWAY_ADAPTER_TYPE, type BotProfileAgentRecord } from "./profile-compile.js";
import { beginBotProfilePass, type BotProfilePass } from "./profile-pass.js";
import {
  createBotProfileSkillLoader,
  versionSelectionSignature,
  type BotProfileSkillReaders,
} from "./profile-skills.js";
import type { SkillLifecycleDelivery } from "../skill-lifecycle/index.js";

// Placeholder data only: fake ids, example paths, obviously-fake content.

const ROOT = mkdtempSync(join(tmpdir(), "bot-profile-skills-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

function skillDirectory(name: string, files: Record<string, string>): string {
  const dir = join(ROOT, name);
  for (const [relative, content] of Object.entries(files)) {
    const target = join(dir, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
  return dir;
}

const SHARED_SOURCE = skillDirectory("shared-skill", { "SKILL.md": "# shared skill\n" });
const OVERSIZED_SOURCE = skillDirectory("oversized-skill", { "SKILL.md": "# big\n" });
writeFileSync(join(OVERSIZED_SOURCE, "big.txt"), "x".repeat(600 * 1024), "utf8");

function agentCard(id: string, desired: Array<string | { key: string; versionId: string | null }> = ["example-skill"]): BotProfileAgentRecord {
  return {
    id,
    companyId: "company-1",
    name: `Bot ${id}`,
    adapterType: HERMES_GATEWAY_ADAPTER_TYPE,
    adapterConfig: { paperclipSkillSync: { desiredSkills: desired } },
    runtimeConfig: {},
  };
}

/**
 * A pass that records which reads actually ran: `once` is the loader's own
 * contract (profile-pass.ts), wrapped so the callback under each key is counted —
 * the cache answers the second and every later caller with the first read.
 */
function countedPass(): { pass: BotProfilePass; ran: string[] } {
  const inner = beginBotProfilePass();
  const ran: string[] = [];
  const spy: BotProfilePass = {
    get ended(): boolean {
      return inner.ended;
    },
    once<T>(key: string, read: () => Promise<T>): Promise<T> {
      return inner.once(key, () => {
        ran.push(key);
        return read();
      });
    },
    end: () => inner.end(),
  };
  return { pass: spy, ran };
}

interface Board {
  readers: BotProfileSkillReaders;
  counts: { experimental: number; lifecycle: number; catalogue: number; selections: string[] };
  /** The readers close over this object, so a test mutates it and not a copy. */
  state: { skills: Array<{ key: string; runtimeName: string; source: string; sourceStatus?: "available" | "missing" }> };
  delivery: SkillLifecycleDelivery;
}

function board(overrides: Partial<BotProfileSkillReaders> = {}): Board {
  const counts = { experimental: 0, lifecycle: 0, catalogue: 0, selections: [] as string[] };
  const state: Board["state"] = {
    skills: [{ key: "example-skill", runtimeName: "example-skill", source: SHARED_SOURCE }],
  };
  const delivery: SkillLifecycleDelivery = {
    blockedKeys: new Set<string>(),
    pinnedVersions: new Map<string, string>(),
    reasons: new Map<string, string>(),
  };
  const readers: BotProfileSkillReaders = {
    async readExperimental() {
      counts.experimental += 1;
      return { enableBetaSkills: true };
    },
    async resolveLifecycle() {
      counts.lifecycle += 1;
      return delivery;
    },
    async listRuntimeSkillEntries(_companyId, options) {
      counts.catalogue += 1;
      counts.selections.push(versionSelectionSignature(options.versionSelections));
      return state.skills.map((skill): PaperclipSkillEntry => ({
        key: skill.key,
        runtimeName: skill.runtimeName,
        source: skill.source,
        versionId: options.versionSelections.get(skill.key) ?? null,
        currentVersionId: "v1",
        sourceStatus: skill.sourceStatus ?? "available",
        missingDetail: skill.sourceStatus === "missing" ? "the source is gone" : null,
      }));
    },
    ...overrides,
  };
  return { readers, counts, state, delivery };
}

const BOTS = ["agent-a", "agent-b", "agent-c"];

describe("myrmidon(PERF-DIET-G): the skills port reads the company scope once per pass", () => {
  it("reads the catalogue, the instance setting and a shared skill's files once for three bots", async () => {
    const b = board();
    const load = createBotProfileSkillLoader(b.readers);
    const { pass, ran } = countedPass();

    const results = [];
    for (const id of BOTS) results.push(await load(agentCard(id), pass));

    expect(b.counts.experimental).toBe(1);
    expect(b.counts.catalogue).toBe(1);
    expect(ran.filter((key) => key.startsWith("skill-files:"))).toHaveLength(1);
    // The delivery decision stays per agent (a candidate reaches the pilot set,
    // not the fleet); only the company-wide reads behind it are shared, inside
    // the service (skill-lifecycle.myrmidon.test.ts).
    expect(b.counts.lifecycle).toBe(3);
    for (const result of results) {
      expect(result.warnings).toEqual([]);
      expect(result.skills["example-skill"]?.[0]?.content).toContain("shared skill");
    }
  });

  it("reads everything again on the next pass: the pass is the invalidation, not a clock", async () => {
    const b = board();
    const load = createBotProfileSkillLoader(b.readers);

    const first = countedPass();
    for (const id of BOTS) await load(agentCard(id), first.pass);
    const second = countedPass();
    for (const id of BOTS) await load(agentCard(id), second.pass);

    expect(b.counts.experimental).toBe(2);
    expect(b.counts.catalogue).toBe(2);
    expect(second.ran.filter((key) => key.startsWith("skill-files:"))).toHaveLength(1);
  });

  it("shares nothing without a pass: each bot of a sweep then pays its own reads", async () => {
    const b = board();
    const load = createBotProfileSkillLoader(b.readers);

    for (const id of BOTS) await load(agentCard(id));

    expect(b.counts.experimental).toBe(3);
    expect(b.counts.catalogue).toBe(3);
  });

  it("resolves the catalogue once per distinct set of version pins, not once per bot", async () => {
    const b = board();
    const load = createBotProfileSkillLoader(b.readers);
    const { pass } = countedPass();

    // Two bots pin the same revision, the third keeps the catalogue's own.
    await load(agentCard("agent-a", [{ key: "example-skill", versionId: "v2" }]), pass);
    await load(agentCard("agent-b", [{ key: "example-skill", versionId: "v2" }]), pass);
    await load(agentCard("agent-c"), pass);

    expect(b.counts.catalogue).toBe(2);
    expect(b.counts.selections).toEqual(expect.arrayContaining([
      versionSelectionSignature(new Map([["example-skill", "v2"]])),
      versionSelectionSignature(new Map([["example-skill", null]])),
    ]));
  });

  it("reports a shared skill's own warnings for every bot that carries it", async () => {
    const b = board();
    // A directory read once, whose warnings concern the skill itself: both bots
    // must see them, not only the one that paid for the read.
    b.state.skills[0]!.source = OVERSIZED_SOURCE;
    const load = createBotProfileSkillLoader(b.readers);
    const { pass, ran } = countedPass();

    const first = await load(agentCard("agent-a"), pass);
    const second = await load(agentCard("agent-b"), pass);

    expect(ran.filter((key) => key.startsWith("skill-files:"))).toHaveLength(1);
    expect(first.warnings.some((line) => line.includes("larger than"))).toBe(true);
    expect(second.warnings).toEqual(first.warnings);
  });

  it("keeps the per-agent outcome: a blocked key, a missing source, a skipped symlink", async () => {
    const b = board();
    b.state.skills = [
      { key: "example-skill", runtimeName: "example-skill", source: SHARED_SOURCE },
      { key: "gone-skill", runtimeName: "gone-skill", source: join(ROOT, "gone"), sourceStatus: "missing" },
    ];
    b.delivery.blockedKeys.add("example-skill");
    b.delivery.reasons.set("example-skill", "skill example-skill: candidate, not in the pilot set");
    const load = createBotProfileSkillLoader(b.readers);

    const blocked = await load(agentCard("agent-a", ["example-skill", "gone-skill"]));
    // Both outcomes stay per agent: the withheld key with the lifecycle's own
    // reason, the missing source from the catalogue entry.
    expect(blocked.skills["example-skill"]).toBeUndefined();
    expect(blocked.warnings).toEqual([
      "skill example-skill: candidate, not in the pilot set",
      "skill gone-skill: source is missing (the source is gone), skipped",
    ]);

    // The same catalogue for a bot the lifecycle does not block: the shared skill
    // arrives and only the missing source warns.
    b.delivery.blockedKeys.clear();
    b.delivery.reasons.clear();
    const delivered = await load(agentCard("agent-b", ["example-skill", "gone-skill"]));
    expect(delivered.skills["example-skill"]).toBeDefined();
    expect(delivered.warnings).toEqual(["skill gone-skill: source is missing (the source is gone), skipped"]);
  });

  it("skips a symlink inside a skill (the read stays inside the skill directory)", async () => {
    const source = skillDirectory("symlinked-skill", { "SKILL.md": "# symlinked skill\n" });
    symlinkSync(join(source, "SKILL.md"), join(source, "alias.md"));
    const b = board();
    b.state.skills = [{ key: "symlink-skill", runtimeName: "symlink-skill", source }];
    const load = createBotProfileSkillLoader(b.readers);

    const result = await load(agentCard("agent-a", ["symlink-skill"]));

    expect(result.skills["symlink-skill"]?.map((file) => file.path)).toEqual(["SKILL.md"]);
    expect(result.warnings.some((line) => line.includes("symlink alias.md skipped"))).toBe(true);
  });
});