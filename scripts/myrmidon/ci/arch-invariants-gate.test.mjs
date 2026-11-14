import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// ARCH-GUARD: self-test of the invariants gate. Each invariant
// (INV-10..INV-15) has a RED side: a sandboxed repo snapshot in which the
// invariant is violated and the gate MUST fail. The green side is the real
// checkout (checked once per suite run through the sandbox copy of a clean
// main — here: a synthetic minimal-clean snapshot passes).

import {
  check,
  checkWakeTaskBinding,
  checkSingleQueueOrder,
  checkNoPilot,
  checkMigrations,
  checkDecisionLayerPurity,
  checkEffectWorkerNoSleep,
  TEST_HOOKS,
} from "./arch-invariants-gate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "arch-invariants-gate.mjs");

/** A sandbox repo skeleton the gate can scan. */
function sandbox(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arch-invariants-"));
  for (const [rel, text] of Object.entries(files)) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
  return dir;
}

function migrationsFs(journalTags, sqlFiles) {
  const files = {};
  const dir = "packages/db/src/migrations";
  const meta = `${dir}/meta/_journal.json`;
  for (const f of sqlFiles) files[`${dir}/${f}`] = "-- migration\n";
  files[meta] = JSON.stringify({
    entries: journalTags.map((tag) => ({ tag })),
  });
  return files;
}

const BASELINE = {
  numbers: [1, 3, 4],
};

describe("INV-14: decision layer has no I/O imports", () => {
  it("clean decision module passes", () => {
    const dir = sandbox({
      "server/src/modules/run-dispatch/domain/decision.ts":
        "export function decide(input: { ready: boolean }) { return input.ready ? { action: \"run\" } : { action: \"wait\" }; }\n",
    });
    assert.deepEqual(checkDecisionLayerPurity(dir), []);
  });

  it("RED: database and adapter imports fail", () => {
    const dir = sandbox({
      "server/src/modules/run-dispatch/domain/decision.ts":
        'import { db } from "@myrmidon/db";\nimport { save } from "../adapters/postgres.js";\nexport const decide = () => ({ db, save });\n',
    });
    const findings = checkDecisionLayerPurity(dir);
    assert.equal(findings.length, 2);
    assert.match(findings[0], /INV-14/);
    assert.match(findings[1], /INV-14/);
  });
});

describe("INV-10: no automatic wake without a task", () => {
  it("clean call sites pass", () => {
    const dir = sandbox({
      "server/src/services/ok.ts": `await enqueueWakeup(agent.id, {
  source: "automation",
  reason: "issue_monitor",
  payload: { issueId: issue.id },
});\n`,
    });
    assert.deepEqual(checkWakeTaskBinding(dir), []);
  });

  it("task binding inside contextSnapshot passes", () => {
    const dir = sandbox({
      "server/src/services/ok.ts": `await enqueueWakeup(agent.id, {
  source: "automation",
  contextSnapshot: { issueId: task.id },
});\n`,
    });
    assert.deepEqual(checkWakeTaskBinding(dir), []);
  });

  it("RED: nested contextSnapshot without a task fails", () => {
    const dir = sandbox({
      "server/src/services/bad.ts": `await enqueueWakeup(agent.id, {
  source: "automation",
  contextSnapshot: { issueId: undefined },
});\n`,
    });
    assert.match(checkWakeTaskBinding(dir)[0], /INV-10/);
  });

  it("RED: taskless automation wake fails", () => {
    const dir = sandbox({
      "server/src/services/bad.ts": `await enqueueWakeup(agent.id, {
  source: "automation",
  reason: "just_checking",
});\n`,
    });
    const findings = checkWakeTaskBinding(dir);
    assert.equal(findings.length, 1);
    assert.match(findings[0], /INV-10/);
  });

  it("manual (on_demand) wakes and the scheduler tick are allowed", () => {
    const dir = sandbox({
      "server/src/services/manual.ts": `enqueueWakeup(agent.id, { source: "on_demand", reason: "user" });\n`,
      "server/src/services/tick.ts": `enqueueWakeup(agent.id, { source: "timer", reason: "heartbeat_timer" });\n`,
    });
    assert.deepEqual(checkWakeTaskBinding(dir), []);
  });

  it("RED: timer source without scheduler reason needs task context", () => {
    const dir = sandbox({ "server/src/services/bad.ts": `enqueueWakeup(agent.id, { source: "timer", reason: "just_checking" });\n` });
    assert.match(checkWakeTaskBinding(dir)[0], /INV-10/);
  });

  it("pure pass-through wrapper (id, opts) => enqueueWakeup(id, opts) is allowed", () => {
    const dir = sandbox({
      "server/src/services/wrap.ts": `const deps = {
  enqueueWakeup: (nextAgentId, wakeOptions) =>
    enqueueWakeup(nextAgentId, wakeOptions),
};\n`,
    });
    assert.deepEqual(checkWakeTaskBinding(dir), []);
  });

  it("RED: wrapper that does not forward its own options fails", () => {
    const dir = sandbox({
      "server/src/services/wrap.ts": `const deps = {
  enqueueWakeup: (nextAgentId, wakeOptions) =>
    enqueueWakeup(nextAgentId, otherOptions),
};\n`,
    });
    assert.match(checkWakeTaskBinding(dir)[0], /INV-10/);
  });

  it("RED: undefined issueId does not satisfy task binding", () => {
    const dir = sandbox({ "server/src/services/bad.ts": `enqueueWakeup(agent.id, { source: "automation", payload: { issueId: undefined } });\n` });
    const findings = checkWakeTaskBinding(dir);
    assert.equal(findings.length, 1);
    assert.match(findings[0], /INV-10/);
  });
});

