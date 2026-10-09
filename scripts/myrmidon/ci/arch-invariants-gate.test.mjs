import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// ARCH-GUARD (OPE-6856): self-test of the invariants gate. Each invariant
// (INV-10..INV-13) has a RED side: a sandboxed repo snapshot in which the
// invariant is violated and the gate MUST fail. The green side is the real
// checkout (checked once per suite run through the sandbox copy of a clean
// main — here: a synthetic minimal-clean snapshot passes).

import {
  check,
  checkWakeTaskBinding,
  checkSingleQueueOrder,
  checkNoPilot,
  checkMigrations,
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
  numbers: [1, 2, 3],
};

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
});

describe("INV-11: one swarm queue order", () => {
  it("RED: a second .sort() of queue candidates fails", () => {
    const dir = sandbox({
      "server/src/myrmidon/swarm-claim/queue2.ts": `const ordered = candidates.sort((a, b) => a.weight - b.weight);\n`,
    });
    const findings = checkSingleQueueOrder(dir);
    assert.equal(findings.length, 1);
    assert.match(findings[0], /INV-11/);
  });

  it("the shared helper's own sort is the single implementation", () => {
    const dir = sandbox({
      "packages/shared/src/myrmidon-swarm-claim.ts": `return [...candidates].sort(cmp);\n`,
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

  it("a baseline file grandfathers its recorded gaps", () => {
    // Sandbox with the same numbering as the real repo baseline (0001..0003
    // present, gap 0002 recorded) — write a baseline into the sandbox? The
    // gate reads the baseline next to the script, so grandfathering is proven
    // by the real repo: numbers 0..310 with historic gaps pass the check.
    const repoRoot = path.resolve(HERE, "../../..");
    assert.deepEqual(checkMigrations(repoRoot), []);
  });
});

describe("gate end-to-end", () => {
  it("RED: a violated repo exits 1 with the invariant named", () => {
    const dir = sandbox({
      "server/src/myrmidon/swarm-claim/settings.ts": `export const swarm = { pilot: true } as const;\n`,
    });
    const run = spawnSync(process.execPath, [SCRIPT, "--root", dir], { encoding: "utf8" });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /INV-12/);
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
