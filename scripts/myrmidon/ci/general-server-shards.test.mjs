import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { defaultSuiteWeight, loadShardDurations, partitionGeneralServerSuites } from "../../general-server-shard.mjs";
import { averageRuns, buildManifest, mergeSuiteCosts, parseSuiteCosts } from "./shard-durations-from-logs.mjs";

// The general-server lane is split across a CI matrix. A shard that is missing
// from the matrix, listed twice, or computed from a different count than its
// siblings silently drops or duplicates suites, and an unbalanced split makes
// one job the whole run's critical path (3 shards: 20 / 26 / 36 min). This file
// lives under scripts/myrmidon so the `checks` job of both CI workflows runs it
// before pnpm install; it needs nothing but node stdlib.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const script = path.join(ROOT, "scripts", "run-vitest-stable.mjs");
const manifestPath = path.join(ROOT, "scripts", "general-server-shard-durations.json");
const workflows = [".github/workflows/myrmidon-ci.yml", ".github/workflows/myrmidon-ci-tag.yml"];
const execFileAsync = promisify(execFile);

async function dryRun(extraArgs) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [script, "--mode", "general", "--group", "general-server", ...extraArgs, "--dry-run"],
    { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

// Matrix entries are one-line flow mappings; parse them without a YAML library.
function serverShardsOf(workflow) {
  const text = readFileSync(path.join(ROOT, workflow), "utf8");
  return text
    .split("\n")
    .filter((line) => /^\s*- \{.*\bgroup:\s*general-server\s*[,}]/.test(line))
    .map((line) => ({
      label: /label:\s*"([^"]*)"/.exec(line)?.[1],
      index: Number(/shard_index:\s*(\d+)/.exec(line)?.[1]),
      count: Number(/shard_count:\s*(\d+)/.exec(line)?.[1]),
    }));
}

function totalWeight(files, durations) {
  const fallback = defaultSuiteWeight(durations);
  return files.reduce((sum, file) => sum + (durations[file] ?? fallback), 0);
}

describe("general-server shard matrix in the CI workflows", () => {
  for (const workflow of workflows) {
    it(`${workflow} declares every shard index exactly once`, () => {
      const shards = serverShardsOf(workflow);
      assert.ok(shards.length >= 2, "expected the general-server shards in the tests matrix");
      const count = shards[0].count;
      assert.equal(shards.length, count, "the number of matrix entries must equal shard_count");
      assert.deepEqual(
        shards.map((shard) => shard.index),
        Array.from({ length: count }, (_, index) => index),
        "shard_index must run 0..shard_count-1 without gaps or repeats",
      );
      for (const shard of shards) {
        assert.equal(shard.count, count, "every shard must use the same shard_count");
        assert.equal(shard.label, `server ${shard.index + 1}/${count}`, "label must match the shard it runs");
      }
    });
  }

  it("the main and tag workflows use the same shard count", () => {
    const counts = new Set(workflows.map((workflow) => serverShardsOf(workflow)[0].count));
    assert.equal(counts.size, 1, `workflows disagree on the shard count: ${[...counts].join(", ")}`);
  });
});

describe("general-server shards cover the lane exactly once", () => {
  const shardCount = serverShardsOf(workflows[0])[0].count;

  it(`the CLI shards 0..${shardCount - 1} of ${shardCount} together equal the unsharded lane`, async () => {
    const full = await dryRun(["--shard-index", "0", "--shard-count", "1"]);
    assert.ok(full.generalServerSuiteCount > 0, "expected a non-empty general-server suite set");
    assert.equal(full.selectedGeneralServerSuites.length, full.generalServerSuiteCount);

    const shards = await Promise.all(
      Array.from({ length: shardCount }, (_, index) =>
        dryRun(["--shard-index", String(index), "--shard-count", String(shardCount)]),
      ),
    );
    const selected = shards.flatMap((shard) => shard.selectedGeneralServerSuites);
    assert.equal(new Set(selected).size, selected.length, "a suite is assigned to more than one shard");
    assert.deepEqual(
      [...selected].sort(),
      [...full.selectedGeneralServerSuites].sort(),
      "the union of the shards must equal the full general-server suite set",
    );
    for (const [index, shard] of shards.entries()) {
      assert.ok(shard.selectedGeneralServerSuites.length > 0, `shard ${index + 1}/${shardCount} is empty`);
    }
  });

  it("any shard count from 1 to 12 partitions the suite set exactly", async () => {
    const full = (await dryRun(["--shard-index", "0", "--shard-count", "1"])).selectedGeneralServerSuites;
    const durations = loadShardDurations(manifestPath);
    for (let count = 1; count <= 12; count += 1) {
      const shards = partitionGeneralServerSuites(full, count, durations);
      assert.equal(shards.length, count);
      assert.deepEqual(
        shards.flatMap((shard) => shard.files).sort(),
        [...full].sort(),
        `${count} shards lose or duplicate suites`,
      );
    }
  });
});

