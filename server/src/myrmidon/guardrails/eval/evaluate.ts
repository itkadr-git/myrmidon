// myrmidon(1.7-GRD-CI): pure scoring harness for the GUARDRAILS reference
// corpus (1.6.1 GUARDRAILS part C) against the current detectors.
//
// The corpus is labelled data: every case carries `expect.detector` — the
// detector that must fire on it, or `null` for neutral ("clean") fixtures
// where nothing may fire. This module runs registered rules over those cases
// and produces a per-rule report (support, tp/fp/fn, precision, recall) plus
// the blocking measure: false blocks — rules that fired on clean fixtures.
//
// The CI contract of this track: the evaluated report must have zero false
// blocks, and the committed per-rule artifact (report.json / report.md next
// to this module) must match the recomputed report, so any change in what
// the detectors do on the corpus is visible in the PR diff and in CI.
//
// Pure: no env, no IO, no vitest/node-test imports. The caller supplies the
// cases and the rules; the wiring lives in ./rules.ts.

import type { CorpusCase } from "../corpus/index.js";

/** A rule is one detector the eval knows how to run on a text. */
export interface EvalRule {
  /** Rule id — for guardrails this is the detector id: "secret" | "pii" | "injection". */
  id: string;
  /** Human-readable surface, e.g. "output" or "input". */
  surface: string;
  /**
   * Runs the detector on a text. `fired` is the blocking decision: a rule
   * that fires on a clean fixture is a false block. `detail` is any extra
   * rule-side information (e.g. matched heuristic group ids) for the report.
   */
  scan: (text: string) => { fired: boolean; detail?: string[] };
  /**
   * Base-layer availability: rules whose module is not merged into main yet
   * (secret/pii detectors, GUARDRAILS part A) are reported as pending
   * instead of failing the eval; they activate automatically once merged.
   */
  status?: "active" | "pending-base-layer";
}

export interface SubtypeRow {
  /** Corpus subtype label of the expected cases (category for benign). */
  subtype: string;
  /** Cases carrying this expected label for the rule's detector. */
  support: number;
  /** Of those cases, how many the rule fired on. */
  fired: number;
  /** fired / support; null for rules that were not run (pending). */
  recall: number | null;
}

export interface RuleReport {
  rule: string;
  surface: string;
  status: "active" | "pending-base-layer";
  /** Cases whose expected detector is this rule. */
  support: number;
  /** Expected and fired. */
  tp: number;
  /** Not expected, fired (includes false blocks on clean fixtures). */
  fp: number;
  /** Expected, not fired. */
  fn: number;
  /** Clean fixtures this rule fired on (must stay 0 — the CI gate). */
  falseBlocks: number;
  /** tp / (tp + fp); null when the rule was not run (pending). */
  precision: number | null;
  /** tp / (tp + fn); null when the rule was not run; 1 when support is 0. */
  recall: number | null;
  /** Per expected-subtype recall rows, sorted by subtype. */
  subtypes: SubtypeRow[];
  /** Corpus case ids of the false blocks (empty when the rule is clean). */
  falseBlockCaseIds: string[];
  /** Corpus case ids expected to fire but missed (sorted, capped by caller). */
  missedCaseIds: string[];
}

export interface EvalReport {
  /** Stable schema marker for the committed artifact. */
  schema: "myrmidon-guardrails-eval-v1";
  corpusCases: number;
  rules: RuleReport[];
  /** Sum of false blocks across active rules — the blocking number. */
  totalFalseBlocks: number;
}

