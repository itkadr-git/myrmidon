// myrmidon(1.7-GRD-MODES): unit tests of the shared mode contract — the
// inheritance chain (agent > caste > company > default flag), the safe
// defaults, the strict document shape, and the env force semantics.
import { describe, expect, it } from "vitest";
import {
  EMPTY_GUARDRAIL_MODES_SETTINGS,
  GUARDRAIL_DEFAULT_MODE,
  GUARDRAILS_MODE_FORCE_ENV,
  GUARDRAIL_MASK_PLACEHOLDER,
  GUARDRAIL_MODES,
  GUARDRAIL_RULES,
  guardrailForcedModeFromEnv,
  guardrailModesSettingsSchema,
  normalizeGuardrailModesSettings,
  resolveGuardrailMode,
} from "./myrmidon-guardrail-modes.js";

const AGENT = "11111111-1111-4111-8111-111111111111";

describe("myrmidon(1.7-GRD-MODES): guardrail mode contract", () => {
  it("every rule is flag-only with no settings at all (acceptance: default)", () => {
    for (const rule of GUARDRAIL_RULES) {
      const resolved = resolveGuardrailMode({
        settings: EMPTY_GUARDRAIL_MODES_SETTINGS,
        rule,
        agentId: AGENT,
        agentRole: "engineer",
      });
      expect(resolved.mode).toBe(GUARDRAIL_DEFAULT_MODE);
      expect(resolved.mode).toBe("flag");
      expect(resolved.source).toBe("default");
      expect(resolved.caste).toBeNull();
    }
  });

  it("company override applies to every agent of the company", () => {
    const settings = normalizeGuardrailModesSettings({ company: { secret: "mask" } });
    const resolved = resolveGuardrailMode({
      settings,
      rule: "secret",
      agentId: AGENT,
      agentRole: "engineer",
    });
    expect(resolved).toMatchObject({ mode: "mask", source: "company" });
    // Other rules stay flag-only.
    expect(
      resolveGuardrailMode({ settings, rule: "pii", agentId: AGENT, agentRole: "engineer" }).mode,
    ).toBe("flag");
  });

  it("caste override beats company, agent beats caste (agent > caste > company)", () => {
    const settings = normalizeGuardrailModesSettings({
      company: { injection: "flag" },
      castes: { engineer: { injection: "mask" } },
      agents: { [AGENT]: { injection: "block" } },
    });
    const engineer = resolveGuardrailMode({
      settings,
      rule: "injection",
      agentId: AGENT,
      agentRole: "engineer",
    });
    expect(engineer).toMatchObject({ mode: "block", source: "agent" });

    const otherAgent = "22222222-2222-4222-8222-222222222222";
    const sameCaste = resolveGuardrailMode({
      settings,
      rule: "injection",
      agentId: otherAgent,
      agentRole: "engineer",
    });
    expect(sameCaste).toMatchObject({ mode: "mask", source: "caste", caste: "engineer" });

    const otherCaste = resolveGuardrailMode({
      settings,
      rule: "injection",
      agentId: otherAgent,
      agentRole: "qa",
    });
    expect(otherCaste).toMatchObject({ mode: "flag", source: "company" });
  });

  it("an agent without a role never matches a caste rule by accident", () => {
    const settings = normalizeGuardrailModesSettings({
      castes: { engineer: { pii: "block" } },
    });
    const resolved = resolveGuardrailMode({
      settings,
      rule: "pii",
      agentId: AGENT,
      agentRole: null,
    });
    expect(resolved).toMatchObject({ mode: "flag", source: "default" });
  });

  it("a caste rule for another role does not leak to this agent", () => {
    const settings = normalizeGuardrailModesSettings({
      castes: { security: { secret: "block" } },
    });
    const resolved = resolveGuardrailMode({
      settings,
      rule: "secret",
      agentId: AGENT,
      agentRole: "engineer",
    });
    expect(resolved).toMatchObject({ mode: "flag", source: "default" });
  });

  it("env force beats every stored level and reports source env", () => {
    const settings = normalizeGuardrailModesSettings({
      company: { secret: "mask" },
      castes: { engineer: { secret: "flag" } },
      agents: { [AGENT]: { secret: "flag" } },
    });
    const resolved = resolveGuardrailMode({
      settings,
      rule: "secret",
      agentId: AGENT,
      agentRole: "engineer",
      forced: "block",
    });
    expect(resolved).toMatchObject({ mode: "block", source: "env" });
  });

  it("env force parsing: only a valid mode string forces; unset/typo means off", () => {
    expect(guardrailForcedModeFromEnv({ [GUARDRAILS_MODE_FORCE_ENV]: "block" })).toBe("block");
    expect(guardrailForcedModeFromEnv({ [GUARDRAILS_MODE_FORCE_ENV]: "FLAG" })).toBe("flag");
    expect(guardrailForcedModeFromEnv({ [GUARDRAILS_MODE_FORCE_ENV]: " flag " })).toBe("flag");
    expect(guardrailForcedModeFromEnv({})).toBeNull();
    expect(guardrailForcedModeFromEnv({ [GUARDRAILS_MODE_FORCE_ENV]: "" })).toBeNull();
    expect(guardrailForcedModeFromEnv({ [GUARDRAILS_MODE_FORCE_ENV]: "ban" })).toBeNull();
    expect(guardrailForcedModeFromEnv({ [GUARDRAILS_MODE_FORCE_ENV]: "1" })).toBeNull();
  });

  it("normalize: garbage storage resolves to all-flag, never half-applies", () => {
    expect(normalizeGuardrailModesSettings(undefined)).toEqual(EMPTY_GUARDRAIL_MODES_SETTINGS);
    expect(normalizeGuardrailModesSettings(null)).toEqual(EMPTY_GUARDRAIL_MODES_SETTINGS);
    expect(normalizeGuardrailModesSettings("junk")).toEqual(EMPTY_GUARDRAIL_MODES_SETTINGS);
    expect(normalizeGuardrailModesSettings({ company: { secret: "nonsense" } })).toEqual(
      EMPTY_GUARDRAIL_MODES_SETTINGS,
    );
    expect(normalizeGuardrailModesSettings({ agents: { notauuid: { secret: "block" } } })).toEqual(
      EMPTY_GUARDRAIL_MODES_SETTINGS,
    );
  });

  it("normalize: a valid document round-trips with copies, not shared references", () => {
    const raw = {
      company: { pii: "mask" },
      castes: { engineer: { injection: "block" } },
      agents: { [AGENT]: { secret: "flag" } },
    };
    const first = normalizeGuardrailModesSettings(raw);
    const second = normalizeGuardrailModesSettings(raw);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.castes).not.toBe(second.castes);
  });

  it("the schema is strict: unknown keys and modes are rejected", () => {
    expect(guardrailModesSettingsSchema.safeParse({ company: { secret: "nuclear" } }).success).toBe(false);
    expect(guardrailModesSettingsSchema.safeParse({ unknownLevel: {} }).success).toBe(false);
    expect(
      guardrailModesSettingsSchema.safeParse({ company: { unknownRule: "block" } }).success,
    ).toBe(false);
  });

  it("mask placeholder is a single neutral token (no value ever embedded)", () => {
    expect(GUARDRAIL_MASK_PLACEHOLDER).toBe("[masked]");
    expect(GUARDRAIL_MODES).toEqual(["flag", "mask", "block"]);
    expect(GUARDRAIL_RULES).toEqual(["secret", "pii", "injection"]);
  });
});
