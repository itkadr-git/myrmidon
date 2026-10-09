// server/src/myrmidon/distill/distill-domain.test.ts
//
// myrmidon(1.6.6 KNOWLEDGE-2.0 K-5): the domain rules of the distiller v2 —
// pure, no database, no HTTP. Covers every K-5 acceptance criterion that can
// be decided without a board: silent noise, ≥1 source per proposal, the ≤10
// human package, the budget signal, and the I-7 life boundary.

import { describe, expect, it } from "vitest";
import {
  citesLifeSource,
  DEFAULT_DISTILL_BUDGET,
  filterProposals,
  isAutoAcceptSection,
  MAX_HUMAN_PACKAGE,
  noiseShare,
  validateEvidence,
  withinBudget,
  type DistillProposal,
} from "./domain.js";
import { mergeDistillSettings, resolveDistillSettings, DISTILL_SETTINGS_KEY } from "./settings.js";
import { parseDistillAnswer } from "./model.js";
import { passWindow, taskIsLife } from "./raw.js";

function proposal(over: Partial<DistillProposal> = {}): DistillProposal {
  return {
    class: "decision",
    body: "the colony ships from CI images only",
    rationale: "three closed tasks repeated it",
    target: { section: "general", slug: null },
    sources: [{ kind: "task", ref: "AAA-100" }],
    evidenceTaskRefs: ["AAA-100", "AAA-101"],
    ...over,
  };
}

describe("distill domain (K-5)", () => {
  it("drops noise silently and keeps sourced proposals", () => {
    const report = filterProposals([
      proposal({ class: "noise" }),
      proposal({ class: "noise" }),
      proposal({ class: "noise" }),
      proposal({ class: "decision" }),
      proposal({ class: "glossary_term" }),
    ]);
    expect(report.droppedNoise).toBe(3);
    expect(report.kept).toHaveLength(2);
    expect(report.kept.every((p) => p.class !== "noise")).toBe(true);
  });

  it("drops a proposal without at least one source", () => {
    const report = filterProposals([proposal({ sources: [], evidenceTaskRefs: [] })]);
    expect(report.droppedUnsourced).toBe(1);
    expect(report.kept).toHaveLength(0);
  });

  it("caps the human package at 10", () => {
    const many = Array.from({ length: 14 }, (_, i) => proposal({ body: `claim ${i}` }));
    const report = filterProposals(many);
    expect(report.kept.length).toBe(MAX_HUMAN_PACKAGE);
  });

  it("excludes life-direction sources from common proposals (I-7)", () => {
    const life = proposal({ sources: [{ kind: "task", ref: "fleet-life/AAA-9" }], evidenceTaskRefs: ["AAA-9"] });
    expect(citesLifeSource(life)).toBe(true);
    const report = filterProposals([life, proposal()]);
    expect(report.droppedLife).toBe(1);
    expect(report.kept).toHaveLength(1);
  });

  it("treats over-budget as a signal, not a crash", () => {
    const over = withinBudget({ inputTokens: DEFAULT_DISTILL_BUDGET.maxInputTokens + 1, outputTokens: 0, durationMs: 1 }, DEFAULT_DISTILL_BUDGET);
    expect(over.ok).toBe(false);
    expect(over.signals).toContain("token_budget_exceeded");
    const slow = withinBudget({ inputTokens: 1, outputTokens: 0, durationMs: DEFAULT_DISTILL_BUDGET.maxDurationMs + 1 }, DEFAULT_DISTILL_BUDGET);
    expect(slow.signals).toContain("time_budget_exceeded");
  });

  it("reports the noise share", () => {
    expect(noiseShare(10, 7)).toBeCloseTo(0.7);
    expect(noiseShare(0, 0)).toBe(0);
  });

  it("requires 1..10 evidence tasks", () => {
    expect(validateEvidence(proposal({ evidenceTaskRefs: [] }))).not.toBeNull();
    expect(validateEvidence(proposal({ evidenceTaskRefs: Array.from({ length: 11 }, (_, i) => `A-${i}`) }))).not.toBeNull();
    expect(validateEvidence(proposal())).toBeNull();
  });

  it("only glossary/releases/how-made auto-accept", () => {
    expect(isAutoAcceptSection("glossary")).toBe(true);
    expect(isAutoAcceptSection("releases")).toBe(true);
    expect(isAutoAcceptSection("how-made")).toBe(true);
    expect(isAutoAcceptSection("general")).toBe(false);
    expect(isAutoAcceptSection("architecture")).toBe(false);
  });
});