function ratio(numerator: number, denominator: number): number {
  if (denominator === 0) {
    return numerator === 0 ? 1 : 0;
  }
  return round(numerator / denominator);
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/**
 * Evaluate the corpus against the rules. Deterministic: everything is sorted
 * so the generated artifact diffs cleanly.
 */
export function evaluateCorpus(
  cases: readonly CorpusCase[],
  rules: readonly EvalRule[],
): EvalReport {
  const ruleReports: RuleReport[] = rules.map((rule) => {
    const status = rule.status ?? "active";
    let tp = 0;
    let fp = 0;
    let fn = 0;
    let support = 0;
    let falseBlocks = 0;
    const falseBlockCaseIds: string[] = [];
    const missedCaseIds: string[] = [];
    const subtypeStats = new Map<string, { support: number; fired: number }>();

    for (const c of cases) {
      // Pending rules are not run at all: their numbers stay zero and the
      // gate ignores them. Only the expected coverage (support) is listed.
      const fired = status === "active" && rule.scan(c.text).fired;
      if (c.expect.detector === rule.id) {
        support += 1;
        const row = subtypeStats.get(c.subtype) ?? { support: 0, fired: 0 };
        row.support += 1;
        if (status === "active") {
          if (fired) {
            row.fired += 1;
            tp += 1;
          } else {
            fn += 1;
            missedCaseIds.push(c.id);
          }
        }
        subtypeStats.set(c.subtype, row);
      } else if (fired) {
        fp += 1;
        if (c.expect.detector === null) {
          falseBlocks += 1;
          falseBlockCaseIds.push(c.id);
        }
      }
    }

    const subtypes: SubtypeRow[] = [...subtypeStats.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([subtype, s]) => ({
        subtype,
        support: s.support,
        fired: s.fired,
        recall: status === "active" ? ratio(s.fired, s.support) : null,
      }));

    return {
      rule: rule.id,
      surface: rule.surface,
      status,
      support,
      tp,
      fp,
      fn,
      falseBlocks,
      precision: status === "active" ? ratio(tp, tp + fp) : null,
      recall: status === "active" ? ratio(tp, tp + fn) : null,
      subtypes,
      falseBlockCaseIds: falseBlockCaseIds.sort(),
      missedCaseIds: missedCaseIds.sort(),
    };
  });

  return {
    schema: "myrmidon-guardrails-eval-v1",
    corpusCases: cases.length,
    rules: ruleReports.sort((a, b) => a.rule.localeCompare(b.rule)),
    totalFalseBlocks: ruleReports.reduce(
      (sum, r) => (r.status === "active" ? sum + r.falseBlocks : sum),
      0,
    ),
  };
}

/** Gate view: the blocking findings, one line each, for test failure text. */
export function gateFailures(report: EvalReport): string[] {
  const failures: string[] = [];
  for (const r of report.rules) {
    if (r.status !== "active") {
      continue;
    }
    for (const caseId of r.falseBlockCaseIds) {
      failures.push(
        `false block: rule "${r.rule}" fired on clean fixture "${caseId}"`,
      );
    }
  }
  return failures;
}

/** Markdown rendering of the per-rule report for the committed artifact. */
export function renderReportMarkdown(report: EvalReport): string {
  const lines: string[] = [];
  lines.push("# GUARDRAILS corpus eval report (generated artifact)");
  lines.push("");
  lines.push(
    "Generated by `pnpm --filter @paperclipai/server exec tsx ../scripts/myrmidon/guardrails-eval/refresh.ts`.",
  );
  lines.push(
    "Refresh and commit whenever the corpus or a detector changes; CI fails on drift.",
  );
  lines.push(
    "The blocking gate is `false blocks on clean fixtures` — the goal is 0.",
  );
  lines.push("");
  lines.push(`Corpus cases: ${report.corpusCases}`);
  lines.push(`Total false blocks (active rules): **${report.totalFalseBlocks}**`);
  lines.push("");
  lines.push("| Rule | Status | Support | TP | FP | FN | False blocks | Precision | Recall |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const r of report.rules) {
    const num = (v: number | null): string => (v === null ? "—" : v.toFixed(4));
    lines.push(
      `| ${r.rule} | ${r.status} | ${r.support} | ${r.tp} | ${r.fp} | ${r.fn} | ${r.falseBlocks} | ${num(r.precision)} | ${num(r.recall)} |`,
    );
  }
  for (const r of report.rules) {
    if (r.subtypes.length === 0) {
      continue;
    }
    lines.push("");
    lines.push(`## Rule \`${r.rule}\` — recall by expected subtype`);
    lines.push("");
    lines.push("| Subtype | Support | Fired | Recall |");
    lines.push("|---|---|---|---|");
    for (const s of r.subtypes) {
      const rec = s.recall === null ? "—" : s.recall.toFixed(4);
      lines.push(
        `| ${s.subtype} | ${s.support} | ${s.fired} | ${rec} |`,
      );
    }
    if (r.missedCaseIds.length > 0) {
      lines.push("");
      lines.push(`Missed cases: ${r.missedCaseIds.join(", ")}`);
    }
    if (r.falseBlockCaseIds.length > 0) {
      lines.push("");
      lines.push(`False blocks: ${r.falseBlockCaseIds.join(", ")}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}
