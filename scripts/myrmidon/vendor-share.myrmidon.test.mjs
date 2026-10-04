import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_THRESHOLD,
  THRESHOLD_ENV,
  analyzeVendorShare,
  formatMarkdown,
  globToRegExp,
  isExcluded,
  lineSimilarity,
  resolveThreshold,
} from "./vendor-share.mjs";

const SCRIPT = fileURLToPath(new URL("./vendor-share.mjs", import.meta.url));

function git(cwd, args) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(res.stderr || res.error || "").toString()}`);
  }
  return res.stdout.trim();
}

// A tiny artificial repository: a "vendor" base commit, then one unchanged
// file, one rewritten file, one renamed file that stays byte-identical, one
// added file and one excluded lock file.
function makeFixtureRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-share-"));
  const init = (...args) => git(root, ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args]);
  init("init", "-q", "-b", "main");

  const vendorLines = (n, prefix) =>
    Array.from({ length: n }, (_, i) => `${prefix} line ${i + 1}`).join("\n") + "\n";

  fs.writeFileSync(path.join(root, "keep.txt"), vendorLines(10, "vendor"));
  fs.writeFileSync(path.join(root, "change.txt"), vendorLines(10, "vendor change"));
  fs.writeFileSync(path.join(root, "renamed.txt"), vendorLines(5, "vendor renamed"));
  init("add", "-A");
  init("commit", "-q", "-m", "vendor base");
  const base = git(root, ["rev-parse", "HEAD"]);

  // HEAD: keep untouched, rewrite `change.txt` completely, rename `renamed.txt`
  // (content intact), add a brand-new file and an excluded lock file.
  fs.writeFileSync(path.join(root, "change.txt"), vendorLines(10, "our own text"));
  init("mv", "renamed.txt", "renamed-moved.txt");
  fs.writeFileSync(path.join(root, "new.txt"), vendorLines(5, "brand new"));
  fs.writeFileSync(path.join(root, "package-lock.json"), "{}\n");
  init("add", "-A");
  init("commit", "-q", "-m", "our changes");
  return { root, base };
}

describe("globToRegExp / isExcluded", () => {
  it("matches nested and top-level lock files", () => {
    assert.ok(globToRegExp("**/package-lock.json").test("package-lock.json"));
    assert.ok(globToRegExp("**/package-lock.json").test("ui/package-lock.json"));
    assert.ok(isExcluded("pnpm-lock.yaml"));
    assert.ok(isExcluded("node_modules/foo/index.js"));
    assert.ok(!isExcluded("server/src/index.ts"));
    assert.ok(!isExcluded("scripts/myrmidon/vendor-share.mjs"));
  });

  it("excludes the metric's own bookkeeping", () => {
    assert.ok(isExcluded("scripts/myrmidon/vendor-base.txt"));
    assert.ok(isExcluded("docs/myrmidon/DIVERGENCE.md"));
  });
});

describe("lineSimilarity", () => {
  it("scores an unchanged text 1 and a full rewrite 0", () => {
    const text = "a\nb\nc\n";
    assert.equal(lineSimilarity(text, text), 1);
    assert.equal(lineSimilarity("a\nb\nc\n", "x\ny\nz\n"), 0);
  });

  it("scores a partial edit between the two ends", () => {
    const before = ["1", "2", "3", "4"].join("\n");
    const after = ["1", "2", "3", "5"].join("\n");
    assert.equal(lineSimilarity(before, after), 0.75);
  });

  it("ignores line-ending and trailing-whitespace noise", () => {
    assert.equal(lineSimilarity("a\nb\n", "a\r\nb  \n"), 1);
  });
});

describe("resolveThreshold", () => {
  after(() => {
    delete process.env[THRESHOLD_ENV];
  });

  it("prefers the flag, then the env, then the default", () => {
    delete process.env[THRESHOLD_ENV];
    assert.deepEqual(resolveThreshold(undefined), { value: DEFAULT_THRESHOLD, source: "default" });
    process.env[THRESHOLD_ENV] = "0.7";
    assert.deepEqual(resolveThreshold(undefined), { value: 0.7, source: "env" });
    assert.deepEqual(resolveThreshold("0.9"), { value: 0.9, source: "flag" });
  });

  it("rejects an out-of-range threshold", () => {
    delete process.env[THRESHOLD_ENV];
    assert.throws(() => resolveThreshold("1.5"), /between 0 and 1/);
  });
});

describe("analyzeVendorShare on an artificial repository", () => {
  const fixture = makeFixtureRepo();
  after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  const result = analyzeVendorShare({ repoDir: fixture.root, base: fixture.base });
  const byPath = new Map(result.files.map((f) => [f.path, f]));

  it("keeps an unchanged vendor file as inherited", () => {
    assert.equal(byPath.get("keep.txt").kind, "inherited");
    assert.equal(byPath.get("keep.txt").similarity, 1);
  });

  it("does not inherit a file rewritten beyond the threshold", () => {
    assert.equal(byPath.get("change.txt").kind, "modified");
    assert.ok(byPath.get("change.txt").similarity < DEFAULT_THRESHOLD);
  });

  it("does not inherit a file that is absent from the base", () => {
    assert.equal(byPath.get("new.txt").kind, "new");
  });

  it("follows a git rename to the base path", () => {
    assert.equal(byPath.get("renamed-moved.txt").kind, "inherited");
    assert.equal(byPath.get("renamed-moved.txt").basePath, "renamed.txt");
  });

  it("excludes lock files from the measurement", () => {
    assert.equal(byPath.get("package-lock.json").kind, "excluded");
  });

  it("reports the summary over the measured files only", () => {
    assert.equal(result.summary.totalFiles, 4);
    assert.equal(result.summary.inherited, 2);
    assert.equal(result.summary.modified, 1);
    assert.equal(result.summary.newFiles, 1);
    assert.equal(result.summary.excluded, 1);
    assert.equal(result.summary.share, 0.5);
    assert.equal(result.summary.baseCommit, fixture.base);
  });

  it("breaks the share down by directory and by package", () => {
    assert.equal(result.byDirectory["(root)"].total, 4);
    assert.equal(result.byPackage["(root)"].total, 4);
  });

  it("honours a raised threshold", () => {
    const strict = analyzeVendorShare({ repoDir: fixture.root, base: fixture.base, threshold: 1 });
    const strictByPath = new Map(strict.files.map((f) => [f.path, f]));
    assert.equal(strictByPath.get("keep.txt").kind, "inherited");
    assert.equal(strict.summary.inherited, 2);
  });
});

describe("vendor-share CLI", () => {
  const fixture = makeFixtureRepo();
  after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  const run = (args) =>
    spawnSync(process.execPath, [SCRIPT, ...args], { cwd: fixture.root, encoding: "utf8" });

  it("prints parseable JSON with --json", () => {
    const res = run(["--repo", fixture.root, "--base", fixture.base, "--json"]);
    assert.equal(res.status, 0, res.stderr);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.summary.inherited, 2);
    assert.equal(parsed.summary.share, 0.5);
    assert.equal(parsed.summary.threshold, DEFAULT_THRESHOLD);
    assert.equal(parsed.summary.thresholdSource, "default");
  });

  it("prints a Markdown table by default and shows the threshold source", () => {
    const res = run(["--repo", fixture.root, "--base", fixture.base, "--threshold", "0.25"]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /# Vendor share/);
    assert.match(res.stdout, /\| Inherited from the vendor \| 2 \(50\.00%\) \|/);
    assert.match(res.stdout, /25\.00% \(flag\)/);
  });

  it("prints the Markdown for a prepared result", () => {
    const markdown = formatMarkdown(
      analyzeVendorShare({ repoDir: fixture.root, base: fixture.base }),
    );
    assert.match(markdown, /\| Top-level directory \| Files \| Inherited \| Share \|/);
  });
});