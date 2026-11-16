import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkDocument, makeReader } from "../../check-acceptance-scenarios.mjs";

const script = fileURLToPath(new URL("../../check-acceptance-scenarios.mjs", import.meta.url));
const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || path.join(os.homedir(), "cache", "scratch");

function fixture(t) {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(path.join(scratch, "acceptance-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, "exists.test.mjs"), "test('exists', () => {});\n");
  const scenario = (id, refs = ["exists.test.mjs"]) => ({
    id, title: `Scenario ${id}`, falsifiedWhen: "The result is incorrect", testRefs: refs,
  });
  const doc = { version: 1, scenarios: [scenario("one")] };
  const other = { version: 1, scenarios: [scenario("two"), scenario("three", [])] };
  writeFileSync(path.join(root, "valid.json"), JSON.stringify(doc));
  writeFileSync(path.join(root, "other.json"), JSON.stringify(other));
  writeFileSync(path.join(root, "broken.json"), "{broken");
  writeFileSync(path.join(root, "missing-ref.json"), JSON.stringify({ version: 1, scenarios: [scenario("missing", ["absent.test.mjs"])] }));
  return { root, doc };
}

function run(root, args, input) {
  const result = spawnSync(process.execPath, [script, "--repo-root", root, ...args], { encoding: "utf8", input });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function summary(documents, scenarios, refs, problems) {
  return `check-acceptance-scenarios summary\n  Documents checked:  ${documents}\n  Scenarios checked:  ${scenarios}\n  Test refs resolved: ${refs}\n  Tree mode:          working tree\n  Problems:           ${problems}\n`;
}

const usage = "Usage: node scripts/check-acceptance-scenarios.mjs <document.json> [...] [--ref <git-ref>] [--repo-root <path>]\n  Validates acceptance-scenarios documents (PLAN-COVERAGE-B format) and checks that\n  every testRef points at a test existing in the selected tree. --ref reads files\n  from that git ref only (e.g. origin/main); without it the working tree is used.\n";

for (const [name, args, status, stdout, stderr] of [
  ["help succeeds", ["--help"], 0, usage, ""],
  ["no documents fails with usage", [], 2, usage, ""],
  ["unknown option fails", ["--unknown"], 2, "", "unknown option --unknown\n"],
  ["missing ref value fails", ["--ref"], 2, "", "--ref requires a value\n"],
  ["missing repo root value fails", ["--repo-root"], 2, "", "--repo-root requires a value\n"],
]) {
  test(name, (t) => {
    const { root } = fixture(t);
    assert.deepEqual(run(root, args), { status, stdout, stderr });
  });
}

test("valid document reports exact counts", (t) => {
  const { root, doc } = fixture(t);
  assert.deepEqual(checkDocument(doc, makeReader({ repoRoot: root })), { problems: [], scenarioCount: 1, testRefCount: 1 });
  assert.deepEqual(run(root, ["valid.json"]), { status: 0, stdout: `${summary(1, 1, 1, "none")}\ncheck-acceptance-scenarios OK\n`, stderr: "" });
});

test("two documents sum scenarios and references", (t) => {
  const { root } = fixture(t);
  assert.deepEqual(run(root, ["valid.json", "other.json"]), { status: 0, stdout: `${summary(2, 3, 2, "none")}\ncheck-acceptance-scenarios OK\n`, stderr: "" });
});

test("malformed JSON fails but the following document is counted", (t) => {
  const { root } = fixture(t);
  assert.deepEqual(run(root, ["broken.json", "valid.json"]), { status: 1, stdout: `${summary(2, 1, 1, 1)}\ncheck-acceptance-scenarios FAILED\n`, stderr: "" });
});

test("missing document fails but the following document is counted", (t) => {
  const { root } = fixture(t);
  assert.deepEqual(run(root, ["absent.json", "valid.json"]), { status: 1, stdout: `${summary(2, 1, 1, 1)}\ncheck-acceptance-scenarios FAILED\n`, stderr: "" });
});

test("missing referenced file fails with a diagnostic", (t) => {
  const { root } = fixture(t);
  const result = run(root, ["missing-ref.json"]);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /broken testRef "absent\.test\.mjs"/);
  assert.ok(result.stdout.endsWith(`${summary(1, 1, 1, 1)}\ncheck-acceptance-scenarios FAILED\n`));
});

test("stdin document is validated", (t) => {
  const { root, doc } = fixture(t);
  assert.deepEqual(run(root, ["-"], JSON.stringify(doc)), { status: 0, stdout: `${summary(1, 1, 1, "none")}\ncheck-acceptance-scenarios OK\n`, stderr: "" });
});

test("valid and invalid runs are repeatable", (t) => {
  const { root } = fixture(t);
  for (const args of [["valid.json"], ["missing-ref.json"]]) {
    assert.deepEqual(run(root, args), run(root, args));
  }
});
