import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { readAllowedShas } from "./ai-signature-scan.mjs";

function fixtureDir(t) {
  const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || path.join(os.homedir(), ".cache", "myrmidon-test-scratch");
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, "signature-allowlist-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("readAllowedShas file contract", () => {
  it("accepts only lowercase 40-character hex lines after trimming, deduplicating CRLF input", (t) => {
    const file = path.join(fixtureDir(t), "allow.txt");
    const first = "0123456789abcdef0123456789abcdef01234567";
    const second = "abcdef0123456789abcdef0123456789abcdef01";
    fs.writeFileSync(file, [
      `  ${first}  `,
      `\t${second}\t`,
      first,
      "",
      "   ",
      `# ${first}`,
      first.toUpperCase(),
      "a".repeat(39),
      "b".repeat(41),
      `${"c".repeat(39)}g`,
      "synthetic sentinel",
      "",
    ].join("\r\n"));
    assert.deepEqual(readAllowedShas(file), new Set([first, second]));
  });

  it("returns an empty Set for a missing file", (t) => {
    assert.deepEqual(readAllowedShas(path.join(fixtureDir(t), "missing.txt")), new Set());
  });

  it("returns independent Sets for different files", (t) => {
    const dir = fixtureDir(t);
    const first = "1".repeat(40);
    const second = "2".repeat(40);
    const fileA = path.join(dir, "a.txt");
    const fileB = path.join(dir, "b.txt");
    fs.writeFileSync(fileA, `${first}\n`);
    fs.writeFileSync(fileB, `${second}\n`);
    const a = readAllowedShas(fileA);
    const b = readAllowedShas(fileB);
    assert.deepEqual(a, new Set([first]));
    assert.deepEqual(b, new Set([second]));
    assert.notStrictEqual(a, b);
    a.clear();
    a.add("3".repeat(40));
    assert.deepEqual(b, new Set([second]));
  });
});
