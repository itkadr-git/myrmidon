// myrmidon(1.7-GRD-CI): tests for the GUARDRAILS corpus eval harness — the
// CI gate that false blocks on clean reference fixtures must stay 0 and the
// committed per-rule report must match what the detectors do now.
//
// Neutral data only. No live board ticket ids in assertions.
import { describe, expect, it } from "vitest";

import { loadCorpus, type CorpusCase } from "../corpus/index.js";
import {
  evaluateCorpus,
  gateFailures,
  renderReportMarkdown,
  type EvalReport,
  type EvalRule,
} from "./evaluate.js";
import { buildRules, injectionRule, outputRules, pendingOutputRules } from "./rules.js";
import { readCommittedJson, readCommittedMarkdown, serializeReport } from "./report-files.js";

const CASES: CorpusCase[] = loadCorpus();

/** A rule that fires on cases whose text is in `fireTexts`. */
function firingRule(id: string, fireTexts: readonly string[]): EvalRule {
  const texts = new Set(fireTexts);
  return { id, surface: "test", status: "active", scan: (text) => ({ fired: texts.has(text) }) };
}

describe("GUARDRAILS corpus eval scoring", () => {
  const secretCases = CASES.filter((c) => c.category === "secret");
  const piiCases = CASES.filter((c) => c.category === "pii");
  const benignCases = CASES.filter((c) => c.expect.detector === null);

  it("counts tp/fp/fn per rule and computes precision/recall", () => {
    // "secret" rule firing on 5 of its own cases AND 2 pii cases:
    // tp=5, fp=2 (not expected for this rule), fn=support-5, no benign hit.
    const rules = [
      firingRule(
        "secret",
        [
          ...secretCases.slice(0, 5).map((c) => c.text),
          ...piiCases.slice(0, 2).map((c) => c.text),
        ],
      ),
    ];
    const report = evaluateCorpus(CASES, rules);
    const r = report.rules.find((x) => x.rule === "secret")!;
    expect(r.support).toBe(secretCases.length);
    expect(r.tp).toBe(5);
    expect(r.fp).toBe(2);
    expect(r.fn).toBe(secretCases.length - 5);
    expect(r.falseBlocks).toBe(0);
    expect(r.precision).toBeCloseTo(5 / 7, 4);
    expect(r.recall).toBeCloseTo(5 / secretCases.length, 4);
    expect(report.totalFalseBlocks).toBe(0);
    expect(gateFailures(report)).toEqual([]);
  });

  it("a rule firing on clean fixtures is a false block and a gate failure", () => {
    expect(benignCases.length).toBeGreaterThan(1);
    const rules = [firingRule("pii", [benignCases[0].text, benignCases[1].text])];
    const report = evaluateCorpus(CASES, rules);
    const r = report.rules.find((x) => x.rule === "pii")!;
    expect(r.falseBlocks).toBe(2);
    expect(r.fp).toBe(2);
    expect(r.falseBlockCaseIds).toEqual(
      [benignCases[0].id, benignCases[1].id].sort(),
    );
    expect(report.totalFalseBlocks).toBe(2);
    const failures = gateFailures(report);
    expect(failures).toHaveLength(2);
    expect(failures.join("\n")).toContain(benignCases[0].id);
    expect(failures[0]).toMatch(/^false block: rule "pii" fired on clean fixture/);
  });

  it("pending-base-layer rules report coverage but never fire or gate", () => {
    const report = evaluateCorpus(CASES, pendingOutputRules());
    expect(report.rules).toHaveLength(2);
    for (const r of report.rules) {
      expect(r.status).toBe("pending-base-layer");
      expect(r.tp).toBe(0);
      expect(r.fp).toBe(0);
      expect(r.fn).toBe(0);
      expect(r.precision).toBeNull();
      expect(r.recall).toBeNull();
      expect(r.support).toBeGreaterThan(0);
    }
    expect(report.totalFalseBlocks).toBe(0);
    expect(gateFailures(report)).toEqual([]);
  });

  it("renderReportMarkdown shows per-rule rows and false-block case ids", () => {
    const clean = evaluateCorpus(CASES, [injectionRule()]);
    const md = renderReportMarkdown(clean);
    expect(md).toContain("| injection |");
    expect(md).toContain("Total false blocks (active rules): **0**");
    const dirty = evaluateCorpus(CASES, [firingRule("injection", [benignCases[0].text])]);
    const dirtyMd = renderReportMarkdown(dirty);
    expect(dirtyMd).toContain(`False blocks: ${benignCases[0].id}`);
  });

  it("serialization is deterministic", () => {
    const run = () => serializeReport(evaluateCorpus(CASES, [injectionRule()]));
    expect(run()).toBe(run());
    const parsed = JSON.parse(run()) as EvalReport;
    expect(parsed.schema).toBe("myrmidon-guardrails-eval-v1");
    expect(parsed.corpusCases).toBe(CASES.length);
  });
});

