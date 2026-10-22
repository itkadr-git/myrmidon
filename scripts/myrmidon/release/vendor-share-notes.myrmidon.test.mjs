// myrmidon(VENDOR-SHARE-METRIC): tests for the release-notes vendor-share line.
//
// Hermetic: the current share comes from a JSON state file through
// MYRMIDON_RELEASE_VENDOR_SHARE_STATE, so no git checkout or vendor base is
// needed here (the analyzer itself is covered by vendor-share.myrmidon.test.mjs).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  NOT_COMPUTED,
  STATE_ENV,
  formatShareLine,
  main,
  parseShareLine,
  pctOf,
} from "./vendor-share-notes.mjs";

const WORK = fs.mkdtempSync(
  path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || os.tmpdir(), "vendor-share-notes-")
);

const summaryOf = (inherited, totalFiles) => ({
  inherited,
  totalFiles,
  share: inherited / totalFiles,
});

const writeJson = (name, value) => {
  const file = path.join(WORK, name);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
};

const run = (argv, env = {}) => {
  let out = "";
  let err = "";
  const previous = process.env[STATE_ENV];
  Object.assign(process.env, env);
  try {
    const code = main(argv, { out: (s) => (out += s), err: (s) => (err += s) });
    return { code, out, err };
  } finally {
    if (previous === undefined) delete process.env[STATE_ENV];
    else process.env[STATE_ENV] = previous;
  }
};

test("parseShareLine reads the line out of a published release body", () => {
  const body = [
    "## What's changed",
    "",
    "- something",
    "",
    "## Vendor-derived files",
    "",
    "Vendor-derived files: 6123 of 6812 (89.89%), Δ to myr-v1.6.4: +0.12 pp (+7 files)",
    "",
  ].join("\n");
  assert.deepEqual(parseShareLine(body), {
    inherited: 6123,
    totalFiles: 6812,
    share: 6123 / 6812,
  });
});

test("parseShareLine returns null when the body carries no share line", () => {
  assert.equal(parseShareLine(""), null);
  assert.equal(parseShareLine(undefined), null);
  assert.equal(parseShareLine("## Vendor-derived files\n\n" + NOT_COMPUTED + "\n"), null);
});

test("formatShareLine reports share, and 'нет данных' without a previous release", () => {
  const current = summaryOf(6123, 6812);
  assert.equal(pctOf(current), "89.89");
  assert.match(
    formatShareLine(current, null, null),
    /^Vendor-derived files: 6123 of 6812 \(89\.89%\), Δ to the previous release: нет данных/
  );
});

test("formatShareLine computes the delta in percentage points and files", () => {
  const line = formatShareLine(summaryOf(6130, 6812), summaryOf(6123, 6812), "myr-v1.6.4");
  assert.equal(
    line,
    "Vendor-derived files: 6130 of 6812 (89.99%), Δ to myr-v1.6.4: +0.10 pp (+7 files)"
  );
});

test("formatShareLine signs a shrinking share", () => {
  const line = formatShareLine(summaryOf(6100, 6812), summaryOf(6123, 6812), "myr-v1.6.4");
  assert.match(line, /Δ to myr-v1\.6\.4: -0\.34 pp \(-23 files\)$/);
});

test("formatShareLine notes a previous tag that has no share line", () => {
  const line = formatShareLine(summaryOf(6123, 6812), null, "myr-v1.6.0");
  assert.match(line, /Δ to myr-v1\.6\.0: нет данных \(no vendor-share line in that release\)$/);
});

test("main prints the line from the state seam and exits 0", () => {
  const state = writeJson("current.json", { summary: summaryOf(6123, 6812) });
  const result = run([], { [STATE_ENV]: state });
  assert.equal(result.code, 0);
  assert.match(result.out, /^Vendor-derived files: 6123 of 6812 \(89\.89%\)/);
  assert.equal(result.err, "");
});

test("main calls an unreadable state a failure to compute, not a crash", () => {
  const missing = run([], { [STATE_ENV]: path.join(WORK, "absent.json") });
  assert.equal(missing.code, 3);
  assert.match(missing.err, /current share not computed/);
  assert.equal(missing.out, "");

  const malformed = run([], { [STATE_ENV]: writeJson("bad.json", { share: 0.5 }) });
  assert.equal(malformed.code, 3);
  assert.match(malformed.err, /totalFiles, inherited and share/);
});

test("main reads the previous release body and reports the delta", () => {
  const state = writeJson("current2.json", summaryOf(6130, 6812));
  const body = path.join(WORK, "previous-body.md");
  fs.writeFileSync(body, "Vendor-derived files: 6123 of 6812 (89.89%)\n");
  const result = run(["--previous-tag", "myr-v1.6.4", "--previous-body", body], {
    [STATE_ENV]: state,
  });
  assert.equal(result.code, 0);
  assert.match(result.out, /Δ to myr-v1\.6\.4: \+0\.10 pp \(\+7 files\)\n$/);
});

test("main rejects unknown arguments with exit 2", () => {
  const result = run(["--nope"], {});
  assert.equal(result.code, 2);
  assert.match(result.err, /unknown argument --nope/);
});

test("the printed line round-trips through parseShareLine", () => {
  const state = writeJson("current3.json", summaryOf(6123, 6812));
  const { out } = run([], { [STATE_ENV]: state });
  const parsed = parseShareLine(out);
  assert.deepEqual(parsed, { inherited: 6123, totalFiles: 6812, share: 6123 / 6812 });
});