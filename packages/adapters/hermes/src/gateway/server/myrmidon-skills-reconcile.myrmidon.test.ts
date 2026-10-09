import { describe, expect, it, vi, afterEach } from "vitest";
import {
  buildPaperclipSkillsField,
  factCheckGatewayPaperclipSkills,
  reconcileGatewayPaperclipSkills,
  PAPERCLIP_SKILLS_FIELD,
} from "./myrmidon-skills-reconcile.js";

// myrmidon(1.6.5-HERMES-SKILLS-A): the gateway adapter delivers company
// skills through the run body (paperclip_skills) because the gateway API has
// no profile-skills write endpoint. These tests pin the reconcile + fact-check
// contract: agent-scoped isolation, parallel runs not clobbering each other,
// unassign clearing only the managed entries, the run refusing to start when
// a desired skill cannot be delivered, and the no-op path when the config
// carries no paperclipRuntimeSkills key at all.

const MODULE_DIR = "/nonexistent-module-dir";

function skillConfig(entries: unknown, desiredSkills?: string[]): Record<string, unknown> {
  const config: Record<string, unknown> = { paperclipRuntimeSkills: entries };
  if (desiredSkills) config.paperclipSkillSync = { desiredSkills };
  return config;
}

function skillEntry(key: string, runtimeName: string, source: string) {
  return { key, runtimeName, source };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("reconcileGatewayPaperclipSkills", () => {
  it("returns null when the config carries no paperclipRuntimeSkills key (developer outside the board is unaffected)", async () => {
    const result = await reconcileGatewayPaperclipSkills(
      { apiBaseUrl: "http://gw.local" },
      { moduleDir: MODULE_DIR },
    );
    expect(result).toBeNull();
    expect(buildPaperclipSkillsField(result)).toBeUndefined();
  });

  it("delivers only the desired entries, as {path, name, content} sorted by path", async () => {
    const readFile = vi.fn(async (path: string) => {
      if (path === "/skills/alpha/SKILL.md") return "---\nname: alpha\n---\nAlpha body";
      if (path === "/skills/beta/SKILL.md") return "---\nname: beta\n---\nBeta body";
      throw new Error(`unexpected read: ${path}`);
    });
    const config = skillConfig([
      skillEntry("company/alpha", "alpha", "/skills/alpha"),
      skillEntry("company/beta", "beta", "/skills/beta"),
      skillEntry("company/gamma", "gamma", "/skills/gamma"),
    ]);
    config.paperclipSkillSync = { desiredSkills: ["company/alpha", "company/beta"] };
    const result = await reconcileGatewayPaperclipSkills(config, {
      moduleDir: MODULE_DIR,
      readFile,
    });
    expect(result).not.toBeNull();
    expect(result!.skills.map((s) => s.path)).toEqual(["alpha", "beta"]);
    expect(result!.skills[0]).toMatchObject({ name: "alpha", content: expect.stringContaining("Alpha body") });
    expect(result!.desiredSkills).toEqual(["company/alpha", "company/beta"]);
    expect(readFile).toHaveBeenCalledTimes(2);
  });

  it("throws the board-facing message when a desired skill's source is missing", async () => {
    // Missing sources come through as sourceStatus: "missing" with a
    // placeholder source path (normalizeConfiguredPaperclipRuntimeSkills
    // requires a non-empty source; readPaperclipRuntimeSkillEntries marks the
    // entry missing when the path does not resolve).
    const config = skillConfig(
      [{ ["key"]: "company/broken", runtimeName: "broken", source: "/gone/broken", sourceStatus: "missing" }],
      ["company/broken"],
    );
    await expect(
      reconcileGatewayPaperclipSkills(config, { moduleDir: MODULE_DIR }),
    ).rejects.toThrow(
      "Cannot start without the required Paperclip-managed skills: company/broken: skill source is missing",
    );
  });

  it("throws when the desired skill's SKILL.md cannot be read", async () => {
    const readFile = vi.fn(async () => {
      throw new Error("ENOENT");
    });
    const config = skillConfig(
      [skillEntry("company/alpha", "alpha", "/skills/alpha")],
      ["company/alpha"],
    );
    await expect(
      reconcileGatewayPaperclipSkills(config, { moduleDir: MODULE_DIR, readFile }),
    ).rejects.toThrow(
      "Cannot start without the required Paperclip-managed skills: company/alpha: cannot read the skill source (ENOENT)",
    );
  });

  it("two agents' reconciles never share state (agent isolation)", async () => {
    const agentAConfig = skillConfig(
      [skillEntry("company/alpha", "alpha", "/a/alpha")],
      ["company/alpha"],
    );
    const agentBConfig = skillConfig(
      [skillEntry("company/beta", "beta", "/b/beta")],
      ["company/beta"],
    );
    const readFile = vi.fn(async (path: string) => `content of ${path}`);
    const [a, b] = await Promise.all([
      reconcileGatewayPaperclipSkills(agentAConfig, { moduleDir: MODULE_DIR, readFile }),
      reconcileGatewayPaperclipSkills(agentBConfig, { moduleDir: MODULE_DIR, readFile }),
    ]);
    expect(a!.skills.map((s) => s.name)).toEqual(["alpha"]);
    expect(b!.skills.map((s) => s.name)).toEqual(["beta"]);
    const aField = buildPaperclipSkillsField(a);
    const bField = buildPaperclipSkillsField(b);
    expect(aField!.map((s) => s.name)).toEqual(["alpha"]);
    expect(bField!.map((s) => s.name)).toEqual(["beta"]);
    expect(aField).not.toBe(bField);
  });

  it("parallel reconciles of two agents complete without interleaving writes", async () => {
    const readFile = vi.fn(async (path: string) => `content of ${path}`);
    const agentAConfig = skillConfig(
      [skillEntry("company/alpha", "alpha", "/a/alpha")],
      ["company/alpha"],
    );
    const agentBConfig = skillConfig(
      [skillEntry("company/beta", "beta", "/b/beta")],
      ["company/beta"],
    );
    const results = await Promise.all([
      reconcileGatewayPaperclipSkills(agentAConfig, { moduleDir: MODULE_DIR, readFile }),
      reconcileGatewayPaperclipSkills(agentBConfig, { moduleDir: MODULE_DIR, readFile }),
      reconcileGatewayPaperclipSkills(agentAConfig, { moduleDir: MODULE_DIR, readFile }),
      reconcileGatewayPaperclipSkills(agentBConfig, { moduleDir: MODULE_DIR, readFile }),
    ]);
    for (const r of results) {
      expect(r!.skills).toHaveLength(1);
      expect(["alpha", "beta"]).toContain(r!.skills[0].name);
    }
  });

  it("unassign: empty desired list yields an empty delivery (the receiver clears the managed segment)", async () => {
    const config = skillConfig(
      [skillEntry("company/alpha", "alpha", "/skills/alpha")],
      [],
    );
    const result = await reconcileGatewayPaperclipSkills(config, {
      moduleDir: MODULE_DIR,
      readFile: vi.fn(async () => "x"),
    });
    expect(result!.skills).toEqual([]);
    // The key is present, so the field is sent as [] — the receiver clears the
    // profile's managed segment. Dropping it would leave the unassigned skill
    // on the bot.
    expect(buildPaperclipSkillsField(result)).toEqual([]);
    expect(JSON.stringify({ paperclip_skills: buildPaperclipSkillsField(result) })).toBe('{"paperclip_skills":[]}');
  });

  it("delivers a company skill under its real runtimeName slug--hash and fact-checks it", async () => {
    const config = skillConfig(
      [skillEntry("company/acme/alpha", "alpha--1a2b3c4d5e", "/skills/alpha")],
      ["company/acme/alpha"],
    );
    const result = await reconcileGatewayPaperclipSkills(config, {
      moduleDir: MODULE_DIR,
      readFile: vi.fn(async () => "x"),
    });
    expect(result!.skills.map((s) => s.name)).toEqual(["alpha--1a2b3c4d5e"]);
    expect(result!.desiredEntries).toEqual([{ key: "company/acme/alpha", name: "alpha--1a2b3c4d5e" }]);
    expect(() =>
      factCheckGatewayPaperclipSkills({
        skills: buildPaperclipSkillsField(result)!,
        desiredEntries: result!.desiredEntries,
      }),
    ).not.toThrow();
  });

  it("refuses two desired skills that resolve to the same delivered name", async () => {
    const config = skillConfig(
      [
        skillEntry("company/a/alpha", "alpha", "/skills/a"),
        skillEntry("company/b/alpha", "alpha", "/skills/b"),
      ],
      ["company/a/alpha", "company/b/alpha"],
    );
    await expect(
      reconcileGatewayPaperclipSkills(config, { moduleDir: MODULE_DIR, readFile: vi.fn(async () => "x") }),
    ).rejects.toThrow("another desired skill already uses the delivered name alpha");
  });

  it("no explicit preference delivers nothing — the same contract as hermes_local (skills.ts:216-222)", async () => {
    const config = skillConfig([skillEntry("company/alpha", "alpha", "/skills/alpha")]);
    const result = await reconcileGatewayPaperclipSkills(config, {
      moduleDir: MODULE_DIR,
      readFile: vi.fn(async () => "x"),
    });
    expect(result!.skills).toEqual([]);
    expect(result!.desiredSkills).toEqual([]);
    expect(result!.desiredEntries).toEqual([]);
  });
});

describe("factCheckGatewayPaperclipSkills", () => {
  it("passes when every desired skill is in the assembled field", () => {
    expect(() =>
      factCheckGatewayPaperclipSkills({
        skills: [{ path: "alpha", name: "alpha", content: "x" }],
        desiredEntries: [{ key: "company/alpha", name: "alpha" }],
      }),
    ).not.toThrow();
  });

  it("matches by delivered name (slug--hash), not by the key's last segment", () => {
    expect(() =>
      factCheckGatewayPaperclipSkills({
        skills: [{ path: "alpha--ab12", name: "alpha--ab12", content: "x" }],
        desiredEntries: [{ key: "company/acme/alpha", name: "alpha--ab12" }],
      }),
    ).not.toThrow();
  });

  it("throws before POST /v1/runs when a desired skill is missing from the assembled field", () => {
    expect(() =>
      factCheckGatewayPaperclipSkills({
        skills: [{ path: "alpha", name: "alpha", content: "x" }],
        desiredEntries: [
          { key: "company/alpha", name: "alpha" },
          { key: "company/beta", name: "beta--ff00" },
        ],
      }),
    ).toThrow(
      "Cannot start without the required Paperclip-managed skills: beta--ff00: missing from the assembled run-body field",
    );
  });

  it("throws when the field is empty but skills are desired", () => {
    expect(() =>
      factCheckGatewayPaperclipSkills({
        skills: [],
        desiredEntries: [{ key: "company/alpha", name: "alpha" }],
      }),
    ).toThrow("Cannot start without the required Paperclip-managed skills: alpha");
  });
});

describe("buildPaperclipSkillsField", () => {
  it("returns undefined for a null reconcile (no key in config)", () => {
    expect(buildPaperclipSkillsField(null)).toBeUndefined();
  });

  it("returns [] for an empty delivery when the key was present, so the receiver clears the managed segment", () => {
    expect(buildPaperclipSkillsField({ skills: [], desiredSkills: [], desiredEntries: [] })).toEqual([]);
  });

  it("exposes the field name the run body must carry", () => {
    expect(PAPERCLIP_SKILLS_FIELD).toBe("paperclip_skills");
  });
});
