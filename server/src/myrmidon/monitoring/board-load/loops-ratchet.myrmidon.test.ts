// myrmidon(1.7 FLEET-OPS-BULK / EVENT-LOOPS A, OPE-12618): the registry of
// periodic background loops and the "new timer — with a record" ratchet.
//
// What this test pins:
//   (1) the per-file counters of `setInterval(`, `laneInterval(` and
//       `backgroundInterval(` across `server/src` (excluding `*.test.ts` and
//       `__tests__`) match the baseline map below;
//   (2) every path listed in the baseline map exists on disk;
//   (3) a synthetic file with `setInterval(` dropped into `server/src` makes
//       the test fail with a hint telling the author which doc row to add.
//
// The baseline map is the single source of truth for "how many periodic
// timers the board process arms".  When a new timer is added, the counters
// drift and the test goes red until the map is updated AND the loop is
// described in `docs/myrmidon/background-loops.md` (and `.ru.md`).
//
// Run:
//   pnpm --filter @myrmidon/server exec vitest run src/myrmidon/monitoring/board-load/loops-ratchet.myrmidon.test.ts

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Baseline map: file path (repo-relative) → counters.
//
// The counts cover code lines only — lines whose trimmed form starts with
// `//` or `*` (doc comments) are skipped, so re-wording a comment never
// trips the ratchet.  Multi-line call sites count once per opening paren.
//
// When you add a new periodic timer:
//   1. Add the row to docs/myrmidon/background-loops.md (and .ru.md).
//   2. Bump the counter for the file here.
//   3. If the timer is a brand-new loop (not a replacement), also add its
//      lane name to BOARD_LANES in lanes.ts when it needs a dedicated lane.
// ---------------------------------------------------------------------------

