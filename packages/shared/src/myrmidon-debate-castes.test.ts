// myrmidon(1.7-DEBATE-ASYM-B): the per-caste debate configuration contract.
//
// What the ticket asks for, tested here: a caste's switch, role models,
// custom guidance, rounds and token ceiling resolve over the instance
// configuration with every source reported; a caste entry written for another
// company is inert; a merged configuration that breaks the asymmetry rule is
// refused with the exact reason; the custom guidance is appended to the built-in
// pole prompt (the critic keeps its missed-error penalty); and the result
// document names the caste it ran for.

import { describe, expect, it } from "vitest";
import {
  composeRoleSystemPrompt,
  criticSystemPrompt,
  defaultDebateSettings,
  generatorSystemPrompt,
  readStoredCastes,
  renderDebateResultDocument,
  resolveDebateSettings,
  resolveDebateSettingsValue,
  runDebate,
  type DebateModelCall,
  type DebateSettings,
} from "./myrmidon-debate.js";
import {
  casteDebateGate,
  casteDebateOverrideKeys,
  casteDebatePrompts,
  customPromptRoles,
  parseCasteDebateKey,
  parseCasteDebateOverride,
  pickCasteDebateOverride,
  renderCasteDebateSummary,
  resolveCasteDebateSettings,
  type CasteDebateOverride,
  type CasteDebateResolution,
} from "./myrmidon-debate-castes.js";

const COMPANY = "2870b911-483a-4091-9f15-183841811143";

function instanceSettings(overrides?: Partial<DebateSettings>) {
  return resolveDebateSettingsValue({ ...defaultDebateSettings(), ...overrides }, "settings");
}

function entry(overrides?: Partial<CasteDebateOverride>): CasteDebateOverride {
  return { companyId: COMPANY, ...overrides } as CasteDebateOverride;
}

describe("myrmidon(1.7-DEBATE-ASYM-B): the stored entry", () => {
  it("accepts the knobs a caste may set and refuses anything else", () => {
    const ok = parseCasteDebateOverride({
      companyId: COMPANY,
      enabled: false,
      generator: { model: "qwen-plus-free" },
      rounds: 2,
      tokenCeiling: 20000,
      prompts: { critic: "look for campaign-claim risks" },
    });
    expect(ok.ok).toBe(true);

    const unknownKey = parseCasteDebateOverride({ companyId: COMPANY, families: "any" });
    expect(unknownKey.ok).toBe(false);
    const noCompany = parseCasteDebateOverride({ enabled: true });
    expect(noCompany.ok).toBe(false);
    const tooManyRounds = parseCasteDebateOverride({ companyId: COMPANY, rounds: 4 });
    expect(tooManyRounds.ok).toBe(false);
    const symmetric = parseCasteDebateOverride({
      companyId: COMPANY,
      judge: { model: "qwen-plus-free" },
    });
    // The entry itself parses: the asymmetry rule is checked on the MERGED
    // configuration, which is where the instance judge can collide with it.
    expect(symmetric.ok).toBe(true);
  });

  it("validates the caste key", () => {
    expect(parseCasteDebateKey("marketing")).toEqual({ ok: true, key: "marketing" });
    expect(parseCasteDebateKey("  marketing  ")).toEqual({ ok: true, key: "marketing" });
    expect(parseCasteDebateKey("   ").ok).toBe(false);
    expect(parseCasteDebateKey("x".repeat(65)).ok).toBe(false);
  });

  it("reads the map out of a stored value and ignores a foreign entry", () => {
    const stored = { ...defaultDebateSettings(), castes: { marketing: entry({ enabled: false }) } };
    expect(readStoredCastes(stored).map).toHaveProperty("marketing");

    const mine = pickCasteDebateOverride(readStoredCastes(stored).map, {
      companyId: COMPANY,
      casteKey: "marketing",
    });
    expect(mine.override?.enabled).toBe(false);

    const other = pickCasteDebateOverride(readStoredCastes(stored).map, {
      companyId: "11111111-1111-1111-1111-111111111111",
      casteKey: "marketing",
    });
    expect(other.override).toBeNull();
    expect(other.foreign).toContain("another company");

    const unknown = pickCasteDebateOverride(readStoredCastes(stored).map, {
      companyId: COMPANY,
      casteKey: "engineering",
    });
    expect(unknown.override).toBeNull();
    expect(unknown.problem).toBeNull();
  });

  it("keeps a stored value with the castes bag parseable at the instance level", () => {
    const stored = { ...defaultDebateSettings(), castes: { marketing: entry() } };
    const resolved = resolveDebateSettingsValue(stored, "settings");
    expect(resolved.problem).toBeNull();
    expect(resolved.settings).not.toHaveProperty("castes");
    // A malformed value still fails instead of silently passing through.
    expect(resolveDebateSettingsValue({ ...defaultDebateSettings(), nonsense: 1 }, "settings").problem).toContain(
      "malformed",
    );
  });

  it("treats a value that carries only the castes map as nothing chosen at the instance level", () => {
    // A caste entry can be saved while the instance configuration is the
    // env/default one: such a value must not read as malformed, or saving a
    // caste would take the whole instance's debates down.
    const onlyCastes = { castes: { marketing: entry({ enabled: false }) } };
    const resolved = resolveDebateSettingsValue(onlyCastes, "settings");
    expect(resolved.problem).toBeNull();
    expect(resolved.settings).toBeNull();
    expect(resolveDebateSettings({ stored: onlyCastes, env: {} }).source).toBe("default");
    expect(readStoredCastes(onlyCastes).map).toHaveProperty("marketing");
  });

  it("refuses a half-filled instance configuration", () => {
    const partial = { generator: { model: "qwen-plus-free" } };
    expect(resolveDebateSettingsValue(partial, "settings").problem).toContain("all three roles");
  });
});