describe("general-server shard balance", () => {
  const shardCount = serverShardsOf(workflows[0])[0].count;

  it("the checked-in manifest knows most of the current suites", async () => {
    const durations = loadShardDurations(manifestPath);
    const full = (await dryRun(["--shard-index", "0", "--shard-count", "1"])).selectedGeneralServerSuites;
    const known = full.filter((file) => durations[file] !== undefined).length;
    assert.ok(
      known / full.length >= 0.8,
      `shard duration manifest is stale: ${known} of ${full.length} suites have a recorded cost. Regenerate it with ` +
        "scripts/myrmidon/ci/shard-durations-from-logs.mjs from the logs of the last green main runs.",
    );
  });

  it("the shards of the CI matrix have near-equal recorded cost", async () => {
    const durations = loadShardDurations(manifestPath);
    const full = (await dryRun(["--shard-index", "0", "--shard-count", "1"])).selectedGeneralServerSuites;
    const totals = partitionGeneralServerSuites(full, shardCount, durations).map((shard) =>
      totalWeight(shard.files, durations),
    );
    const skew = Math.max(...totals) / Math.min(...totals);
    assert.ok(skew <= 1.1, `slowest/fastest shard cost ratio ${skew.toFixed(2)} exceeds 1.1: ${totals.join(", ")} ms`);
  });
});

describe("shard-durations-from-logs", () => {
  const ESC = "\u001b";
  const log = [
    "2026-10-30T11:31:20.0000000Z [test:run] general-server shard 1/6 running 3 of 3 suites",
    `2026-10-30T11:31:30.5000000Z ${ESC}[1m${ESC}[30m${ESC}[46m RUN ${ESC}[49m${ESC}[39m${ESC}[22m v4.1.11 /home/runner/work`,
    `2026-10-30T11:31:35.5000000Z  ${ESC}[32m✓${ESC}[39m  @myrmidon/server  src/a.test.ts (3 tests) ${ESC}[33m120ms${ESC}[39m\r`,
    "2026-10-30T11:31:36.0000000Z      ✓ a nested test case 12ms",
    "2026-10-30T11:31:40.5000000Z  ↓  @myrmidon/server  src/b.test.ts (2 tests | 2 skipped)",
    "2026-10-30T11:31:40.6000000Z  ❯  @myrmidon/server  scripts/c.test.mjs (1 test | 1 failed) 5ms",
    "2026-10-30T11:31:41.0000000Z  ✓  @myrmidon/ui  src/other-project.test.ts (1 test) 5ms",
  ].join("\n");

  it("costs a suite as the gap to the previous completion line, import time included", () => {
    assert.deepEqual(
      parseSuiteCosts(log).map(({ file, costMs }) => [file, costMs]),
      [
        ["server/src/a.test.ts", 5000],
        ["server/src/b.test.ts", 5000],
        ["server/scripts/c.test.mjs", 100],
      ],
    );
  });

  it("refuses a log without suite lines", () => {
    assert.throws(() => parseSuiteCosts("2026-10-30T11:31:30.0000000Z nothing here"), /no vitest suite completion lines/);
  });

  it("refuses the same suite in two logs of one run and averages across runs", () => {
    const suites = parseSuiteCosts(log);
    assert.throws(() => mergeSuiteCosts([suites, suites]), /more than one log/);
    assert.deepEqual(
      averageRuns([{ a: 1000, b: 500 }, { a: 3000 }, { a: 2000, c: 7 }]),
      { a: 2000, b: 500, c: 7 },
    );
  });

  it("writes a sorted manifest that the shard loader reads back", () => {
    const manifest = buildManifest({ "server/src/z.test.ts": 9, "server/src/a.test.ts": 4 }, "synthetic");
    assert.deepEqual(Object.keys(manifest.durations), ["server/src/a.test.ts", "server/src/z.test.ts"]);
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "shard-durations-")), "manifest.json");
    writeFileSync(file, JSON.stringify(manifest));
    assert.deepEqual(loadShardDurations(file), { "server/src/a.test.ts": 4, "server/src/z.test.ts": 9 });
  });
});