describe("GUARDRAILS corpus eval on the reference corpus (CI gate)", () => {
  it("zero false blocks on clean fixtures for every active rule", async () => {
    const report = evaluateCorpus(CASES, await buildRules());
    expect(gateFailures(report)).toEqual([]);
    expect(report.totalFalseBlocks).toBe(0);
  });

  it("the injection rule is active and covers the whole injection category", async () => {
    const rules = await buildRules();
    const report = evaluateCorpus(CASES, rules);
    const inj = report.rules.find((r) => r.rule === "injection")!;
    expect(inj.status).toBe("active");
    expect(inj.support).toBe(CASES.filter((c) => c.category === "injection").length);
    expect(inj.tp + inj.fn).toBe(inj.support);
    expect(inj.falseBlocks).toBe(0);
  });

  it("the committed report artifacts match the recomputed eval exactly", async () => {
    const report = evaluateCorpus(CASES, await buildRules());
    expect(serializeReport(report)).toBe(readCommittedJson());
    expect(renderReportMarkdown(report)).toBe(readCommittedMarkdown());
  });

  it("adding a knowingly false-positive detector turns the gate red", async () => {
    // Acceptance criterion: the moment a rule blocks a clean fixture the
    // gate view names it and the artifact drift check fails. Simulate the
    // regression the way #414 would cause it: a secret rule that fires on
    // a benign fixture.
    const base = await buildRules();
    const poisoned: EvalRule = {
      id: "secret",
      surface: "run output",
      status: "active",
      scan: (text) => ({ fired: text === benignPick().text }),
    };
    const report = evaluateCorpus(CASES, [...base.filter((r) => r.id !== "secret"), poisoned]);
    expect(report.totalFalseBlocks).toBe(1);
    const failures = gateFailures(report);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain(benignPick().id);
    expect(serializeReport(report)).not.toBe(readCommittedJson());
    expect(renderReportMarkdown(report)).not.toBe(readCommittedMarkdown());
  });

  it("a mislabeled corpus fixture fails the artifact drift check too", async () => {
    // Re-tagging a benign case as an injection target moves support/fn in
    // the injection report, so the committed artifact no longer matches.
    const injectionRules = [injectionRule()];
    const mutated: CorpusCase[] = CASES.map((c) =>
      c.id === benignPick().id
        ? { ...c, category: "injection" as const, expect: { detector: "injection" as const } }
        : c,
    );
    const report = evaluateCorpus(mutated, injectionRules);
    expect(serializeReport(report)).not.toBe(readCommittedJson());
  });
});

/** A benign fixture without heuristic-triggering shapes (stable pick). */
function benignPick(): CorpusCase {
  const c = CASES.find((x) => x.id === "benign-005");
  if (!c) {
    throw new Error("corpus lost benign-005");
  }
  return c;
}

describe("GUARDRAILS output rule wiring", () => {
  it("outputRules maps each category to its own rule", () => {
    const fakeDetect = {
      detectGuardrailHits: (text: string, categories: readonly ("secret" | "pii")[]) =>
        text.includes("AKIA") && categories.includes("secret")
          ? [{ kind: "secret" as const }]
          : [],
    };
    const rules = outputRules(fakeDetect);
    expect(rules.map((r) => r.id).sort()).toEqual(["pii", "secret"]);
    const secretRule = rules.find((r) => r.id === "secret")!;
    const piiRule = rules.find((r) => r.id === "pii")!;
    expect(secretRule.scan("key AKIAIOSFODNN7EXAMPLE").fired).toBe(true);
    expect(piiRule.scan("key AKIAIOSFODNN7EXAMPLE").fired).toBe(false);
    expect(secretRule.status).toBe("active");
  });
});
