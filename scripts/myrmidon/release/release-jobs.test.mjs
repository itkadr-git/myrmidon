// Tests for scripts/myrmidon/release/release-jobs.mjs (OPE-13002).
//
// Run: node --test scripts/myrmidon/release/release-jobs.test.mjs

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  extractJobGraph,
  extractJobs,
  buildJobs,
  gateDependencyJobs,
  matchesJob,
  isReleaseBuildJob,
  computeQueueOrder,
  isReleaseRun,
  isPriorityPoolRun,
  isReleaseWorkflowRun,
  queueViolations,
  priorityViolations,
  observedPriorityViolations,
  gateState,
} from "./release-jobs.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TAG_WORKFLOW = path.resolve(HERE, "../../../.github/workflows/myrmidon-ci-tag.yml");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal workflow YAML for unit tests (no file I/O). */
function makeWorkflowYaml(jobDefs) {
  const lines = ["name: test", "on:", "  push:", "jobs:"];
  for (const [id, name] of Object.entries(jobDefs)) {
    lines.push(`  ${id}:`);
    lines.push(`    name: ${name}`);
    lines.push(`    runs-on: ubuntu-latest`);
    lines.push(`    steps:`);
    lines.push(`      - run: echo hi`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// extractJobs
// ---------------------------------------------------------------------------

describe("extractJobs", () => {
  it("extracts job display names in file order", () => {
    const yaml = makeWorkflowYaml({
      typecheck: "typecheck",
      build: "build",
      tests: "tests (${{ matrix.label }})",
      "ci-result": "CI result",
    });
    const jobs = extractJobs(yaml);
    assert.deepEqual(jobs, ["typecheck", "build", "tests (${{ matrix.label }})", "CI result"]);
  });

  it("falls back to the job id when no display name is set", () => {
    const yaml = [
      "jobs:",
      "  my-job:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: echo hi",
    ].join("\n");
    const jobs = extractJobs(yaml);
    assert.deepEqual(jobs, ["my-job"]);
  });

  it("reads the real myrmidon-ci-tag.yml", () => {
    const yaml = fs.readFileSync(TAG_WORKFLOW, "utf8");
    const jobs = extractJobs(yaml);
    // The full tier of the tag CI. Keep this list in sync with the workflow.
    const expected = [
      "typecheck",
      "build",
      "tests (${{ matrix.label }})",
      "tests (other packages)",
      "tests (runner)",
      "checks",
      "fleetd",
      "dockergate",
      "CI result",
    ];
    assert.deepEqual(jobs, expected);
  });
});

// ---------------------------------------------------------------------------
// buildJobs
// ---------------------------------------------------------------------------

describe("buildJobs", () => {
  it("excludes the CI result gate job itself", () => {
    const all = ["typecheck", "build", "tests (x)", "CI result"];
    const result = buildJobs(all);
    assert.ok(!result.includes("CI result"));
    assert.equal(result.length, 3);
  });

  it("returns an empty list when there are no build jobs", () => {
    assert.deepEqual(buildJobs(["CI result"]), []);
    assert.deepEqual(buildJobs([]), []);
  });
});

// ---------------------------------------------------------------------------
// isReleaseBuildJob
// ---------------------------------------------------------------------------

describe("isReleaseBuildJob", () => {
  it("accepts jobs in the build set", () => {
    const set = ["typecheck", "build"];
    assert.ok(isReleaseBuildJob("typecheck", set));
    assert.ok(isReleaseBuildJob("build", set));
  });

  it("rejects foreign job names", () => {
    const set = ["typecheck", "build"];
    assert.ok(!isReleaseBuildJob("deploy", set));
    assert.ok(!isReleaseBuildJob("CI result", set));
    assert.ok(!isReleaseBuildJob("", set));
  });

  it("accepts matrix shard names against the workflow template", () => {
    const set = ["typecheck", "tests (${{ matrix.label }})"];
    assert.ok(isReleaseBuildJob("tests (server 1/6)", set));
    assert.ok(isReleaseBuildJob("tests (workspaces-a 1/2)", set));
    assert.ok(!isReleaseBuildJob("tests-other (server 1/6)", set));
    assert.ok(!isReleaseBuildJob("someone-elses-job", set));
  });
});

// ---------------------------------------------------------------------------
// matchesJob
// ---------------------------------------------------------------------------

describe("matchesJob", () => {
  it("matches exact names", () => {
    assert.ok(matchesJob("typecheck", "typecheck"));
    assert.ok(!matchesJob("typecheck", "build"));
  });

  it("matches matrix-expanded names against a template", () => {
    assert.ok(matchesJob("tests (server 1/6)", "tests (${{ matrix.label }})"));
    assert.ok(matchesJob("tests (serialized 5/5)", "tests (${{ matrix.label }})"));
  });

  it("requires the static parts of the template to match exactly", () => {
    assert.ok(!matchesJob("tests-other (server 1/6)", "tests (${{ matrix.label }})"));
    assert.ok(!matchesJob("test (server 1/6)", "tests (${{ matrix.label }})"));
    assert.ok(!matchesJob("tests (server 1/6) extra", "tests (${{ matrix.label }})"));
  });

  it("treats a name without a template as exact-only", () => {
    assert.ok(!matchesJob("build (arm64)", "build"));
  });

  it("never matches an empty observed name", () => {
    assert.ok(!matchesJob("", "tests (${{ matrix.label }})"));
    assert.ok(!matchesJob("", "typecheck"));
  });
});

// ---------------------------------------------------------------------------
// computeQueueOrder — release priority
// ---------------------------------------------------------------------------

describe("computeQueueOrder", () => {
  it("places release builds ahead of ordinary builds regardless of queue time", () => {
    const pending = [
      { name: "pr-100", isRelease: false, queuedAt: "2026-11-13T05:00:00Z" },
      { name: "tag-myr-v1.8.0", isRelease: true, queuedAt: "2026-11-13T06:00:00Z" },
      { name: "pr-101", isRelease: false, queuedAt: "2026-11-13T05:30:00Z" },
    ];
    const order = computeQueueOrder(pending);
    assert.equal(order[0].name, "tag-myr-v1.8.0");
    assert.equal(order[0].position, 0);
    assert.ok(order[0].isRelease);
    // Ordinary builds keep their relative order after the release build
    assert.equal(order[1].name, "pr-100");
    assert.equal(order[2].name, "pr-101");
  });

  it("preserves FIFO order within the same priority class", () => {
    const pending = [
      { name: "pr-a", isRelease: false, queuedAt: "2026-11-13T06:00:00Z" },
      { name: "pr-b", isRelease: false, queuedAt: "2026-11-13T05:00:00Z" },
      { name: "tag-1", isRelease: true, queuedAt: "2026-11-13T07:00:00Z" },
      { name: "tag-2", isRelease: true, queuedAt: "2026-11-13T06:30:00Z" },
    ];
    const order = computeQueueOrder(pending);
    assert.equal(order[0].name, "tag-2"); // earlier queuedAt among releases
    assert.equal(order[1].name, "tag-1");
    assert.equal(order[2].name, "pr-b"); // earlier queuedAt among ordinary
    assert.equal(order[3].name, "pr-a");
  });

  it("handles an empty queue", () => {
    assert.deepEqual(computeQueueOrder([]), []);
  });

  it("handles a queue of only release builds", () => {
    const pending = [
      { name: "tag-b", isRelease: true, queuedAt: "2026-11-13T06:00:00Z" },
      { name: "tag-a", isRelease: true, queuedAt: "2026-11-13T05:00:00Z" },
    ];
    const order = computeQueueOrder(pending);
    assert.equal(order[0].name, "tag-a");
    assert.equal(order[1].name, "tag-b");
  });
});

// ---------------------------------------------------------------------------
// isReleaseRun
// ---------------------------------------------------------------------------

describe("isReleaseRun", () => {
  it("classifies release tag runs (final and rc)", () => {
    assert.ok(isReleaseRun({ head_branch: "myr-v1.8.0" }));
    assert.ok(isReleaseRun({ head_branch: "myr-v1.8.0-rc.3" }));
  });

  it("rejects non-release runs", () => {
    assert.ok(!isReleaseRun({ head_branch: "main" }));
    assert.ok(!isReleaseRun({ head_branch: "bot/OPE-13002" }));
    assert.ok(!isReleaseRun({ head_branch: "" }));
    assert.ok(!isReleaseRun({}));
    // near-misses must not classify as release
    assert.ok(!isReleaseRun({ head_branch: "myr-v1.8" }));
    assert.ok(!isReleaseRun({ head_branch: "myr-v1.8.0-beta.1" }));
    assert.ok(!isReleaseRun({ head_branch: "v1.8.0" }));
  });
});

// ---------------------------------------------------------------------------
// isPriorityPoolRun — the monitor must classify runs by the same predicate
// myrmidon-ci.yml plan uses to route them to vars.CI_RUNNER_PRIORITY
// (reviewer finding on OPE-13002: misclassified priority-pool runs produced
// false queue-priority inversions)
// ---------------------------------------------------------------------------

describe("isPriorityPoolRun", () => {
  it("classifies release tag runs as priority pool", () => {
    assert.ok(isPriorityPoolRun({ head_branch: "myr-v1.8.0" }));
    assert.ok(isPriorityPoolRun({ head_branch: "myr-v1.8.0-rc.3" }));
  });

  it("classifies main pushes as priority pool", () => {
    assert.ok(isPriorityPoolRun({ head_branch: "main", event: "push" }));
  });

  it("classifies rel/ branch runs as priority pool", () => {
    assert.ok(isPriorityPoolRun({ head_branch: "rel/1.8.x", event: "push" }));
  });

  it("classifies release-stream PRs (title contains release or rc.N) as priority pool", () => {
    assert.ok(
      isPriorityPoolRun({
        head_branch: "bot/OPE-9999",
        event: "pull_request",
        display_title: "1.9 release: queue wiring (OPE-9999)",
      })
    );
    assert.ok(
      isPriorityPoolRun({
        head_branch: "bot/OPE-9998",
        event: "pull_request",
        display_title: "1.8 rc.2 cutoff (OPE-9998)",
      })
    );
  });

  it("rejects ordinary feature PRs and branch pushes", () => {
    assert.ok(
      !isPriorityPoolRun({
        head_branch: "bot/OPE-13001",
        event: "pull_request",
        display_title: "1.8 RELEASE-STAGE: unrelated lanes (OPE-13001)",
      })
    );
    assert.ok(
      !isPriorityPoolRun({ head_branch: "feature-x", event: "push" })
    );
    assert.ok(
      !isPriorityPoolRun({
        head_branch: "bot/OPE-12345",
        event: "pull_request",
        display_title: "fix flaky plan test (OPE-12345)",
      })
    );
  });

  it("matches the myrmidon-ci.yml plan predicate case-sensitively (RELEASE != release)", () => {
    // plan uses bash [[ =~ (rc\.[0-9]+|release) ]] — case-sensitive. A
    // title with only uppercase RELEASE must NOT route to the priority pool
    // in either place.
    assert.ok(
      !isPriorityPoolRun({
        head_branch: "bot/OPE-13001",
        event: "pull_request",
        display_title: "1.8 RELEASE-STAGE gates (OPE-13001)",
      })
    );
  });
});

// ---------------------------------------------------------------------------
// queueViolations
// ---------------------------------------------------------------------------

describe("queueViolations", () => {
  it("is empty when the queue order gives release builds priority", () => {
    // Actual queue order: release first, ordinary second.
    const pending = [
      { name: "myr-v1.8.0", isRelease: true, queuedAt: "2026-11-13T05:10:00Z" },
      { name: "pr-101", isRelease: false, queuedAt: "2026-11-13T05:20:00Z" },
    ];
    assert.deepEqual(queueViolations(pending), []);
  });

  it("flags an ordinary build queued later but holding a better position", () => {
    // Actual queue order: ordinary first — but it queued AFTER the release.
    const pending = [
      { name: "pr-101", isRelease: false, queuedAt: "2026-11-13T05:20:00Z" },
      { name: "myr-v1.8.0", isRelease: true, queuedAt: "2026-11-13T05:10:00Z" },
    ];
    const violations = queueViolations(pending);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].release, "myr-v1.8.0");
    assert.equal(violations[0].blockedBy, "pr-101");
  });

  it("allows an ordinary build that queued before the release to stay ahead", () => {
    const pending = [
      { name: "pr-100", isRelease: false, queuedAt: "2026-11-13T05:00:00Z" },
      { name: "myr-v1.8.0", isRelease: true, queuedAt: "2026-11-13T05:10:00Z" },
    ];
    assert.deepEqual(queueViolations(pending), []);
  });

  it("is empty for an empty queue", () => {
    assert.deepEqual(queueViolations([]), []);
  });

  it("compares every release against every later-queued ordinary build", () => {
    const pending = [
      { name: "pr-a", isRelease: false, queuedAt: "2026-11-13T05:30:00Z" },
      { name: "myr-v1.8.0", isRelease: true, queuedAt: "2026-11-13T05:00:00Z" },
      { name: "myr-v1.8.1", isRelease: true, queuedAt: "2026-11-13T05:10:00Z" },
    ];
    const violations = queueViolations(pending);
    // pr-a is ahead of both releases and queued after both — 2 violations.
    assert.equal(violations.length, 2);
  });
});

// ---------------------------------------------------------------------------
// isReleaseWorkflowRun
// ---------------------------------------------------------------------------

describe("isReleaseWorkflowRun", () => {
  it("classifies runs of the release-tag CI workflow", () => {
    assert.ok(isReleaseWorkflowRun({ name: "Myrmidon CI (tag)" }));
  });

  it("rejects runs of other workflows", () => {
    assert.ok(!isReleaseWorkflowRun({ name: "Myrmidon CI" }));
    assert.ok(!isReleaseWorkflowRun({ name: "Myrmidon CI (image)" }));
    assert.ok(!isReleaseWorkflowRun({}));
    assert.ok(!isReleaseWorkflowRun({ name: "" }));
  });
});

// ---------------------------------------------------------------------------
// priorityViolations — actual queue position
// ---------------------------------------------------------------------------

describe("priorityViolations", () => {
  it("accepts a Map of actual positions (oldest first)", () => {
    const runs = [
      { id: 1, name: "myr-v1.8.0", isRelease: true, queuedAt: "2026-11-13T05:10:00Z" },
      { id: 2, name: "pr-101", isRelease: false, queuedAt: "2026-11-13T05:20:00Z" },
    ];
    // Actual queue: release first.
    assert.deepEqual(priorityViolations(runs, new Map([["1", 0], ["2", 1]])), []);
    // Actual queue: ordinary first despite later queuedAt — violation.
    const v = priorityViolations(runs, new Map([["2", 0], ["1", 1]]));
    assert.equal(v.length, 1);
    assert.equal(v[0].release, "myr-v1.8.0");
    assert.equal(v[0].blockedBy, "pr-101");
  });

  it("accepts a position function", () => {
    const runs = [
      { id: 1, name: "myr-v1.8.0", isRelease: true, queuedAt: "2026-11-13T05:10:00Z" },
      { id: 2, name: "pr-101", isRelease: false, queuedAt: "2026-11-13T05:20:00Z" },
    ];
    const byId = { 1: 1, 2: 0 }; // ordinary ahead
    assert.equal(priorityViolations(runs, (r) => byId[r.id]).length, 1);
    const byId2 = { 1: 0, 2: 1 }; // release ahead
    assert.equal(priorityViolations(runs, (r) => byId2[r.id]).length, 0);
  });

  it("does not flag an ordinary run queued BEFORE the release even if ahead", () => {
    const runs = [
      { id: 1, name: "pr-100", isRelease: false, queuedAt: "2026-11-13T05:00:00Z" },
      { id: 2, name: "myr-v1.8.0", isRelease: true, queuedAt: "2026-11-13T05:10:00Z" },
    ];
    assert.deepEqual(priorityViolations(runs, new Map([["1", 0], ["2", 1]])), []);
  });

  it("treats runs missing from the position map as at the back of the queue", () => {
    const runs = [
      { id: 1, name: "myr-v1.8.0", isRelease: true, queuedAt: "2026-11-13T05:10:00Z" },
      { id: 2, name: "pr-101", isRelease: false, queuedAt: "2026-11-13T05:20:00Z" },
    ];
    // Ordinary run missing its position -> treated as at the back of the
    // queue -> cannot hold a better position than the release.
    assert.deepEqual(priorityViolations(runs, new Map([["1", 0]])), []);
  });

  // Behavioral coverage for the CI "Verify release build queue priority"
  // monitor: a release run queued BEHIND an ordinary run that queued LATER
  // is a violation, and the comparison set must represent ordinary runs.
  it("flags a release run queued behind a later-queued ordinary run", () => {
    // The monitor classifies every queued competing run by isReleaseRun and
    // orders by created_at. Simulate: ordinary main-CI PR run queued at 05:20
    // somehow holds position 0; the tag build queued at 05:10 sits at 1.
    const runs = [
      { id: 10, name: "myr-v1.8.0", isRelease: true, queuedAt: "2026-11-13T05:10:00Z" },
      { id: 11, name: "pr-31337", isRelease: false, queuedAt: "2026-11-13T05:20:00Z" },
    ];
    const actualPosition = new Map([
      ["11", 0], // ordinary run ahead despite queuing later
      ["10", 1],
    ]);
    const violations = priorityViolations(runs, actualPosition);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].release, "myr-v1.8.0");
    assert.equal(violations[0].blockedBy, "pr-31337");
    assert.equal(violations[0].blockedByQueuedAt, "2026-11-13T05:20:00Z");
  });

  it("passes when the release run holds the better actual position", () => {
    const runs = [
      { id: 10, name: "myr-v1.8.0", isRelease: true, queuedAt: "2026-11-13T05:10:00Z" },
      { id: 11, name: "pr-31337", isRelease: false, queuedAt: "2026-11-13T05:20:00Z" },
    ];
    const actualPosition = new Map([
      ["10", 0], // release ahead
      ["11", 1],
    ]);
    assert.deepEqual(priorityViolations(runs, actualPosition), []);
  });

  it("ignores unrelated workflow runs when building the comparison set", () => {
    // Runs of workflows that never occupy the priority pool (image builds,
    // publish) must not enter the comparison even if queued.
    const queued = [
      { id: 1, name: "Myrmidon CI (tag)", head_branch: "myr-v1.8.0", status: "queued", created_at: "2026-11-13T05:10:00Z" },
      { id: 2, name: "Myrmidon CI", head_branch: "pr-31337", status: "queued", created_at: "2026-11-13T05:20:00Z" },
      { id: 3, name: "Myrmidon Image", head_branch: "myr-v1.8.0", status: "queued", created_at: "2026-11-13T05:05:00Z" },
    ];
    const competing = queued.filter((r) =>
      r.name === "Myrmidon CI (tag)" || r.name === "Myrmidon CI"
    );
    assert.equal(competing.length, 2);
    assert.ok(competing.every((r) => r.name !== "Myrmidon Image"));
  });

  it("wires the tag CI queue-priority step to the observed-dispatch check", () => {
    // The monitor step must NOT derive queue positions from a created_at
    // sort (an assumed order, not an observed one) and must not collapse the
    // comparison set to only releases. It must feed every pending run of the
    // two release CI workflows into observedPriorityViolations, which flags
    // only PROVEN inversions: a later-queued ordinary run already dispatched
    // (started_at) while the release run has not started.
    const yaml = fs.readFileSync(TAG_WORKFLOW, "utf8");
    const step = yaml.split("Verify release build queue priority")[1] || "";
    assert.match(step, /observedPriorityViolations/);
    // Competing workflows are the tag workflow and the main CI; unrelated
    // workflows (image/publish) never enter the comparison set.
    assert.match(step, /r\.name === process\.env\.WORKFLOW_NAME \|\| r\.name === "Myrmidon CI"/);
    // No assumed ordering: the step must not sort by created_at to build
    // positions and must not call priorityViolations/queueViolations.
    assert.doesNotMatch(step, /localeCompare\(b\.created_at\)/);
    assert.doesNotMatch(step, /priorityViolations\(/);
    assert.doesNotMatch(step, /queueViolations\(/);
  });
});

// ---------------------------------------------------------------------------
// observedPriorityViolations
// ---------------------------------------------------------------------------

describe("observedPriorityViolations — behavioral", () => {
  // These tests are the behavioral verification the OPE-13002 reviewer
  // asked for: priority is judged from the FACTUAL dispatch order recorded
  // in started_at, never from an assumed created_at ordering.

  it("flags a release run still queued while a later-queued ordinary run has already started", () => {
    // The core behavioral case: release queued first, an ordinary run queued
    // AFTER it has factually been dispatched (started_at set) while the
    // release run has not — a proven priority inversion.
    const runs = [
      {
        id: 1,
        head_branch: "myr-v1.8.0",
        name: "Myrmidon CI (tag)",
        status: "queued",
        created_at: "2026-11-13T10:00:00Z",
        started_at: null,
      },
      {
        id: 2,
        head_branch: "feature-x",
        name: "Myrmidon CI",
        status: "in_progress",
        created_at: "2026-11-13T10:05:00Z",
        started_at: "2026-11-13T10:06:00Z",
      },
    ];
    const violations = observedPriorityViolations(runs);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].release, "myr-v1.8.0");
    assert.equal(violations[0].blockedBy, "feature-x");
    assert.equal(violations[0].blockedByQueuedAt, "2026-11-13T10:05:00Z");
    assert.equal(violations[0].blockedByStartedAt, "2026-11-13T10:06:00Z");
  });

  it("passes when the release run started before the ordinary run", () => {
    // Same queueing order, but the release run factually started first.
    const runs = [
      {
        id: 1,
        head_branch: "myr-v1.8.0",
        name: "Myrmidon CI (tag)",
        status: "in_progress",
        created_at: "2026-11-13T10:00:00Z",
        started_at: "2026-11-13T10:01:00Z",
      },
      {
        id: 2,
        head_branch: "feature-x",
        name: "Myrmidon CI",
        status: "queued",
        created_at: "2026-11-13T10:05:00Z",
        started_at: null,
      },
    ];
    assert.deepEqual(observedPriorityViolations(runs), []);
  });

  it("passes when both runs are still queued — no fact contradicts priority", () => {
    // Among runs that have not started, external observation cannot rank
    // them; absence of a contradiction is the honest pass. The mechanism
    // keeping them ordered (priority runner pool) is wired per ci-routing
    // tests, and any future dispatch violation is caught the moment it
    // becomes observable by the first behavioral test above.
    const runs = [
      {
        id: 1,
        head_branch: "myr-v1.8.0",
        name: "Myrmidon CI (tag)",
        status: "queued",
        created_at: "2026-11-13T10:00:00Z",
        started_at: null,
      },
      {
        id: 2,
        head_branch: "feature-x",
        name: "Myrmidon CI",
        status: "queued",
        created_at: "2026-11-13T10:05:00Z",
        started_at: null,
      },
    ];
    assert.deepEqual(observedPriorityViolations(runs), []);
  });

  it("ignores an ordinary run that queued BEFORE the release run", () => {
    // FIFO within the shared pool is not a priority violation: an ordinary
    // run already ahead in the queue when the release run arrived may
    // legitimately start first.
    const runs = [
      {
        id: 2,
        head_branch: "feature-x",
        name: "Myrmidon CI",
        status: "in_progress",
        created_at: "2026-11-13T09:55:00Z",
        started_at: "2026-11-13T09:56:00Z",
      },
      {
        id: 1,
        head_branch: "myr-v1.8.0",
        name: "Myrmidon CI (tag)",
        status: "queued",
        created_at: "2026-11-13T10:00:00Z",
        started_at: null,
      },
    ];
    assert.deepEqual(observedPriorityViolations(runs), []);
  });

  it("a completed ordinary run in the input set still proves the dispatch it made", () => {
    // Contract: the caller passes the PENDING set. If a completed ordinary
    // run is ever in the input, it has factually started — and a release run
    // still without started_at behind it is a proven inversion either way.
    // (In production both callers pre-filter to queued/in_progress runs, so
    // this shapes the pure function's behaviour, not a production path.)
    const runs = [
      {
        id: 1,
        head_branch: "myr-v1.8.0",
        name: "Myrmidon CI (tag)",
        status: "queued",
        created_at: "2026-11-13T10:00:00Z",
        started_at: null,
      },
      {
        id: 2,
        head_branch: "feature-x",
        name: "Myrmidon CI",
        status: "completed",
        conclusion: "success",
        created_at: "2026-11-13T10:05:00Z",
        started_at: "2026-11-13T10:06:00Z",
      },
    ];
    const violations = observedPriorityViolations(runs);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].blockedBy, "feature-x");
  });

  it("treats every input run as part of the competing set (callers filter by workflow)", () => {
    // The pure function deliberately does not filter by workflow: its
    // contract is "runs that can occupy the priority pool", and the callers
    // (the tag CI step, the publish gate) apply the workflow-name filter
    // before calling. A started ordinary run in the input set blocks a
    // not-yet-started release run regardless of the workflow field.
    // (The ordinary run here uses a feature branch — a main-branch run is a
    // PRIORITY-POOL run per the myrmidon-ci.yml plan predicate and must not
    // be reported as an inversion blocker.)
    const runs = [
      {
        id: 1,
        head_branch: "myr-v1.8.0",
        name: "Myrmidon CI (tag)",
        status: "queued",
        created_at: "2026-11-13T10:00:00Z",
        started_at: null,
      },
      {
        id: 2,
        head_branch: "feature-x",
        name: "Myrmidon Image",
        status: "in_progress",
        created_at: "2026-11-13T10:05:00Z",
        started_at: "2026-11-13T10:05:30Z",
      },
    ];
    const violations = observedPriorityViolations(runs);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].blockedBy, "feature-x");
  });

  it("does NOT flag a started priority-pool run (main push) as blocking a queued tag build", () => {
    // Reviewer finding on OPE-13002: main pushes and release PRs receive the
    // CI_RUNNER_PRIORITY label and legitimately start ahead of a queued tag
    // build. Misclassifying them as ordinary produced false inversions.
    const runs = [
      {
        id: 1,
        head_branch: "myr-v1.8.0",
        name: "Myrmidon CI (tag)",
        status: "queued",
        created_at: "2026-11-13T10:00:00Z",
        started_at: null,
      },
      {
        id: 2,
        head_branch: "main",
        name: "Myrmidon CI",
        status: "in_progress",
        created_at: "2026-11-13T10:05:00Z",
        started_at: "2026-11-13T10:05:30Z",
      },
    ];
    assert.deepEqual(observedPriorityViolations(runs), []);
  });

  it("does NOT flag a started release-stream PR as blocking a queued tag build", () => {
    const runs = [
      {
        id: 1,
        head_branch: "myr-v1.8.1",
        name: "Myrmidon CI (tag)",
        status: "queued",
        created_at: "2026-11-13T10:00:00Z",
        started_at: null,
      },
      {
        id: 2,
        head_branch: "bot/OPE-9999",
        name: "Myrmidon CI",
        event: "pull_request",
        display_title: "1.9 release: queue wiring (OPE-9999)",
        status: "in_progress",
        created_at: "2026-11-13T10:05:00Z",
        started_at: "2026-11-13T10:05:30Z",
      },
    ];
    assert.deepEqual(observedPriorityViolations(runs), []);
  });

  it("still flags a started ordinary PR run as blocking a queued tag build", () => {
    const runs = [
      {
        id: 1,
        head_branch: "myr-v1.8.0",
        name: "Myrmidon CI (tag)",
        status: "queued",
        created_at: "2026-11-13T10:00:00Z",
        started_at: null,
      },
      {
        id: 2,
        head_branch: "bot/OPE-13001",
        name: "Myrmidon CI",
        event: "pull_request",
        display_title: "1.8 RELEASE-STAGE: unrelated lanes (OPE-13001)",
        status: "in_progress",
        created_at: "2026-11-13T10:05:00Z",
        started_at: "2026-11-13T10:05:30Z",
      },
    ];
    const violations = observedPriorityViolations(runs);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].release, "myr-v1.8.0");
    assert.equal(violations[0].blockedBy, "bot/OPE-13001");
  });

  it("flags each blocked release run separately", () => {
    const runs = [
      {
        id: 1,
        head_branch: "myr-v1.8.0",
        name: "Myrmidon CI (tag)",
        status: "queued",
        created_at: "2026-11-13T10:00:00Z",
        started_at: null,
      },
      {
        id: 3,
        head_branch: "myr-v1.8.1-rc.1",
        name: "Myrmidon CI (tag)",
        status: "queued",
        created_at: "2026-11-13T10:01:00Z",
        started_at: null,
      },
      {
        id: 2,
        head_branch: "feature-x",
        name: "Myrmidon CI",
        status: "in_progress",
        created_at: "2026-11-13T10:06:00Z",
        started_at: "2026-11-13T10:07:00Z",
      },
    ];
    const violations = observedPriorityViolations(runs);
    assert.equal(violations.length, 2);
    assert.deepEqual(
      violations.map((v) => v.release).sort(),
      ["myr-v1.8.0", "myr-v1.8.1-rc.1"]
    );
  });
});

