import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("./affected-tests.mjs", import.meta.url));
const scratch = process.env.MYRMIDON_RUN_SCRATCH_DIR || process.env.PAPERCLIP_RUN_SCRATCH_DIR || path.join(os.homedir(), ".myrmidon-scratch");

function fixture(t) {
  fs.mkdirSync(scratch, { recursive: true });
  const dir = fs.mkdtempSync(path.join(scratch, "affected-plan-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, out: path.join(dir, "plan.json"), output: path.join(dir, "github-output") };
}

function run(args, f) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: f.dir,
    env: { GITHUB_OUTPUT: f.output },
    encoding: "utf8",
  });
}

function expected(tier, reason) {
  return { tier, reasons: [reason] };
}

for (const [name, args] of [["without base", []], ["force-full without base", ["--force-full"]]]) {
  test(`plan ${name} selects full`, (t) => {
    const f = fixture(t);
    const result = run(["plan", ...args, "--out", f.out], f);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.out, "utf8")), expected("full", "no base commit (push or manual run)"));
    assert.equal(fs.readFileSync(f.output, "utf8"), "tier=full\n");
    assert.match(result.stdout, /tier: full \(no base commit \(push or manual run\)\)/);
  });
}

for (const tier of ["docs", "fast", "full"]) {
  test(`explicit ${tier} writes exact plan JSON`, (t) => {
    const f = fixture(t);
    const result = run(["plan", "--tier", tier, "--out", f.out], f);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(f.out, "utf8"), JSON.stringify(expected(tier, `explicit tier override: ${tier}`), null, 2));
  });
  test(`explicit ${tier} reports exact GitHub output`, (t) => {
    const f = fixture(t);
    const result = run(["plan", "--tier", tier], f);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(f.output, "utf8"), `tier=${tier}\n`);
    assert.equal(result.stdout, `[affected-tests] tier: ${tier} (explicit tier override: ${tier})\n`);
  });
}

test("repeat plan appends output and replaces JSON", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.out, "stale content that must disappear");
  fs.writeFileSync(f.output, "existing=value\n");
  assert.equal(run(["plan", "--tier", "docs", "--out", f.out], f).status, 0);
  assert.equal(run(["plan", "--tier", "fast", "--out", f.out], f).status, 0);
  assert.equal(fs.readFileSync(f.output, "utf8"), "existing=value\ntier=docs\ntier=fast\n");
  assert.equal(fs.readFileSync(f.out, "utf8"), JSON.stringify(expected("fast", "explicit tier override: fast"), null, 2));
});

test("unknown command exits 2 with usage on stderr", (t) => {
  const f = fixture(t);
  const result = run(["unknown"], f);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "usage: affected-tests.mjs plan|run|extra ...\n");
  assert.equal(fs.existsSync(f.output), false);
});

test("missing command exits 2 with usage", (t) => {
  const f = fixture(t);
  const result = run([], f);
  assert.equal(result.status, 2);
  assert.equal(result.stderr, "usage: affected-tests.mjs plan|run|extra ...\n");
});

test("unknown plan argument fails with diagnostic", (t) => {
  const f = fixture(t);
  const result = run(["plan", "--not-a-real-option", "--out", f.out], f);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown argument --not-a-real-option/);
  assert.equal(fs.existsSync(f.out), false);
  assert.equal(fs.existsSync(f.output), false);
});

test("explicit tier takes precedence over force-full without base", (t) => {
  const f = fixture(t);
  const result = run(["plan", "--force-full", "--tier", "docs", "--out", f.out], f);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.out, "utf8")), expected("docs", "explicit tier override: docs"));
  assert.equal(fs.readFileSync(f.output, "utf8"), "tier=docs\n");
});
