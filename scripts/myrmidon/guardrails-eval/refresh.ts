// myrmidon(1.7-GRD-CI): regenerate the committed GUARDRAILS corpus eval
// artifacts (server/src/myrmidon/guardrails/eval/report.{json,md}).
//
// Run from the server package so its dependencies resolve:
//   pnpm --filter @paperclipai/server exec tsx \
//     ../scripts/myrmidon/guardrails-eval/refresh.ts
//
// Exit 0, printing the refreshed paths, when the recomputed report contains
// zero false blocks on clean fixtures. Exit 1 (files NOT written, gate stays
// red) when any active rule fires on a clean fixture — the artifact in git
// then differs from the eval, which the vitest drift check catches.
// Relative imports: this file lives outside the server package, so bare
// workspace specifiers would not resolve from here (same convention as
// scripts/myrmidon/plugin-compat/check.ts).

import { loadCorpus } from "../../../server/src/myrmidon/guardrails/corpus/index.js";
import {
  evaluateCorpus,
  gateFailures,
  renderReportMarkdown,
} from "../../../server/src/myrmidon/guardrails/eval/evaluate.js";
import { buildRules } from "../../../server/src/myrmidon/guardrails/eval/rules.js";
import {
  serializeReport,
  writeCommittedFiles,
} from "../../../server/src/myrmidon/guardrails/eval/report-files.js";

async function main(): Promise<number> {
  const report = evaluateCorpus(loadCorpus(), await buildRules());

  const failures = gateFailures(report);
  if (failures.length > 0) {
    console.error("GUARDRAILS corpus eval is RED — artifacts not refreshed:");
    for (const f of failures) {
      console.error(`  - ${f}`);
    }
    console.error(
      "The committed report must carry zero false blocks on clean fixtures;",
    );
    console.error("fix the detector (or re-review the fixture), then refresh.");
    return 1;
  }

  writeCommittedFiles(serializeReport(report), renderReportMarkdown(report));
  console.log("refreshed server/src/myrmidon/guardrails/eval/report.json");
  console.log("refreshed server/src/myrmidon/guardrails/eval/report.md");
  for (const r of report.rules) {
    console.log(
      `  rule ${r.rule}: status=${r.status} support=${r.support} ` +
        `precision=${r.precision ?? "-"} recall=${r.recall ?? "-"} ` +
        `falseBlocks=${r.falseBlocks}`,
    );
  }
  return 0;
}

process.exitCode = await main();