describe("myrmidon(1.7-DEBATE-ASYM-B): resolution over the instance configuration", () => {
  it("inherits everything when a caste has no entry, and stays on", () => {
    const resolution = resolveCasteDebateSettings({
      casteKey: "marketing",
      override: null,
      instance: instanceSettings(),
    });
    expect(resolution.enabled).toBe(true);
    expect(resolution.enabledSource).toBe("default");
    expect(resolution.source).toBe("settings");
    expect(resolution.instanceSource).toBe("settings");
    expect(resolution.overrides).toEqual([]);
    expect(resolution.settings).toEqual(defaultDebateSettings());
    expect(resolution.problem).toBeNull();
  });

  it("lays the caste entry over the instance configuration field by field", () => {
    const resolution = resolveCasteDebateSettings({
      casteKey: "marketing",
      override: entry({
        enabled: true,
        critic: { model: "glm-4-flash-free" },
        rounds: 2,
        tokenCeiling: 20000,
        prompts: { critic: "look for campaign-claim risks" },
      }),
      instance: instanceSettings(),
    });
    expect(resolution.enabled).toBe(true);
    expect(resolution.enabledSource).toBe("caste");
    expect(resolution.source).toBe("caste");
    expect(resolution.overrides).toEqual(["enabled", "critic", "rounds", "tokenCeiling", "prompts"]);
    expect(resolution.settings?.critic.model).toBe("glm-4-flash-free");
    // Untouched knobs still come from the instance level.
    expect(resolution.settings?.generator.model).toBe(defaultDebateSettings().generator.model);
    expect(resolution.prompts).toEqual({ critic: "look for campaign-claim risks" });
    expect(resolution.problem).toBeNull();
  });

  it("keeps a caste's rounds and ceiling inside the owner's limits", () => {
    const instance = instanceSettings({ rounds: 3, tokenCeiling: 50000 });
    const resolution = resolveCasteDebateSettings({
      casteKey: "marketing",
      override: entry({ rounds: 1, tokenCeiling: 12000 }),
      instance,
    });
    expect(resolution.settings?.rounds).toBe(1);
    expect(resolution.settings?.tokenCeiling).toBe(12000);
  });

  it("refuses a merged configuration that collides inside one family", () => {
    // The caste overrides only the judge — onto the generator's family.
    const resolution = resolveCasteDebateSettings({
      casteKey: "marketing",
      override: entry({ judge: { model: defaultDebateSettings().generator.model } }),
      instance: instanceSettings(),
    });
    expect(resolution.settings).toBeNull();
    expect(resolution.problem).toContain("outside the dispute");

    // ...and only the critic — onto the generator's family.
    const debaters = resolveCasteDebateSettings({
      casteKey: "marketing",
      override: entry({ critic: { model: defaultDebateSettings().generator.model } }),
      instance: instanceSettings(),
    });
    expect(debaters.settings).toBeNull();
    expect(debaters.problem).toContain("must be asymmetric");
  });

  it("reports a malformed entry and a missing instance configuration", () => {
    const malformed = resolveCasteDebateSettings({
      casteKey: "marketing",
      override: null,
      instance: instanceSettings(),
      entryProblem: "the stored debate entry is malformed: rounds too big",
    });
    expect(malformed.problem).toContain("rounds too big");
    expect(malformed.settings).toBeNull();

    const noInstance = resolveCasteDebateSettings({
      casteKey: "marketing",
      override: entry({ enabled: true }),
      instance: { settings: null, source: "settings", problem: "generator and critic share the family" },
    });
    expect(noInstance.settings).toBeNull();
    expect(noInstance.problem).toContain("share the family");
    // The switch itself is still reported, so the screen can show it.
    expect(noInstance.enabled).toBe(true);
    expect(noInstance.enabledSource).toBe("caste");
  });

  it("carries the instance level's own source into the view", () => {
    const fromEnv = resolveDebateSettingsValue({ ...defaultDebateSettings(), rounds: 2 }, "env");
    const resolution = resolveCasteDebateSettings({
      casteKey: "marketing",
      override: null,
      instance: fromEnv,
    });
    expect(resolution.source).toBe("env");
    expect(resolution.instanceSource).toBe("env");
    expect(renderCasteDebateSummary(resolution)).toContain("config from env");
  });
});

