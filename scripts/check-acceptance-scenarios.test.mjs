import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  checkDocument,
  checkTestRef,
  makeReader,
  readRefFile,
  refFileExists,
  resolveTestRefFile,
  validateScenario,
} from "./check-acceptance-scenarios.mjs";

// ── helpers ──────────────────────────────────────────────────────────────

function scenarioWith(overrides = {}) {
  return {
    id: "SCEN-001",
    title: "Sample scenario",
    falsifiedWhen: "report says OK while a required field is missing",
    testRefs: [],
    ...overrides,
  };
}

// ── document validation ──────────────────────────────────────────────────

test("valid document with one full scenario and one existing testRef passes", () => {
  const doc = {
    version: 1,
    scenarios: [
      scenarioWith({
        testRefs: ["packages/shared/src/exports.test.ts"],
      }),
    ],
  };
  const reader = (candidate) =>
    candidate === "packages/shared/src/exports.test.ts" ? { ok: true, content: "test('x')" } : { ok: false };
  const { problems, scenarioCount, testRefCount } = checkDocument(doc, reader);
  assert.deepEqual(problems, []);
  assert.equal(scenarioCount, 1);
  assert.equal(testRefCount, 1);
});

test("scenario without falsifiedWhen is reported (the falsifiedWhen criterion)", () => {
  const doc = {
    version: 1,
    scenarios: [
      scenarioWith({ id: "SCEN-002", falsifiedWhen: undefined }),
    ],
  };
  delete doc.scenarios[0].falsifiedWhen;
  const { problems } = checkDocument(doc, () => ({ ok: false }));
  assert.equal(problems.length, 1, problems.join("; "));
  assert.match(problems[0], /missing or empty required field "falsifiedWhen"/);
});

test("empty-string and empty-array falsifiedWhen are reported too", () => {
  for (const falsifiedWhen of ["", []]) {
    const doc = { version: 1, scenarios: [scenarioWith({ falsifiedWhen })] };
    const { problems } = checkDocument(doc, () => ({ ok: false }));
    assert.ok(problems.some((p) => p.includes('"falsifiedWhen"')), falsifiedWhen.toString());
  }
});

test("broken testRef (no candidate file exists) is reported, not silent", () => {
  const doc = {
    version: 1,
    scenarios: [
      scenarioWith({ testRefs: ["server/src/services/does-not-exist-anywhere.test.ts"] }),
    ],
  };
  const { problems } = checkDocument(doc, () => ({ ok: false }));
  assert.equal(problems.length, 1, problems.join("; "));
  assert.match(problems[0], /broken testRef/);
});

test("broken testRef in structured form is reported with its path", () => {
  const doc = {
    version: 1,
    scenarios: [
      scenarioWith({ testRefs: [{ path: "ui/src/lib/nope.ts", testName: "some test" }] }),
    ],
  };
  const { problems } = checkDocument(doc, () => ({ ok: false }));
  assert.ok(problems.some((p) => p.includes("ui/src/lib/nope.ts") && p.includes("broken testRef")));
});

test("duplicate scenario id is reported", () => {
  const doc = {
    version: 1,
    scenarios: [
      scenarioWith({ id: "SCEN-DUP" }),
      scenarioWith({ id: "SCEN-DUP" }),
    ],
  };
  const { problems } = checkDocument(doc, () => ({ ok: false }));
  assert.ok(problems.some((p) => p.includes('duplicate scenario id "SCEN-DUP"')));
});

test("unknown scenario field is reported (strict contract)", () => {
  const doc = {
    version: 1,
    scenarios: [scenarioWith({ falsifydWhen: "typo" })],
  };
  const { problems } = checkDocument(doc, () => ({ ok: true, content: "" }));
  assert.ok(problems.some((p) => p.includes('unknown field "falsifydWhen"')));
});

test("missing scenarios array is reported", () => {
  const { problems } = checkDocument({ version: 1 }, () => ({ ok: false }));
  assert.ok(problems.some((p) => p.includes('"scenarios" must be an array')));
});

test("testRef name hint not present in the referenced file is reported", () => {
  const doc = {
    version: 1,
    scenarios: [
      scenarioWith({
        testRefs: [{ path: "packages/shared/src/exports.test.ts", testName: "no such test here" }],
      }),
    ],
  };
  const reader = (candidate) => ({ ok: true, content: "test('other test')" });
  const { problems } = checkDocument(doc, reader);
  assert.ok(problems.some((p) => p.includes('test name "no such test here" not found')));
});

test("bare scenario array form is accepted", () => {
  const doc = [scenarioWith()];
  const { problems, scenarioCount } = checkDocument(doc, () => ({ ok: false }));
  assert.deepEqual(problems, []);
  assert.equal(scenarioCount, 1);
});