describe("INV-11: one swarm queue order", () => {
  it("RED: a variable payload/contextSnapshot without a verified producer fails", () => {
    const dir = sandbox({
      "server/src/services/bad.ts": `await enqueueWakeup(agent.id, {
  source: "automation",
  reason: "sneaky",
  payload: somePayload,
  contextSnapshot: ctx,
});\n`,
    });
    assert.match(checkWakeTaskBinding(dir)[0], /INV-10/);
  });

  it("RED: spreading an unknown contextSnapshot without a verified producer fails", () => {
    const dir = sandbox({
      "server/src/services/bad.ts": `await enqueueWakeup(agent.id, {
  source: "automation",
  contextSnapshot: { ...decision.contextSnapshot, parentRunId: run.id },
});\n`,
    });
    assert.match(checkWakeTaskBinding(dir)[0], /INV-10/);
  });

  it("a registered variable wake passes only while its producer still carries issueId", () => {
    const call = `await enqueueWakeup(agent.id, {
  source: "automation",
  reason: ISSUE_REVIEW_PATH_LOST_WAKE_REASON,
  payload: decision.payload,
  contextSnapshot: decision.contextSnapshot,
});\n`;
    const good = sandbox({
      "server/src/services/heartbeat.ts": call,
      "server/src/services/recovery/review-path-recovery.ts": `const payload = withRecoveryContext({\n    issueId: input.issueId,\n  }, "normal_model");\n`,
    });
    assert.deepEqual(checkWakeTaskBinding(good), []);
    const broken = sandbox({
      "server/src/services/heartbeat.ts": call,
      "server/src/services/recovery/review-path-recovery.ts": `const payload = withRecoveryContext({\n    reviewPathLost: true,\n  }, "normal_model");\n`,
    });
    assert.match(checkWakeTaskBinding(broken)[0], /INV-10/);
  });

  it("shorthand issueId inside the contextSnapshot literal passes", () => {
    const dir = sandbox({
      "server/src/services/ok.ts": `await enqueueWakeup(agent.id, {
  source: "on_demand_like",
  contextSnapshot: response ? { ...parse(x), issueId, triggeredBy: "board" } : { issueId },
});\n`,
    });
    assert.deepEqual(checkWakeTaskBinding(dir), []);
  });

  it("RED: a second .sort() of queue candidates fails", () => {
    const dir = sandbox({
      "server/src/myrmidon/swarm-claim/queue2.ts": `const ordered = candidates.sort((a, b) => a.weight - b.weight);\n`,
    });
    const findings = checkSingleQueueOrder(dir);
    assert.equal(findings.length, 1);
    assert.match(findings[0], /INV-11/);
  });

  it("RED: a nested second queue sort fails", () => {
    const dir = sandbox({ "server/src/myrmidon/swarm-claim/nested/order.ts": `const ordered = candidates.sort((a, b) => a.weight - b.weight);\n` });
    assert.match(checkSingleQueueOrder(dir)[0], /INV-11/);
  });

  it("the role-name sort in matcher.ts is exempt by content, regardless of its line number", () => {
    const body = `const roles = [
  ...new Set(
    agentRows
      .map((agent) => agent.role),
  ),
]
  .filter((role) => !wanted || wanted.has(role))
  .sort();\n`;
    const shifted = "// padding\n".repeat(2000) + body;
    const dir = sandbox({ "server/src/myrmidon/swarm-claim/matcher.ts": body, "server/src/myrmidon/swarm-claim/matcher2.ts": "x" });
    assert.deepEqual(checkSingleQueueOrder(dir), []);
    const dir2 = sandbox({ "server/src/myrmidon/swarm-claim/matcher.ts": shifted });
    assert.deepEqual(checkSingleQueueOrder(dir2), []);
  });

  it("RED: a comparator sort in matcher.ts is not exempt", () => {
    const dir = sandbox({ "server/src/myrmidon/swarm-claim/matcher.ts": `const x = rows.map((agent) => agent.role)\n  .sort((a, b) => a.weight - b.weight);\n` });
    assert.match(checkSingleQueueOrder(dir)[0], /INV-11/);
  });

  it("the shared helper's own sort is the single implementation", () => {
    const dir = sandbox({
      "packages/shared/src/myrmidon-swarm-claim.ts": `export function orderSwarmQueueCandidates(candidates) { return [...candidates].sort(cmp); }\n`,
    });
    assert.deepEqual(checkSingleQueueOrder(dir), []);
  });
});