// ---------------------------------------------------------------------------
// gateState
// ---------------------------------------------------------------------------

describe("gateState", () => {
  const expected = ["typecheck", "build", "tests (x)", "checks"];

  it("is complete when every expected job succeeded", () => {
    const observed = [
      { name: "typecheck", conclusion: "success" },
      { name: "build", conclusion: "success" },
      { name: "tests (x)", conclusion: "success" },
      { name: "checks", conclusion: "success" },
    ];
    const st = gateState(expected, observed);
    assert.ok(st.complete);
    assert.deepEqual(st.missing, []);
    assert.deepEqual(st.failed, []);
    assert.deepEqual(st.foreign, []);
  });

  it("reports missing jobs for an incomplete build", () => {
    const observed = [
      { name: "typecheck", conclusion: "success" },
      { name: "build", conclusion: "success" },
    ];
    const st = gateState(expected, observed);
    assert.ok(!st.complete);
    assert.deepEqual(st.missing.sort(), ["checks", "tests (x)"]);
    assert.deepEqual(st.failed, []);
  });

  it("reports failed jobs (completed but not success)", () => {
    const observed = [
      { name: "typecheck", conclusion: "success" },
      { name: "build", conclusion: "failure" },
      { name: "tests (x)", conclusion: "success" },
      { name: "checks", conclusion: "cancelled" },
    ];
    const st = gateState(expected, observed);
    assert.ok(!st.complete);
    assert.deepEqual(st.missing, []);
    assert.deepEqual(st.failed.sort(), ["build", "checks"]);
  });

  it("flags foreign jobs and never counts them toward completeness", () => {
    const observed = [
      { name: "typecheck", conclusion: "success" },
      { name: "build", conclusion: "success" },
      { name: "tests (x)", conclusion: "success" },
      { name: "checks", conclusion: "success" },
      { name: "deploy-to-prod", conclusion: "success" }, // foreign
      { name: "someone-elses-job", conclusion: "failure" }, // foreign, failed
    ];
    const st = gateState(expected, observed);
    assert.ok(st.complete, "foreign jobs must not block the gate");
    assert.deepEqual(st.foreign.sort(), ["deploy-to-prod", "someone-elses-job"]);
  });

  it("an empty observed set means everything is missing", () => {
    const st = gateState(expected, []);
    assert.ok(!st.complete);
    assert.equal(st.missing.length, expected.length);
    assert.deepEqual(st.failed, []);
    assert.deepEqual(st.foreign, []);
  });

  it("an empty expected set is trivially complete", () => {
    const st = gateState([], [{ name: "anything", conclusion: "success" }]);
    assert.ok(st.complete);
    assert.deepEqual(st.missing, []);
    assert.deepEqual(st.failed, []);
    assert.deepEqual(st.foreign, ["anything"]);
  });

  it("a matrix shard observed with its expanded name satisfies the template job", () => {
    const expectedWithTemplate = ["typecheck", "tests (${{ matrix.label }})"];
    const observed = [
      { name: "typecheck", conclusion: "success" },
      { name: "tests (server 1/6)", conclusion: "success" },
      { name: "tests (serialized 3/5)", conclusion: "success" },
    ];
    const st = gateState(expectedWithTemplate, observed);
    assert.ok(st.complete);
    assert.deepEqual(st.missing, []);
    assert.deepEqual(st.failed, []);
    assert.deepEqual(st.foreign, []);
  });

  it("a matrix-like foreign name is still foreign when the template differs", () => {
    const expectedWithTemplate = ["typecheck", "tests (${{ matrix.label }})"];
    const observed = [
      { name: "typecheck", conclusion: "success" },
      { name: "tests (server 1/6)", conclusion: "success" },
      { name: "checks (server 1/6)", conclusion: "success" }, // foreign
    ];
    const st = gateState(expectedWithTemplate, observed);
    // One shard satisfies the template job; the foreign name is flagged.
    assert.ok(st.complete);
    assert.deepEqual(st.foreign, ["checks (server 1/6)"]);
  });

  it("a mixed build: some missing, some failed, some foreign — not complete", () => {
    const observed = [
      { name: "typecheck", conclusion: "success" },
      { name: "build", conclusion: "failure" },
      // tests (x) and checks missing entirely
      { name: "extra-1", conclusion: "success" }, // foreign
    ];
    const st = gateState(expected, observed);
    assert.ok(!st.complete);
    assert.deepEqual(st.missing.sort(), ["checks", "tests (x)"]);
    assert.deepEqual(st.failed, ["build"]);
    assert.deepEqual(st.foreign, ["extra-1"]);
  });
});