describe("myrmidon(1.7-DEBATE-ASYM-B): the run gate", () => {
  function resolution(overrides: Partial<CasteDebateResolution>): CasteDebateResolution {
    return {
      casteKey: "marketing",
      enabled: true,
      enabledSource: "default",
      settings: defaultDebateSettings(),
      source: "settings",
      instanceSource: "settings",
      overrides: [],
      prompts: {},
      problem: null,
      ...overrides,
    };
  }

  it("passes when the caste is on and the configuration resolves", () => {
    expect(casteDebateGate(resolution({})).ok).toBe(true);
  });

  it("refuses a switched-off caste with the switch as the reason", () => {
    const gate = casteDebateGate(resolution({ enabled: false, enabledSource: "caste", source: "caste" }));
    expect(gate).toMatchObject({ ok: false, code: "debate_caste_disabled" });
    expect(gate.ok === false && gate.reason).toContain("marketing");
  });

  it("refuses a caste whose configuration cannot run", () => {
    const gate = casteDebateGate(
      resolution({ settings: null, source: null, problem: "the judge shares a family with a debater" }),
    );
    expect(gate).toMatchObject({ ok: false, code: "debate_config_rejected" });
    expect(gate.ok === false && gate.reason).toContain("shares a family");
  });
});

describe("myrmidon(1.7-DEBATE-ASYM-B): custom guidance and the poles", () => {
  it("appends the caste's guidance and never replaces the pole", () => {
    const composed = composeRoleSystemPrompt("critic", "watch the numbers in the campaign claim");
    expect(composed.startsWith(criticSystemPrompt())).toBe(true);
    expect(composed).toContain("penalized for a missed error");
    expect(composed).toContain("watch the numbers in the campaign claim");
    // With no guidance the pole is returned verbatim.
    expect(composeRoleSystemPrompt("generator", null)).toBe(generatorSystemPrompt());
    expect(composeRoleSystemPrompt("generator", "   ")).toBe(generatorSystemPrompt());
  });

  it("lists the roles that got custom guidance", () => {
    expect(customPromptRoles({ critic: "x", judge: "" })).toEqual(["critic"]);
    expect(casteDebateOverrideKeys(entry({ prompts: { judge: "y" } }))).toEqual(["prompts"]);
    expect(casteDebatePrompts(entry({ prompts: { judge: "  y  " } }))).toEqual({ judge: "y" });
  });

  it("hands the guidance to the engine for the right role only", async () => {
    const seen: Array<{ role: string; system: string }> = [];
    const call: DebateModelCall = async (_config, system, _user, context) => {
      seen.push({ role: context.role, system });
      return { text: context.role === "critic" ? "[AGREE]" : "an answer", usage: { inputTokens: 10, outputTokens: 10 } };
    };
    const outcome = await runDebate({
      question: "Should the campaign ship?",
      settings: defaultDebateSettings(),
      call,
      prompts: { critic: "check the legal claims" },
    });
    const criticCalls = seen.filter((entrySeen) => entrySeen.role === "critic");
    expect(criticCalls.length).toBeGreaterThan(0);
    expect(criticCalls.every((entrySeen) => entrySeen.system.includes("check the legal claims"))).toBe(true);
    expect(seen.filter((e) => e.role === "generator").every((e) => !e.system.includes("check the legal claims"))).toBe(
      true,
    );
    expect(outcome.stopReason).toBe("agreement");
  });

  it("names the caste and the custom roles in the result document", () => {
    const body = renderDebateResultDocument({
      question: "Q",
      completed: true,
      stopReason: "agreement",
      stopDetail: "the critic agreed",
      roundsPlanned: 3,
      roundsRun: 1,
      tokenCeiling: 50000,
      tokensUsed: 100,
      cost: { totalCents: 0, ceilingCrossedCents: 0, inputTokens: 50, outputTokens: 50, byRole: { generator: 0, critic: 0, judge: 0 }, byModel: {} },
      transcript: [],
      judgeVerdict: "VERDICT: ship it",
      familyProblem: null,
      roles: {
        generator: { model: "qwen-plus-free", family: "qwen" },
        critic: { model: "glm-4-flash-free", family: "zhipu" },
        judge: { model: "deepseek-chat-free", family: "deepseek" },
      },
      casteKey: "marketing",
      customPrompts: ["critic"],
    });
    expect(body).toContain("Caste: **marketing**");
    expect(body).toContain("custom guidance: critic");
    // A part-A run (no caste) says nothing about one.
    const plain = renderDebateResultDocument({
      question: "Q",
      completed: true,
      stopReason: "agreement",
      stopDetail: "x",
      roundsPlanned: 1,
      roundsRun: 1,
      tokenCeiling: 1000,
      tokensUsed: 1,
      cost: { totalCents: 0, ceilingCrossedCents: 0, inputTokens: 1, outputTokens: 0, byRole: { generator: 0, critic: 0, judge: 0 }, byModel: {} },
      transcript: [],
      judgeVerdict: null,
      familyProblem: null,
      roles: {
        generator: { model: "a", family: "x" },
        critic: { model: "b", family: "y" },
        judge: { model: "c", family: "z" },
      },
    });
    expect(plain).not.toContain("Caste:");
  });
});