describe("INV-12: no pilot in swarm code", () => {
  it("RED: pilot token in code fails", () => {
    const dir = sandbox({
      "server/src/myrmidon/swarm-claim/settings.ts": `export const swarm = { pilot: true } as const;\n`,
    });
    const findings = checkNoPilot(dir);
    assert.equal(findings.length, 1);
    assert.match(findings[0], /INV-12/);
  });

  it("RED: camelCase and underscored pilot fields fail", () => {
    const dir = sandbox({ "server/src/myrmidon/swarm-claim/settings.ts": `export const settings = { pilotEnabled: true, pilot_percent: 10 };\n` });
    assert.equal(checkNoPilot(dir).length, 1);
  });

  it("comments mentioning the old pilot are grandfathered", () => {
    const dir = sandbox({
      "server/src/myrmidon/swarm-claim/settings.ts": `// 1.6.1: the pilot set is gone; comments stay for history.\nexport const enabled = false;\n`,
    });
    assert.deepEqual(checkNoPilot(dir), []);
  });
});

describe("INV-13: migration numbering", () => {
  it("clean sequence passes (files and journal agree)", () => {
    TEST_HOOKS.migrationBaselineOverride = "none";
    try {
      const dir = sandbox(migrationsFs(["0001_a", "0002_b", "0003_c"], ["0001_a.sql", "0002_b.sql", "0003_c.sql"]));
      assert.deepEqual(checkMigrations(dir), []);
    } finally {
      TEST_HOOKS.migrationBaselineOverride = null;
    }
  });

  it("RED: duplicate migration number fails", () => {
    TEST_HOOKS.migrationBaselineOverride = "none";
    try {
      const dir = sandbox(
        migrationsFs(["0001_a", "0002_b1", "0002_b2"], ["0001_a.sql", "0002_b1.sql", "0002_b2.sql"]),
      );
      const findings = checkMigrations(dir);
      assert.ok(findings.some((f) => /duplicate migration number 0002/.test(f)));
    } finally {
      TEST_HOOKS.migrationBaselineOverride = null;
    }
  });

  it("RED: duplicate journal idx fails", () => {
    TEST_HOOKS.migrationBaselineOverride = "none";
    try {
      const files = {};
      const dir = "packages/db/src/migrations";
      files[`${dir}/0401_a.sql`] = "-- migration\n";
      files[`${dir}/0402_b.sql`] = "-- migration\n";
      files[`${dir}/meta/_journal.json`] = JSON.stringify({
        entries: [
          { idx: 401, tag: "0401_a" },
          { idx: 401, tag: "0402_b" },
        ],
      });
      const dirSandbox = sandbox(files);
      const findings = checkMigrations(dirSandbox);
      assert.ok(findings.some((f) => /duplicate journal idx 401/.test(f)));
    } finally {
      TEST_HOOKS.migrationBaselineOverride = null;
    }
  });

  it("RED: mismatched journal idx and tag fails", () => {
    TEST_HOOKS.migrationBaselineOverride = "none";
    try {
      const files = {};
      const dir = "packages/db/src/migrations";
      files[`${dir}/0401_a.sql`] = "-- migration\n";
      files[`${dir}/0402_b.sql`] = "-- migration\n";
      files[`${dir}/meta/_journal.json`] = JSON.stringify({
        entries: [
          { idx: 401, tag: "0401_a" },
          { idx: 405, tag: "0402_b" },
        ],
      });
      const dirSandbox = sandbox(files);
      const findings = checkMigrations(dirSandbox);
      assert.ok(findings.some((f) => /idx 405 does not match tag 0402_b/.test(f)));
    } finally {
      TEST_HOOKS.migrationBaselineOverride = null;
    }
  });

  it("RED: journal/file mismatch fails", () => {
    TEST_HOOKS.migrationBaselineOverride = "none";
    try {
      const dir = sandbox(
        migrationsFs(["0001_a", "0002_b"], ["0001_a.sql", "0002_b.sql", "0003_c.sql"]),
      );
      const findings = checkMigrations(dir);
      assert.ok(findings.some((f) => /count mismatch/.test(f)));
    } finally {
      TEST_HOOKS.migrationBaselineOverride = null;
    }
  });

  it("historic gaps without a baseline file are reported", () => {
    TEST_HOOKS.migrationBaselineOverride = "none";
    try {
      const dir = sandbox(
        migrationsFs(["0001_a", "0003_c"], ["0001_a.sql", "0003_c.sql"]),
      );
      const findings = checkMigrations(dir);
      assert.ok(findings.some((f) => /gap between 0001 and 0003/.test(f)));
    } finally {
      TEST_HOOKS.migrationBaselineOverride = null;
    }
  });

  it("reports a named new gap even when later migration files exist", () => {
    const dir = sandbox(migrationsFs(["0003_c", "0005_e"], ["0003_c.sql", "0005_e.sql"]));
    const baseline = path.join(dir, "baseline.json");
    fs.writeFileSync(baseline, JSON.stringify({ numbers: [3, 5], enforceGapsFrom: 4 }));
    const previous = TEST_HOOKS.migrationBaselineOverride;
    TEST_HOOKS.migrationBaselineOverride = baseline;
    try {
      assert.ok(checkMigrations(dir).some((f) => /new gap at migration number 0004/.test(f)));
    } finally { TEST_HOOKS.migrationBaselineOverride = previous; }
  });
  it("a baseline file grandfathers its recorded gaps", () => {
    const repoRoot = path.resolve(HERE, "../../..");
    assert.deepEqual(checkMigrations(repoRoot), []);
  });

  it("RED: a new gap above the baseline fails", () => {
    const dir = sandbox(migrationsFs(
      ["0001_a", "0003_c", "0004_d", "0006_f"],
      ["0001_a.sql", "0003_c.sql", "0004_d.sql", "0006_f.sql"],
    ));
    const baseline = path.join(dir, "baseline.json");
    fs.writeFileSync(baseline, JSON.stringify({ numbers: [1, 3, 4], enforceGapsFrom: 5 }));
    const previous = TEST_HOOKS.migrationBaselineOverride;
    TEST_HOOKS.migrationBaselineOverride = baseline;
    try {
      assert.ok(checkMigrations(dir).some((f) => /new gap at migration number 0005/.test(f)));
    } finally {
      TEST_HOOKS.migrationBaselineOverride = previous;
    }
  });
});

