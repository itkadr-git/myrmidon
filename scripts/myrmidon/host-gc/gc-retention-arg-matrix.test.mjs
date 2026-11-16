import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { runCopyTtlError, npmCacheTtlError, runnerTmpTtlError } from "./host-clone-cache-gc.mjs";

const guards = [
  ["run copy", runCopyTtlError, 3],
  ["npm cache", npmCacheTtlError, 1],
  ["runner tmp", runnerTmpTtlError, 3],
];

describe("retention TTL guards", () => {
  for (const [name, guard, minimum] of guards) {
    for (const [label, value] of [["string", "3"], ["null", null], ["NaN", NaN], ["positive infinity", Infinity], ["negative infinity", -Infinity], ["below minimum", minimum - 0.01]]) {
      it(`${name} rejects ${label}`, () => assert.equal(typeof guard(value), "string"));
    }
    for (const [label, value] of [["minimum", minimum], ["fraction", minimum + 0.25], ["above minimum", minimum + 10]]) {
      it(`${name} accepts ${label}`, () => assert.equal(guard(value), null));
    }
  }
});

it("parseArgs isolates env defaults, preserves order, and validates TTLs", () => {
  const base = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || os.homedir();
  const dir = fs.mkdtempSync(path.join(base, "gc-arg-matrix-"));
  try {
    const fixture = path.join(dir, "fixture.env");
    fs.writeFileSync(fixture, "SCRATCH_TTL_HOURS=9\nMYRMIDON_HOST_GC_NPM_CACHE_TTL_HOURS=2\nHOST_GC_RUNNER_ROOTS=env-one:env-two\n");
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/HOST_GC|SCRATCH.*TTL|TTL.*SCRATCH/.test(key)));
    env.TMPDIR = dir;
    const script = `
      import assert from 'node:assert/strict';
      import { parseArgs, UsageError } from './scripts/myrmidon/host-gc/host-clone-cache-gc.mjs';
      const fixture = process.argv[1];
      const parse = (...args) => parseArgs(['node', 'test', '--env', fixture, ...args]);
      const defaults = parse();
      assert.equal(defaults.scratchTtlHours, 9);
      assert.equal(defaults.npmCacheTtlHours, 2);
      assert.deepEqual(defaults.runnerRoots, ['env-one', 'env-two']);
      const a = parse('--scratch-ttl', '11', '--npm-cache-ttl', '1.5', '--run-copy-ttl', '3.5', '--runner-tmp-ttl', '4.5', '--runner-root', 'one', '--runner-root', 'two', '--scratch-root', 'first', '--scratch-root', 'second', '--apply', '--dry-run');
      assert.equal(a.scratchTtlHours, 11);
      assert.equal(a.npmCacheTtlHours, 1.5);
      assert.equal(a.runCopyTtlHours, 3.5);
      assert.equal(a.runnerTmpTtlHours, 4.5);
      assert.deepEqual(a.runnerRoots, ['env-one', 'env-two', 'one', 'two']);
      assert.deepEqual(a.scratchRoots, ['first', 'second']);
      assert.equal(a.dryRun, true);
      assert.equal(parse('--dry-run', '--apply').dryRun, false);
      for (const [flag, values] of [['--run-copy-ttl', ['2.99', 'NaN', 'Infinity']], ['--npm-cache-ttl', ['0.99', 'NaN', 'Infinity']], ['--runner-tmp-ttl', ['2.99', 'NaN', 'Infinity']]]) {
        for (const value of values) assert.throws(() => parse(flag, value), UsageError);
      }
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, fixture], { cwd: path.resolve(new URL("../../..", import.meta.url).pathname), env, encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr || String(child.error));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