describe("distill settings (K-5)", () => {
  it("built-in default is disabled with 1M tokens / 30 min", () => {
    const resolved = resolveDistillSettings(null, {});
    expect(resolved.settings.enabled).toBe(false);
    expect(resolved.settings.maxInputTokens).toBe(1_000_000);
    expect(resolved.settings.maxDurationSec).toBe(1800);
  });

  it("env wins over the stored row per key", () => {
    const stored = { enabled: false, intervalSec: 3600 };
    const merged = mergeDistillSettings(stored, { MYRMIDON_DISTILL_ENABLED: "1", MYRMIDON_DISTILL_INTERVAL_SEC: "60" });
    expect(merged.enabled).toBe(true);
    expect(merged.intervalSec).toBe(60);
  });

  it("auto-accept sections parse from a comma list", () => {
    const merged = mergeDistillSettings(null, { MYRMIDON_DISTILL_AUTO_ACCEPT: "glossary,releases" });
    expect(merged.autoAcceptSections).toEqual(["glossary", "releases"]);
  });

  it("resolve carries the env-only gateway/secret names", () => {
    const resolved = resolveDistillSettings({ [DISTILL_SETTINGS_KEY]: { enabled: true } }, {
      MYRMIDON_DISTILL_GATEWAY_URL: "https://gw.example/v1",
      MYRMIDON_DISTILL_KEY_SECRET: "free-model-key",
    });
    expect(resolved.gatewayUrl).toBe("https://gw.example/v1");
    expect(resolved.keySecret).toBe("free-model-key");
    expect(resolved.settings.enabled).toBe(true);
  });
});

describe("distill model parsing (K-5)", () => {
  it("parses the JSON array and drops malformed entries silently", () => {
    const text = [
      "prefix chatter",
      JSON.stringify([
        { class: "decision", body: "ship from CI", rationale: "twice", section: "releases", slug: null, evidence: ["A-1", "A-2"] },
        { class: "noise", body: "daily status", rationale: null, section: "general", slug: null, evidence: [] },
        { class: "glossary_term", body: "", evidence: ["A-3"] },
        { body: "no class", evidence: ["A-4"] },
        { class: "runbook_step", body: "run pnpm", section: "how-made", evidence: "not-an-array" },
      ]),
    ].join("\n");
    const parsed = parseDistillAnswer(text);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.evidence).toEqual(["A-1", "A-2"]);
    expect(parsed[1]!.class).toBe("noise");
  });

  it("empty/non-JSON answers parse to nothing", () => {
    expect(parseDistillAnswer("no proposals this time")).toEqual([]);
  });

  it("collapses multi-line bodies to one line", () => {
    const text = JSON.stringify([{ class: "decision", body: "line one\nline two", section: "general", evidence: ["A-1"] }]);
    const parsed = parseDistillAnswer(text);
    expect(parsed[0]!.body).toBe("line one line two");
  });
});

describe("distill raw helpers (K-5, I-7)", () => {
  it("recognises life projects lexically", () => {
    expect(taskIsLife({ projectName: "fleet-life" })).toBe(true);
    expect(taskIsLife({ projectName: "directions/life" })).toBe(true);
    expect(taskIsLife({ projectName: "life" })).toBe(true);
    expect(taskIsLife({ projectName: "lighthouse" })).toBe(false);
    expect(taskIsLife({ projectName: "fleet-work" })).toBe(false);
    expect(taskIsLife({ projectName: null })).toBe(false);
  });

  it("pass window uses the last pass when it is more recent than the floor", () => {
    const now = new Date("2026-10-09T12:00:00Z");
    const fresh = passWindow(now, 24 * 3600_000, new Date("2026-10-09T06:00:00Z"));
    expect(fresh.since.toISOString()).toBe("2026-10-09T06:00:00.000Z");
    const stale = passWindow(now, 3600_000, new Date("2026-10-08T06:00:00Z"));
    expect(stale.since.toISOString()).toBe("2026-10-09T11:00:00.000Z");
    expect(stale.until).toBe(now);
  });
});