describe("INV-15: effect-worker tests do not sleep", () => {
  it("passes a clean effect-worker test directory", () => {
    const dir = sandbox({
      "server/src/myrmidon/effect-worker/effect-worker.myrmidon.test.ts": `import { drainEffects } from "./test-helpers.js";\nawait drainEffects(worker);\n`,
    });
    assert.deepEqual(checkEffectWorkerNoSleep(dir), []);
  });

  it("RED: flags setTimeout in an effect-worker test", () => {
    const dir = sandbox({
      "server/src/myrmidon/effect-worker/effect-worker.myrmidon.test.ts": `await new Promise((r) => setTimeout(r, 100));\n`,
    });
    const findings = checkEffectWorkerNoSleep(dir);
    assert.ok(findings.length > 0);
    assert.match(findings[0], /INV-15/);
  });

  it("RED: flags sleep() in an effect-worker test", () => {
    const dir = sandbox({
      "server/src/myrmidon/effect-worker/effect-worker.myrmidon.test.ts": `await sleep(100);\n`,
    });
    const findings = checkEffectWorkerNoSleep(dir);
    assert.ok(findings.length > 0);
    assert.match(findings[0], /INV-15/);
  });

  it("ignores setImmediate inside test-helpers.ts", () => {
    const dir = sandbox({
      "server/src/myrmidon/effect-worker/test-helpers.ts": `await new Promise((r) => setImmediate(r));\n`,
      "server/src/myrmidon/effect-worker/effect-worker.myrmidon.test.ts": `import { drainEffects } from "./test-helpers.js";\nawait drainEffects(worker);\n`,
    });
    assert.deepEqual(checkEffectWorkerNoSleep(dir), []);
  });

  it("RED: flags setTimeout in a nested effect-worker test file", () => {
    const dir = sandbox({
      "server/src/myrmidon/effect-worker/nested/deep.myrmidon.test.ts": `await new Promise((r) => setTimeout(r, 100));\n`,
    });
    const findings = checkEffectWorkerNoSleep(dir);
    assert.ok(findings.length > 0);
    assert.match(findings[0], /INV-15/);
    assert.match(findings[0], /nested/);
  });

  it("no findings when the effect-worker directory does not exist", () => {
    const dir = sandbox({});
    assert.deepEqual(checkEffectWorkerNoSleep(dir), []);
  });
});

