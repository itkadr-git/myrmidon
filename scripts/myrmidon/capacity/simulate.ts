// scripts/myrmidon/capacity/simulate.ts
//
// CLI command to run the 1.6.6 capacity policy replay simulator (OPE-9200).
// Compares readiness ratio before and after capacity policy on the fixed snapshot fixture.

import { resolve } from "node:path";
import {
  DEFAULT_1_6_6_FIXTURE_PATH,
  compareCapacityPolicyReplay,
  formatReplayReport,
  loadSnapshotFixture,
} from "../../../server/src/myrmidon/capacity/capacity-simulator.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let fixturePath = DEFAULT_1_6_6_FIXTURE_PATH;
  let maxSteps = 30;
  let taskDurationSteps = 2;
  let jsonOutput = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--fixture" && args[i + 1]) {
      fixturePath = resolve(process.cwd(), args[++i]);
    } else if (args[i] === "--steps" && args[i + 1]) {
      maxSteps = parseInt(args[++i], 10);
    } else if (args[i] === "--duration" && args[i + 1]) {
      taskDurationSteps = parseInt(args[++i], 10);
    } else if (args[i] === "--json") {
      jsonOutput = true;
    }
  }

  const snapshot = loadSnapshotFixture(fixturePath);
  const result = compareCapacityPolicyReplay({
    snapshot,
    maxSteps,
    taskDurationSteps,
  });

  if (jsonOutput) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(formatReplayReport(result) + "\n");
  }

  if (!result.comparison.readinessRatioIncreased || !result.comparison.claimsIntegrityPreserved) {
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Simulation failed:", err);
    process.exit(1);
  });
}
