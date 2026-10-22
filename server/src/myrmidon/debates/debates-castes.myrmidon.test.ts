// myrmidon(1.7-DEBATE-ASYM-B): the per-caste debate configuration over a fake
// instance-settings bag, fake models and fake storage — no database, no
// gateway.
//
// What the ticket asks for, proven here: a caste's switch, role models,
// guidance, rounds and ceiling are read at run time (a save reaches the next
// debate without a restart), a switched-off caste refuses the run with the
// reason, a configuration that breaks the asymmetry rule is refused before
// anything is stored, a task's own caste (its assignee's role) is used when the
// caller names none, and the result document says which caste debated.

import { describe, expect, it } from "vitest";
import {
  DEBATE_AGREE_MARKER,
  DEBATE_CASTE_SETTINGS_ACTION,
  DEBATE_RESULT_DOCUMENT_KEY,
  defaultDebateSettings,
  type DebateSettingsResolution,
} from "@paperclipai/shared";
import { debateService, type DebateServiceDeps, type DebateActor } from "./service.js";
import { readCasteDebate, withPreservedCastes, writeCasteDebate, type CasteDebateStoreDeps } from "./castes.js";

const COMPANY = "10000000-0000-4000-8000-000000000001";
const OTHER_COMPANY = "10000000-0000-4000-8000-00000000000f";
const ISSUE = "20000000-0000-4000-8000-000000000002";
const AGENT = "30000000-0000-4000-8000-000000000003";

const actor: DebateActor = { agentId: AGENT, userId: null, runId: null };

interface Harness {
  deps: DebateServiceDeps;
  store: CasteDebateStoreDeps;
  general: { debate?: unknown };
  documents: { issueId: string; key: string; body: string }[];
  activities: Record<string, unknown>[];
  systems: { role: string; system: string }[];
  castes: string[];
  issueCasteKey: string | null;
  writes: number;
}

function harness(options: { issueCasteKey?: string | null; castes?: string[]; stored?: unknown } = {}): Harness {
  const h: Harness = {
    documents: [],
    activities: [],
    systems: [],
    writes: 0,
    castes: options.castes ?? ["marketing", "engineering"],
    issueCasteKey: options.issueCasteKey ?? null,
    general: { debate: options.stored },
    store: {
      getGeneral: async () => h.general,
      updateGeneral: async (patch) => {
        h.general = { ...h.general, ...patch };
        return h.general;
      },
    },
    deps: {} as DebateServiceDeps,
  };
  const settings = {
    readSettings: async (): Promise<DebateSettingsResolution> => ({ settings: defaultDebateSettings(), source: "default", problem: null }),
    writeSettings: async (): Promise<DebateSettingsResolution> => ({
      settings: defaultDebateSettings(),
      source: "settings",
      problem: null,
    }),
  };
  h.deps = {
    loadIssue: async (issueId) =>
      issueId === ISSUE
        ? {
            id: ISSUE,
            companyId: COMPANY,
            identifier: "OPE-1",
            title: "Which bbq channel to prioritize?",
            casteKey: h.issueCasteKey,
          }
        : null,
    readSettings: settings.readSettings,
    writeSettings: settings.writeSettings,
    readCasteSettings: (input) => readCasteDebate(h.store, input),
    writeCasteSettings: async (input) => {
      h.writes += 1;
      await writeCasteDebate(h.store, input);
    },
    casteExists: async ({ companyId, casteKey }) => companyId === COMPANY && h.castes.includes(casteKey),
    callModel: async () => async (roleConfig, system, _user, context) => {
      h.systems.push({ role: context.role, system });
      const text =
        context.role === "critic"
          ? `flaws listed. ${DEBATE_AGREE_MARKER}`
          : context.role === "judge"
            ? "VERDICT: prioritize local partnerships."
            : `answer from ${roleConfig.model}`;
      return { text, usage: { inputTokens: 800, outputTokens: 200 } };
    },
    writeDocument: async (input) => {
      h.documents.push({ issueId: input.issueId, key: input.key, body: input.body });
    },
    recordCost: async () => {},
    logActivity: async (input) => {
      h.activities.push(input as unknown as Record<string, unknown>);
    },
    now: () => new Date("2026-10-07T00:00:00Z"),
  };
  return h;
}