describe("gate end-to-end", () => {
  it("RED: a violated repo exits 1 with the invariant named", () => {
    const dir = sandbox({
      "server/src/myrmidon/swarm-claim/settings.ts": `export const swarm = { pilot: true } as const;\n`,
      "packages/shared/src/myrmidon-swarm-claim.ts": "export function orderSwarmQueueCandidates(candidates) { return candidates; }\n",
      "packages/db/src/migrations/0001_init.sql": "-- migration\n",
      "packages/db/src/migrations/0002_next.sql": "-- migration\n",
      "packages/db/src/migrations/0004_future.sql": "-- migration\n",
      "packages/db/src/migrations/meta/_journal.json": JSON.stringify({ entries: [{ tag: "0001_init" }, { tag: "0002_next" }, { tag: "0004_future" }] }),
    });
    const run = spawnSync(process.execPath, [SCRIPT, "--root", dir], { encoding: "utf8" });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /INV-12/);
    assert.match(run.stderr, /INV-13/);
  });

  it("RED: a repo with sleeping effect-worker tests exits 1 with INV-15 named", () => {
    const dir = sandbox({
      "server/src/myrmidon/effect-worker/effect-worker.myrmidon.test.ts": `await new Promise((r) => setTimeout(r, 100));\n`,
      "server/src/myrmidon/swarm-claim/settings.ts": `export const swarm = {} as const;\n`,
      "packages/shared/src/myrmidon-swarm-claim.ts": "export function orderSwarmQueueCandidates(candidates) { return candidates; }\n",
      "packages/db/src/migrations/0001_init.sql": "-- migration\n",
      "packages/db/src/migrations/meta/_journal.json": JSON.stringify({ entries: [{ tag: "0001_init" }] }),
    });
    const run = spawnSync(process.execPath, [SCRIPT, "--root", dir], { encoding: "utf8" });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /INV-15/);
  });

  it("usage error exits 2", () => {
    const run = spawnSync(process.execPath, [SCRIPT, "--wat"], { encoding: "utf8" });
    assert.equal(run.status, 2);
  });

  it("the real repository passes every invariant (green side)", () => {
    const repoRoot = path.resolve(HERE, "../../..");
    const { findings } = check(repoRoot);
    assert.deepEqual(findings, []);
  });
});
