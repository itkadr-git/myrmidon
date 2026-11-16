import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { compileForbiddenPatterns, main, parseAddedLines, scan } from "./scan-diff.mjs";

const scratchRoot = process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? os.homedir();
const token = (...parts) => parts.join("");

function addedDiff(file, lines, start = 1) {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -0,0 +${start},${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
    "",
  ].join("\n");
}

function withDiff(text, callback) {
  const dir = fs.mkdtempSync(path.join(scratchRoot, "myrmidon-forbidden-"));
  const file = path.join(dir, "change.diff");
  fs.writeFileSync(file, text);
  try {
    return callback(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runMain(argv, env) {
  const output = [];
  const log = { log: (message) => output.push(message), error: (message) => output.push(message) };
  return { code: main(argv, env, log), output: output.join("\n") };
}

describe("compileForbiddenPatterns contract", () => {
  it("handles CRLF, blank lines, trimming, comments, and original rule numbers", () => {
    const patterns = compileForbiddenPatterns("  # ignored\r\n\r\n  alpha  \r\n # also ignored\r\n beta ");
    assert.deepEqual(patterns.map(({ number }) => number), [3, 5]);
    assert.deepEqual([
      patterns[0].regex.test("ALPHA"),
      patterns[1].regex.test("beta"),
      patterns[1].regex.test("alphabet"),
    ], [true, true, false]);
  });

  it("compiles valid expressions case-insensitively", () => {
    const [pattern] = compileForbiddenPatterns("corp[-_]host");
    assert.deepEqual([pattern.regex.test("CORP_HOST"), pattern.regex.test("corp-host"), pattern.regex.test("corp host")], [true, true, false]);
  });

  it("treats an invalid expression as a literal match", () => {
    const [pattern] = compileForbiddenPatterns("corp.*[");
    assert.deepEqual([pattern.regex.test("CORP.*["), pattern.regex.test("corpXYZ[")], [true, false]);
  });
});

describe("forbidden scan contract", () => {
  it("reports both matching rules with file and source line only", () => {
    const forbidden = token("corp", "-", "host");
    const patterns = compileForbiddenPatterns(`${forbidden}\r\n${forbidden}`);
    const added = parseAddedLines(addedDiff("config/example.txt", ["safe", `endpoint=${forbidden}`], 40));
    const snapshot = structuredClone(added);
    const findings = scan(added, { check: "forbidden", patterns });
    const expected = [
      { file: "config/example.txt", line: 41, rule: "forbidden pattern #1" },
      { file: "config/example.txt", line: 41, rule: "forbidden pattern #2" },
    ];
    assert.deepEqual(findings, expected);
    assert.deepEqual(scan(added, { check: "forbidden", patterns }), expected);
    assert.deepEqual(added, snapshot);
    assert.ok(!JSON.stringify(findings).includes(forbidden));
    assert.ok(!Object.values(findings[0]).includes("endpoint=" + forbidden));
  });

  it("keeps clean negative controls clean and does not mutate input across repeated calls", () => {
    const patterns = compileForbiddenPatterns("corp-host");
    const added = parseAddedLines(addedDiff("docs/example.md", ["public example", "corp host"], 8));
    const snapshot = structuredClone(added);
    assert.deepEqual(scan(added, { check: "forbidden", patterns }), []);
    assert.deepEqual(scan(added, { check: "forbidden", patterns }), []);
    assert.deepEqual(added, snapshot);
  });

  it("preserves exact line numbers across multiple files", () => {
    const patterns = compileForbiddenPatterns("blocked");
    const added = parseAddedLines(
      addedDiff("a.txt", ["safe", "blocked"], 10) + addedDiff("b.txt", ["safe", "blocked"], 70),
    );
    assert.deepEqual(scan(added, { check: "forbidden", patterns }), [
      { file: "a.txt", line: 11, rule: "forbidden pattern #1" },
      { file: "b.txt", line: 71, rule: "forbidden pattern #1" },
    ]);
  });

  it("runs the forbidden check through main without exposing configured values", () => {
    const forbidden = token("internal", ".", "host");
    const diff = addedDiff("scripts/release.sh", [`TARGET=${forbidden}`]);
    const result = withDiff(diff, (file) => runMain(["--check", "forbidden", "--diff-file", file], {
      MYRMIDON_FORBIDDEN_PATTERNS: `# private\n${forbidden}`,
    }));
    assert.equal(result.code, 1);
    assert.match(result.output, /::error file=scripts\/release\.sh,line=1::forbidden pattern #2/);
    assert.ok(!result.output.includes(forbidden));
    assert.ok(!result.output.includes(`TARGET=${forbidden}`));
  });
});