// ---------------------------------------------------------------------------
// extractJobGraph / gateDependencyJobs — the gate waits only for its own
// dependency closure (reviewer blocker on OPE-13002)
// ---------------------------------------------------------------------------

/** Workflow YAML with a dependency graph: gate needs [build, checks];
 *  checks needs [typecheck]; side-job is NOT in the gate's graph. */
const GRAPH_YAML = [
  "name: test",
  "on:",
  "  push:",
  "jobs:",
  "  typecheck:",
  "    name: typecheck",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - run: echo hi",
  "  build:",
  "    name: build",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - run: echo hi",
  "  checks:",
  "    name: checks",
  "    needs: [typecheck]",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - run: echo hi",
  "  side-job:",
  "    name: side analysis",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - run: echo hi",
  "  ci-result:",
  "    name: CI result",
  "    needs: [build, checks]",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - run: echo hi",
].join("\n");

describe("extractJobGraph", () => {
  it("parses ids, display names and inline needs", () => {
    const graph = extractJobGraph(GRAPH_YAML);
    assert.deepEqual(
      graph.map((j) => [j.id, j.name, j.needs]),
      [
        ["typecheck", "typecheck", []],
        ["build", "build", []],
        ["checks", "checks", ["typecheck"]],
        ["side-job", "side analysis", []],
        ["ci-result", "CI result", ["build", "checks"]],
      ]
    );
  });

  it("parses the YAML list form of needs", () => {
    const yaml = [
      "jobs:",
      "  a:",
      "    name: A",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: echo hi",
      "  b:",
      "    name: B",
      "    needs:",
      "      - a",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: echo hi",
      "  gate:",
      "    name: Gate",
      "    needs:",
      "      - b",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: echo hi",
    ].join("\n");
    const graph = extractJobGraph(yaml);
    assert.deepEqual(graph.find((j) => j.id === "b").needs, ["a"]);
    assert.deepEqual(graph.find((j) => j.id === "gate").needs, ["b"]);
  });

  it("reads the real myrmidon-ci-tag.yml graph", () => {
    const yaml = fs.readFileSync(TAG_WORKFLOW, "utf8");
    const graph = extractJobGraph(yaml);
    const gate = graph.find((j) => j.id === "ci-result");
    assert.ok(gate, "ci-result job exists");
    assert.deepEqual(gate.needs.sort(), [
      "build",
      "checks",
      "dockergate",
      "fleetd",
      "tests",
      "tests-other",
      "tests-runner",
      "typecheck",
    ]);
    // Build jobs have no needs of their own (flat graph).
    for (const id of gate.needs) {
      const job = graph.find((j) => j.id === id);
      assert.deepEqual(job.needs, [], `${id} has no needs`);
    }
  });
});