test("non-object document is reported", () => {
  const { problems } = checkDocument("not-a-doc", () => ({ ok: false }));
  assert.ok(problems.some((p) => p.includes('expected an object with a "scenarios" array')));
});

// ── testRef resolution details ───────────────────────────────────────────

test("resolveTestRefFile tries the literal path first, then suffixes", () => {
  const seen = [];
  const reader = (candidate) => {
    seen.push(candidate);
    return candidate === "a/b.ts.test.ts" ? { ok: true, content: "" } : { ok: false };
  };
  const result = resolveTestRefFile("a/b.ts", reader);
  assert.equal(result.ok, true);
  assert.equal(result.path, "a/b.ts.test.ts");
  assert.deepEqual(seen, ["a/b.ts", "a/b.ts.test.ts"]);
});

test("resolveTestRefFile reports all tried candidates on failure", () => {
  const result = resolveTestRefFile("a/b.ts", () => ({ ok: false }));
  assert.equal(result.ok, false);
  assert.ok(result.tried.includes("a/b.ts"));
  assert.ok(result.tried.includes("a/b.ts.test.mjs"));
});

test("checkTestRef passes when file exists and name hint matches", () => {
  const result = checkTestRef(
    { path: "t/x.ts", suite: "acceptance" },
    (candidate) => (candidate === "t/x.ts" ? { ok: true, content: "describe('acceptance'" } : { ok: false }),
  );
  assert.equal(result.ok, true);
});

test("checkTestRef fails when the name hint is absent", () => {
  const result = checkTestRef({ path: "t/x.ts", testName: "missing" }, () => ({ ok: true, content: "x" }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /test name "missing" not found/);
});

test("validateScenario rejects a non-object", () => {
  assert.deepEqual(validateScenario(null, 3), ["scenario[3]: not an object"]);
});

// ── ref-reading helpers (run against a real temp git repo) ───────────────

function initTempRepo() {
  const root = mkdtempSync(path.join(os.tmpdir(), "acc-scen-test-"));
  const run = (args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
  run(["init", "-q", "-b", "main"]);
  run(["config", "user.email", "t@example.test"]);
  run(["config", "user.name", "t"]);
  mkdirSync(path.join(root, "t"), { recursive: true });
  writeFileSync(path.join(root, "t", "x.test.ts"), "test('present in main', () => {});\n");
  run(["add", "."]);
  run(["commit", "-q", "-m", "one"]);
  run(["branch", "pr-branch"]);
  run(["switch", "-q", "pr-branch"]);
  // pr-branch gains an extra file the main tree must NOT see
  writeFileSync(path.join(root, "t", "only-on-pr.test.ts"), "test('pr only', () => {});\n");
  run(["add", "."]);
  run(["commit", "-q", "-m", "two"]);
  return { root, run };
}

test("readRefFile reads only the requested ref's tree", () => {
  const { root } = initTempRepo();
  try {
    const onMain = readRefFile(root, "main", "t/x.test.ts");
    assert.equal(onMain.ok, true);
    assert.match(onMain.content, /present in main/);

    const missing = readRefFile(root, "main", "t/only-on-pr.test.ts");
    assert.equal(missing.ok, false);
    assert.equal(missing.missing, true, JSON.stringify(missing));

    const onPr = readRefFile(root, "pr-branch", "t/only-on-pr.test.ts");
    assert.equal(onPr.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refFileExists distinguishes present vs absent paths in a ref", () => {
  const { root } = initTempRepo();
  try {
    assert.equal(refFileExists(root, "main", "t/x.test.ts"), true);
    assert.equal(refFileExists(root, "main", "t/only-on-pr.test.ts"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkDocument with a --ref-style reader ignores files absent from that ref", () => {
  const { root } = initTempRepo();
  try {
    const doc = {
      version: 1,
      scenarios: [
        scenarioWith({ id: "SCEN-REF", testRefs: ["t/only-on-pr.test.ts"] }),
      ],
    };
    const mainReader = makeReader({ repoRoot: root, ref: "main" });
    const { problems } = checkDocument(doc, mainReader);
    assert.equal(problems.length, 1, problems.join("; "));
    assert.match(problems[0], /broken testRef/);

    const prReader = makeReader({ repoRoot: root, ref: "pr-branch" });
    const onPr = checkDocument(doc, prReader);
    assert.deepEqual(onPr.problems, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("makeReader without ref reads the working tree", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "acc-scen-wt-"));
  try {
    mkdirSync(path.join(root, "t"), { recursive: true });
    writeFileSync(path.join(root, "t", "wt.test.ts"), "test('worktree');\n");
    const reader = makeReader({ repoRoot: root });
    const resolved = resolveTestRefFile("t/wt.test.ts", reader);
    assert.equal(resolved.ok, true);
    assert.match(resolved.content, /worktree/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