describe("myrmidon(1.7-DEBATE-ASYM-B): the caste entry store", () => {
  it("reads and writes one caste without touching the instance configuration or other castes", async () => {
    const instance = { ...defaultDebateSettings(), rounds: 2 };
    const h = harness({ stored: { ...instance, castes: { engineering: { companyId: COMPANY, enabled: false } } } });

    await writeCasteDebate(h.store, {
      companyId: COMPANY,
      casteKey: "marketing",
      patch: { enabled: false, tokenCeiling: 20000 },
    });

    const stored = h.general.debate as Record<string, unknown>;
    // The instance configuration survives verbatim...
    expect(stored.rounds).toBe(2);
    // ...the other caste survives...
    expect((stored.castes as Record<string, unknown>).engineering).toEqual({ companyId: COMPANY, enabled: false });
    // ...and the new entry is pinned to the company.
    expect((stored.castes as Record<string, unknown>).marketing).toEqual({
      companyId: COMPANY,
      enabled: false,
      tokenCeiling: 20000,
    });

    const read = await readCasteDebate(h.store, {
      companyId: COMPANY,
      casteKey: "marketing",
      instance: { settings: defaultDebateSettings(), source: "settings", problem: null },
    });
    expect(read.resolution.enabled).toBe(false);
    expect(read.resolution.settings?.tokenCeiling).toBe(20000);
    expect(read.stored?.enabled).toBe(false);

    // A clear goes back to inheriting.
    await writeCasteDebate(h.store, { companyId: COMPANY, casteKey: "marketing", patch: null });
    const cleared = await readCasteDebate(h.store, {
      companyId: COMPANY,
      casteKey: "marketing",
      instance: { settings: defaultDebateSettings(), source: "settings", problem: null },
    });
    expect(cleared.stored).toBeNull();
    expect(cleared.resolution.enabled).toBe(true);
    expect(cleared.resolution.enabledSource).toBe("default");
  });

  it("keeps an entry written for another company inert", async () => {
    const h = harness({ stored: { ...defaultDebateSettings(), castes: { marketing: { companyId: OTHER_COMPANY, enabled: false } } } });
    const read = await readCasteDebate(h.store, {
      companyId: COMPANY,
      casteKey: "marketing",
      instance: { settings: defaultDebateSettings(), source: "settings", problem: null },
    });
    expect(read.resolution.enabled).toBe(true);
    expect(read.resolution.enabledSource).toBe("default");
    expect(read.foreign).toContain("another company");
    expect(read.resolution.problem).toContain("another company");
  });

  it("refuses to overwrite a stored value that exists but is not a JSON object", async () => {
    await expect(
      writeCasteDebate(harness({ stored: 5 }).store, {
        companyId: COMPANY,
        casteKey: "marketing",
        patch: { enabled: false },
      }),
    ).rejects.toThrow(/not an object/);
    await expect(
      writeCasteDebate(harness({ stored: "{not json" }).store, {
        companyId: COMPANY,
        casteKey: "marketing",
        patch: { enabled: false },
      }),
    ).rejects.toThrow(/not valid JSON/);
  });
});