const BASELINE: Record<string, { setInterval: number; laneInterval: number; backgroundInterval: number }> = {
  "server/src/app.ts": { setInterval: 2, laneInterval: 0, backgroundInterval: 0 },
  "server/src/index.ts": { setInterval: 0, laneInterval: 2, backgroundInterval: 2 },
  "server/src/myrmidon/backup-catch-up.ts": { setInterval: 1, laneInterval: 0, backgroundInterval: 0 },
  "server/src/myrmidon/baseline/startup.ts": { setInterval: 0, laneInterval: 0, backgroundInterval: 1 },
  "server/src/myrmidon/bot-containers/bot-disk-service.ts": { setInterval: 0, laneInterval: 0, backgroundInterval: 1 },
  "server/src/myrmidon/bot-containers/canary-index.ts": { setInterval: 0, laneInterval: 0, backgroundInterval: 1 },
  "server/src/myrmidon/bot-containers/fleet-memory-sync.ts": { setInterval: 0, laneInterval: 1, backgroundInterval: 0 },
  "server/src/myrmidon/bot-containers/fleet-replica-lane.ts": { setInterval: 0, laneInterval: 1, backgroundInterval: 0 },
  "server/src/myrmidon/bot-containers/fleet-site-routes.ts": { setInterval: 1, laneInterval: 0, backgroundInterval: 0 },
  "server/src/myrmidon/bot-containers/index.ts": { setInterval: 0, laneInterval: 1, backgroundInterval: 0 },
  "server/src/myrmidon/bot-containers/site-health-startup.ts": { setInterval: 0, laneInterval: 1, backgroundInterval: 0 },
  "server/src/myrmidon/bot-containers/site-scheduler-lane.ts": { setInterval: 0, laneInterval: 1, backgroundInterval: 0 },
  "server/src/myrmidon/chat-reconciliation/reconcile-interval.ts": { setInterval: 0, laneInterval: 1, backgroundInterval: 0 },
  "server/src/myrmidon/datastore-care/startup.ts": { setInterval: 0, laneInterval: 0, backgroundInterval: 1 },
  "server/src/myrmidon/deploy-jobs/index.ts": { setInterval: 0, laneInterval: 0, backgroundInterval: 1 },
  "server/src/myrmidon/distill/startup.ts": { setInterval: 0, laneInterval: 0, backgroundInterval: 2 },
  "server/src/myrmidon/features/sweep.ts": { setInterval: 0, laneInterval: 0, backgroundInterval: 1 },
  "server/src/myrmidon/foraging/startup.ts": { setInterval: 0, laneInterval: 0, backgroundInterval: 2 },
  "server/src/myrmidon/guardrails/entities/cleanup.ts": { setInterval: 1, laneInterval: 0, backgroundInterval: 0 },
  "server/src/myrmidon/idle-stop.ts": { setInterval: 0, laneInterval: 0, backgroundInterval: 1 },
  "server/src/myrmidon/knowledge/git-export-job.ts": { setInterval: 0, laneInterval: 0, backgroundInterval: 1 },
  "server/src/myrmidon/leader-lease/index.ts": { setInterval: 0, laneInterval: 0, backgroundInterval: 1 },
  "server/src/myrmidon/lesson-distill/startup.ts": { setInterval: 0, laneInterval: 0, backgroundInterval: 1 },
  "server/src/myrmidon/licensing/denylist-pull.ts": { setInterval: 1, laneInterval: 0, backgroundInterval: 0 },
  "server/src/myrmidon/litellm-budget-sync/sweep.ts": { setInterval: 0, laneInterval: 0, backgroundInterval: 1 },
  "server/src/myrmidon/litellm-costs/startup.ts": { setInterval: 0, laneInterval: 0, backgroundInterval: 1 },
  "server/src/myrmidon/maintenance/index.ts": { setInterval: 0, laneInterval: 0, backgroundInterval: 1 },
  "server/src/myrmidon/model-providers/sweep.ts": { setInterval: 0, laneInterval: 0, backgroundInterval: 1 },
  "server/src/myrmidon/monitoring/alerts/root-fanout.ts": { setInterval: 1, laneInterval: 0, backgroundInterval: 0 },
  "server/src/myrmidon/monitoring/alerts/sweep.ts": { setInterval: 0, laneInterval: 0, backgroundInterval: 1 },
  "server/src/myrmidon/monitoring/board-load/lanes.ts": { setInterval: 1, laneInterval: 2, backgroundInterval: 1 },
  "server/src/myrmidon/process-registry/pulse.ts": { setInterval: 0, laneInterval: 0, backgroundInterval: 1 },
  "server/src/myrmidon/stack-registry/check.ts": { setInterval: 0, laneInterval: 0, backgroundInterval: 1 },
  "server/src/myrmidon/task-pr-sync/index.ts": { setInterval: 1, laneInterval: 0, backgroundInterval: 0 },
  "server/src/myrmidon/telegram-notify/errors-sweep.ts": { setInterval: 0, laneInterval: 0, backgroundInterval: 1 },
  "server/src/myrmidon/telegram-notify/jobs.ts": { setInterval: 0, laneInterval: 0, backgroundInterval: 1 },
  "server/src/myrmidon/tracing-health/attention-sweep.ts": { setInterval: 0, laneInterval: 0, backgroundInterval: 1 },
  "server/src/realtime/live-events-ws.ts": { setInterval: 1, laneInterval: 0, backgroundInterval: 0 },
  "server/src/routes/execution-workspaces.ts": { setInterval: 1, laneInterval: 0, backgroundInterval: 0 },
  "server/src/routes/issues.ts": { setInterval: 1, laneInterval: 0, backgroundInterval: 0 },
  "server/src/services/chat-channels.ts": { setInterval: 3, laneInterval: 0, backgroundInterval: 1 },
  "server/src/services/email-channels.ts": { setInterval: 0, laneInterval: 0, backgroundInterval: 3 },
  "server/src/services/external-objects.ts": { setInterval: 1, laneInterval: 0, backgroundInterval: 0 },
  "server/src/services/github-rate-limit.ts": { setInterval: 1, laneInterval: 0, backgroundInterval: 0 },
  "server/src/services/leader-lease.ts": { setInterval: 1, laneInterval: 0, backgroundInterval: 1 },
  "server/src/services/legacy-controller-lease.ts": { setInterval: 0, laneInterval: 0, backgroundInterval: 1 },
  "server/src/services/native-runtime/native-session-executor.ts": { setInterval: 1, laneInterval: 0, backgroundInterval: 0 },
  "server/src/services/photon/receiver.ts": { setInterval: 1, laneInterval: 0, backgroundInterval: 0 },
  "server/src/services/plugin-host-services.ts": { setInterval: 1, laneInterval: 0, backgroundInterval: 0 },
  "server/src/services/plugin-job-scheduler.ts": { setInterval: 0, laneInterval: 0, backgroundInterval: 1 },
  "server/src/services/plugin-log-retention.ts": { setInterval: 0, laneInterval: 0, backgroundInterval: 1 },
  "server/src/services/question-response-delivery.ts": { setInterval: 1, laneInterval: 0, backgroundInterval: 0 },
  "server/src/services/workspace-operations.ts": { setInterval: 1, laneInterval: 0, backgroundInterval: 0 },
};