describe("gateDependencyJobs", () => {
  it("returns the gate's transitive dependency closure in file order", () => {
    const deps = gateDependencyJobs(GRAPH_YAML, "ci-result");
    assert.deepEqual(deps, ["typecheck", "build", "checks"]);
  });

  it("never includes a workflow job outside the gate's dependency graph", () => {
    // The reviewer blocker: an extra job in the workflow that the gate does
    // NOT need must not become mandatory. "side analysis" is absent here.
    const deps = gateDependencyJobs(GRAPH_YAML, "ci-result");
    assert.ok(!deps.includes("side analysis"));
    assert.ok(!deps.includes("CI result"));
  });

  it("returns an empty set when the gate job is absent (fail closed)", () => {
    assert.deepEqual(gateDependencyJobs(GRAPH_YAML, "no-such-gate"), []);
    assert.deepEqual(gateDependencyJobs("name: x\n", "ci-result"), []);
  });

  it("THROWS when the gate needs a job id that does not exist (fail closed)", () => {
    // Reviewer finding on OPE-13002: a typo in the gate's dependency list
    // must not silently yield a partial non-empty set — that would let the
    // gate pass while ignoring a declared dependency.
    const yaml = [
      "jobs:",
      "  build:",
      "    name: build",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: echo hi",
      "  ci-result:",
      "    name: CI result",
      "    needs: [build, typo-lane]",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: echo hi",
    ].join("\n");
    assert.throws(() => gateDependencyJobs(yaml, "ci-result"), /typo-lane/);
  });

  it("THROWS when a transitive dependency references an unknown job id", () => {
    const yaml = [
      "jobs:",
      "  checks:",
      "    name: checks",
      "    needs: [gone]",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: echo hi",
      "  ci-result:",
      "    name: CI result",
      "    needs: [checks]",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: echo hi",
    ].join("\n");
    assert.throws(() => gateDependencyJobs(yaml, "ci-result"), /gone/);
  });

  it("THROWS on a malformed inline needs entry instead of dropping it", () => {
    const yaml = [
      "jobs:",
      "  build:",
      "    name: build",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: echo hi",
      "  ci-result:",
      "    name: CI result",
      "    needs: [build, ${{ env.foo }}]",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: echo hi",
    ].join("\n");
    assert.throws(() => extractJobGraph(yaml), /unparseable needs entry/);
  });

  it("the real tag workflow closure equals the full tier the gate needs", () => {
    const yaml = fs.readFileSync(TAG_WORKFLOW, "utf8");
    const deps = gateDependencyJobs(yaml, "ci-result");
    assert.deepEqual(deps, [
      "typecheck",
      "build",
      "tests (${{ matrix.label }})",
      "tests (other packages)",
      "tests (runner)",
      "checks",
      "fleetd",
      "dockergate",
    ]);
  });

  // Behavioral coverage of the actual gate: a run whose observed jobs are
  // exactly the gate's dependency closure is complete even when the workflow
  // file declares an extra job that never ran in this build.
  it("an extra workflow job outside the gate graph does not block the gate", () => {
    const deps = gateDependencyJobs(GRAPH_YAML, "ci-result");
    const observed = [
      { name: "typecheck", conclusion: "success" },
      { name: "build", conclusion: "success" },
      { name: "checks", conclusion: "success" },
      // The side job never ran (or failed) — it is NOT a gate dependency.
    ];
    const st = gateState(deps, observed);
    assert.ok(st.complete, "gate must be complete without the side job");
    assert.deepEqual(st.missing, []);
    assert.deepEqual(st.failed, []);
  });

  it("a missing job IN the gate graph still blocks the gate", () => {
    const deps = gateDependencyJobs(GRAPH_YAML, "ci-result");
    const observed = [
      { name: "typecheck", conclusion: "success" },
      // build and checks missing
    ];
    const st = gateState(deps, observed);
    assert.ok(!st.complete);
    assert.deepEqual(st.missing.sort(), ["build", "checks"]);
  });

  it("the latency-gate step in the real workflow uses gateDependencyJobs", () => {
    const yaml = fs.readFileSync(TAG_WORKFLOW, "utf8");
    const step = yaml.split("Verify queue latency")[1] || "";
    assert.match(step, /gateDependencyJobs/);
    assert.doesNotMatch(step, /extractJobs, buildJobs/);
    assert.match(step, /gateDependencyJobs\(yaml, "ci-result"\)/);
  });
});