describe("myrmidon(1.7-DEBATE-ASYM-B): the two levels share one stored value", () => {
  it("keeps the caste map when the instance level is saved or cleared", () => {
    const instance = defaultDebateSettings();
    const stored = { ...instance, castes: { marketing: { companyId: COMPANY, enabled: false } } };
    // A save of the instance level carries the map over...
    expect(withPreservedCastes({ ...instance, rounds: 2 }, stored)).toMatchObject({
      rounds: 2,
      castes: { marketing: { companyId: COMPANY, enabled: false } },
    });
    // ...and a clear leaves the map in place instead of deleting a caste.
    expect(withPreservedCastes(null, stored)).toEqual({ castes: { marketing: { companyId: COMPANY, enabled: false } } });
    // With no map left the clear really clears the value.
    expect(withPreservedCastes(null, instance)).toBeNull();
    expect(withPreservedCastes(instance, undefined)).toEqual(instance);
  });

  it("does not leave a pointless `{ castes: {} }` row behind", async () => {
    // Saving a caste while the instance configuration comes from env/default,
    // then clearing it again, must not leave a row that reads as empty config.
    const h = harness();
    await writeCasteDebate(h.store, { companyId: COMPANY, casteKey: "marketing", patch: { enabled: false } });
    expect(h.general.debate).toEqual({ castes: { marketing: { companyId: COMPANY, enabled: false } } });
    await writeCasteDebate(h.store, { companyId: COMPANY, casteKey: "marketing", patch: null });
    expect(h.general.debate).toBeNull();
  });

  it("refuses to carry per-caste entries through the instance-level PATCH", async () => {
    // The instance-level PATCH validator rejects a body with the bag: those are
    // saved per caste, and normalizing them into the default config would
    // silently drop the map.
    const service = debateService(harness().deps);
    await expect(
      service.saveSettings({ castes: { marketing: { companyId: COMPANY, enabled: false } } }),
    ).rejects.toMatchObject({ code: "debate_config_invalid" });
  });
});

describe("myrmidon(1.7-DEBATE-ASYM-B): the caste settings service", () => {
  it("reports the inherited configuration and where it comes from", async () => {
    const h = harness();
    const view = await debateService(h.deps).casteSettingsView({ companyId: COMPANY, casteKey: "marketing" });
    expect(view.enabled).toBe(true);
    expect(view.enabledSource).toBe("default");
    expect(view.source).toBe("default");
    expect(view.instanceSource).toBe("default");
    expect(view.overrides).toEqual([]);
    expect(view.summary).toContain("caste marketing");
  });

  it("refuses an unknown caste with the not-found code", async () => {
    const service = debateService(harness().deps);
    await expect(service.casteSettingsView({ companyId: COMPANY, casteKey: "nope" })).rejects.toMatchObject({
      code: "debate_caste_not_found",
    });
  });

  it("saves a caste entry and reports it — no restart, the next view already has it", async () => {
    const h = harness();
    const service = debateService(h.deps);
    const saved = await service.saveCasteSettings(
      {
        companyId: COMPANY,
        casteKey: "marketing",
        raw: {
          enabled: false,
          critic: { model: "glm-4-flash-free" },
          rounds: 2,
          tokenCeiling: 20000,
          prompts: { critic: "look for campaign-claim risks" },
        },
      },
      actor,
    );
    expect(saved.enabled).toBe(false);
    expect(saved.enabledSource).toBe("caste");
    expect(saved.source).toBe("caste");
    expect(saved.overrides).toEqual(["enabled", "critic", "rounds", "tokenCeiling", "prompts"]);
    expect(saved.prompts).toEqual({ critic: "look for campaign-claim risks" });
    expect(saved.stored).toMatchObject({ enabled: false, rounds: 2 });

    // Read back from the same fake bag: the change is live.
    const again = await service.casteSettingsView({ companyId: COMPANY, casteKey: "marketing" });
    expect(again.enabled).toBe(false);
    expect(again.settings?.rounds).toBe(2);

    // The write was audited once, with the knob names and no values of prompts.
    const audit = h.activities.find((entry) => entry.action === DEBATE_CASTE_SETTINGS_ACTION);
    expect(audit).toBeTruthy();
    expect((audit?.details as Record<string, unknown>).overrides).toEqual([
      "enabled",
      "critic",
      "rounds",
      "tokenCeiling",
      "prompts",
    ]);
  });

  it("refuses a malformed entry and a merged configuration that breaks the rule, storing nothing", async () => {
    const h = harness();
    const service = debateService(h.deps);
    await expect(
      service.saveCasteSettings({ companyId: COMPANY, casteKey: "marketing", raw: { rounds: 9 } }),
    ).rejects.toMatchObject({ code: "debate_config_invalid" });

    await expect(
      service.saveCasteSettings({
        companyId: COMPANY,
        casteKey: "marketing",
        raw: { critic: { model: defaultDebateSettings().generator.model } },
      }),
    ).rejects.toMatchObject({ code: "debate_config_rejected" });

    expect(h.writes).toBe(0);
    expect(h.general.debate).toBeUndefined();
  });

  it("clears a caste back to the instance configuration", async () => {
    const h = harness({ stored: { ...defaultDebateSettings(), castes: { marketing: { companyId: COMPANY, enabled: false } } } });
    const service = debateService(h.deps);
    const view = await service.saveCasteSettings({ companyId: COMPANY, casteKey: "marketing", raw: null }, actor);
    expect(view.enabled).toBe(true);
    expect(view.enabledSource).toBe("default");
    expect(view.stored).toBeNull();
  });
});