// ---------------------------------------------------------------------------
// Counter: walks server/src, skips *.test.ts and __tests__, skips pure
// comment lines, returns per-file counters for files that have at least one
// match.
// ---------------------------------------------------------------------------

interface FileCounts {
  setInterval: number;
  laneInterval: number;
  backgroundInterval: number;
}

const PATTERNS: Record<keyof FileCounts, RegExp> = {
  setInterval: /setInterval\(/g,
  laneInterval: /laneInterval\(/g,
  backgroundInterval: /backgroundInterval\(/g,
};

function countTimers(repoRoot: string): Record<string, FileCounts> {
  const srcRoot = path.join(repoRoot, "server", "src");
  const out: Record<string, FileCounts> = {};

  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__") continue;
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      if (entry.name.endsWith(".test.ts")) continue;
      const rel = path.relative(repoRoot, full).split(path.sep).join("/");
      const content = fs.readFileSync(full, "utf8");
      const counts: FileCounts = { setInterval: 0, laneInterval: 0, backgroundInterval: 0 };
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
        for (const key of Object.keys(PATTERNS) as Array<keyof FileCounts>) {
          counts[key] += (line.match(PATTERNS[key]) ?? []).length;
        }
      }
      if (counts.setInterval + counts.laneInterval + counts.backgroundInterval > 0) {
        out[rel] = counts;
      }
    }
  }

  walk(srcRoot);
  return out;
}

// Resolve repo root from this file's location:
//   server/src/myrmidon/monitoring/board-load/loops-ratchet.myrmidon.test.ts
//   → repo root is 6 levels up.
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");

describe("background-loops ratchet", () => {
  it("every path in the baseline map exists", () => {
    for (const rel of Object.keys(BASELINE)) {
      expect(fs.existsSync(path.join(REPO_ROOT, rel)), `baseline path ${rel} must exist`).toBe(true);
    }
  });

  it("per-file timer counters match the baseline map", () => {
    const actual = countTimers(REPO_ROOT);
    const errors: string[] = [];

    // Files in baseline but not on disk (deleted loops).
    for (const [rel, expected] of Object.entries(BASELINE)) {
      if (!(rel in actual)) {
        // The path-existence test already covers this; only report a counter
        // mismatch when the file exists but has zero timers.
        if (fs.existsSync(path.join(REPO_ROOT, rel))) {
          const total = expected.setInterval + expected.laneInterval + expected.backgroundInterval;
          if (total > 0) {
            errors.push(`${rel}: file exists but counters are zero (expected ${JSON.stringify(expected)})`);
          }
        }
        continue;
      }
      const got = actual[rel];
      for (const key of ["setInterval", "laneInterval", "backgroundInterval"] as const) {
        if (got[key] !== expected[key]) {
          errors.push(`${rel}: ${key} expected ${expected[key]}, got ${got[key]}`);
        }
      }
    }

    // Files on disk but not in baseline (new timers without a record).
    for (const [rel, got] of Object.entries(actual)) {
      if (!(rel in BASELINE)) {
        errors.push(
          `${rel}: new timers without a baseline record ` +
            `(setInterval=${got.setInterval}, laneInterval=${got.laneInterval}, backgroundInterval=${got.backgroundInterval}). ` +
            `Add a row to docs/myrmidon/background-loops.md and docs/myrmidon/background-loops.ru.md, ` +
            `then add this file's counters to BASELINE in loops-ratchet.myrmidon.test.ts.`,
        );
      }
    }

    expect(errors, errors.join("\n")).toEqual([]);
  });

  it("a synthetic file with setInterval( makes the ratchet fail", () => {
    // Write a synthetic file, re-run the counter, then clean up.  This proves
    // the test is not vacuously green: an unrecorded timer is caught.
    const syntheticRel = "server/src/myrmidon/monitoring/board-load/__ratchet_probe__.ts";
    const syntheticAbs = path.join(REPO_ROOT, syntheticRel);
    fs.writeFileSync(syntheticAbs, "export const probe = setInterval(() => {}, 60_000);\n");
    try {
      const actual = countTimers(REPO_ROOT);
      expect(actual[syntheticRel]?.setInterval).toBe(1);
      // The file must NOT be in the baseline — the counter test would fail.
      expect(BASELINE[syntheticRel]).toBeUndefined();
    } finally {
      fs.unlinkSync(syntheticAbs);
    }
  });
});
