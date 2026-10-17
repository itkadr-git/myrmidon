// myrmidon(1.7-GRD-CI): the committed per-rule report of the corpus eval.
//
// Two generated files live next to this module:
//   - report.json — machine-readable EvalReport (stable stringify, no
//     timestamps: two runs on the same code produce byte-identical files);
//   - report.md   — the same report rendered for humans (per-rule precision/
//     recall and the false-block rows).
//
// These are the CI artifact of the guardrails eval: the test
// recomputes the report from the corpus + detectors and fails on any drift,
// so shipping a detector change without looking at its effect on the
// reference corpus is impossible. Refresh deliberately after changing any
// detector or corpus file:
//   pnpm --filter @paperclipai/server exec tsx \
//     ../scripts/myrmidon/guardrails-eval/refresh.ts
// and commit both files in the same PR.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { EvalReport } from "./evaluate.js";

const HERE = dirname(fileURLToPath(import.meta.url));

export const REPORT_JSON_PATH = join(HERE, "report.json");
export const REPORT_MD_PATH = join(HERE, "report.md");

/** Stable serialization: fixed key order, 2-space indent, trailing newline. */
export function serializeReport(report: EvalReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function readCommittedJson(): string {
  return readFileSync(REPORT_JSON_PATH, "utf8");
}

export function readCommittedMarkdown(): string {
  return readFileSync(REPORT_MD_PATH, "utf8");
}

export function writeCommittedFiles(json: string, markdown: string): void {
  writeFileSync(REPORT_JSON_PATH, json);
  writeFileSync(REPORT_MD_PATH, markdown);
}