describe("myrmidon(1.7-DEBATE-ASYM-B): running from a caste's task", () => {
  it("runs with the named caste's configuration and guidance, and the document names the caste", async () => {
    const h = harness({
      stored: {
        ...defaultDebateSettings(),
        castes: {
          marketing: {
            companyId: COMPANY,
            critic: { model: "glm-4-flash-free" },
            rounds: 1,
            tokenCeiling: 12000,
            prompts: { critic: "check the legal claims" },
          },
        },
      },
    });
    const result = await debateService(h.deps).run({ companyId: COMPANY, issueId: ISSUE, casteKey: "marketing" }, actor);

    expect(result.outcome.casteKey).toBe("marketing");
    expect(result.outcome.customPrompts).toEqual(["critic"]);
    expect(result.outcome.roundsPlanned).toBe(1);
    expect(result.outcome.tokenCeiling).toBe(12000);
    const criticSystems = h.systems.filter((entry) => entry.role === "critic");
    expect(criticSystems.length).toBeGreaterThan(0);
    expect(criticSystems.every((entry) => entry.system.includes("check the legal claims"))).toBe(true);
    expect(h.documents[0].key).toBe(DEBATE_RESULT_DOCUMENT_KEY);
    expect(h.documents[0].body).toContain("Caste: **marketing**");
    const completion = h.activities.find((entry) => entry.details && (entry.details as Record<string, unknown>).casteKey === "marketing");
    expect(completion).toBeTruthy();
  });

  it("uses the task's own caste when the caller names none", async () => {
    const h = harness({ issueCasteKey: "marketing", stored: { ...defaultDebateSettings(), castes: { marketing: { companyId: COMPANY, rounds: 2 } } } });
    const result = await debateService(h.deps).run({ companyId: COMPANY, issueId: ISSUE }, actor);
    expect(result.outcome.casteKey).toBe("marketing");
    expect(result.outcome.roundsPlanned).toBe(2);
  });

  it("refuses a switched-off caste with the reason, before any model call", async () => {
    const h = harness({ stored: { ...defaultDebateSettings(), castes: { marketing: { companyId: COMPANY, enabled: false } } } });
    await expect(
      debateService(h.deps).run({ companyId: COMPANY, issueId: ISSUE, casteKey: "marketing" }, actor),
    ).rejects.toMatchObject({ code: "debate_caste_disabled" });
    expect(h.systems).toHaveLength(0);
    expect(h.documents).toHaveLength(0);
  });

  it("refuses a caste that is not in the company's directory", async () => {
    const h = harness();
    await expect(
      debateService(h.deps).run({ companyId: COMPANY, issueId: ISSUE, casteKey: "finance" }, actor),
    ).rejects.toMatchObject({ code: "debate_caste_not_found" });
  });

  it("keeps part A's instance-level path for a task that is not routed to a caste", async () => {
    const h = harness();
    const result = await debateService(h.deps).run({ companyId: COMPANY, issueId: ISSUE }, actor);
    expect(result.outcome.casteKey).toBeNull();
    expect(result.outcome.customPrompts).toEqual([]);
    expect(h.documents[0].body).not.toContain("Caste:");
    expect(h.writes).toBe(0);
  });

  it("a switch change applies to the next run without a restart", async () => {
    const h = harness({ issueCasteKey: "marketing" });
    const service = debateService(h.deps);
    await service.run({ companyId: COMPANY, issueId: ISSUE }, actor);
    await service.saveCasteSettings({ companyId: COMPANY, casteKey: "marketing", raw: { enabled: false } }, actor);
    await expect(service.run({ companyId: COMPANY, issueId: ISSUE }, actor)).rejects.toMatchObject({
      code: "debate_caste_disabled",
    });
  });
});