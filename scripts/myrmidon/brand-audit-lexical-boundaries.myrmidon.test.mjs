import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const audit = fileURLToPath(new URL("./brand-release-audit.mjs", import.meta.url));
const scratch = process.env.MYRMIDON_RUN_SCRATCH_DIR || process.env.PAPERCLIP_RUN_SCRATCH_DIR || path.join(os.homedir(), ".cache", "myrmidon-test-scratch");

const cases = [
  ["bare", "Paperclip", 1],
  ["at start", "Paperclip works", 1],
  ["at end", "Use Paperclip", 1],
  ["spaces", "Use Paperclip now", 1],
  ["parentheses", "(Paperclip)", 1],
  ["brackets", "[Paperclip]", 1],
  ["comma", "Paperclip, works", 1],
  ["colon", "Paperclip: works", 1],
  ["exclamation", "Paperclip!", 1],
  ["question mark", "Paperclip?", 1],
  ["word prefix", "xPaperclip", 0],
  ["underscore prefix", "_Paperclip", 0],
  ["at prefix", "@Paperclip", 0],
  ["dot prefix", ".Paperclip", 0],
  ["slash prefix", "/Paperclip", 0],
  ["hyphen prefix", "-Paperclip", 0],
  ["word suffix", "Paperclipx", 0],
  ["underscore suffix", "Paperclip_", 0],
  ["hyphen suffix", "Paperclip-x", 0],
  ["lowercase", "paperclip", 0],
  ["uppercase", "PAPERCLIP", 0],
  ["two lines", "Paperclip!\nUse Paperclip.", 2],
];

for (const [name, input, count] of cases) {
  test(`product lexical boundary: ${name}`, (t) => {
    fs.mkdirSync(scratch, { recursive: true });
    const root = fs.mkdtempSync(path.join(scratch, "brand-boundary-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const script = path.join(root, "scripts/myrmidon/brand-release-audit.mjs");
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.copyFileSync(audit, script);
    fs.writeFileSync(path.join(root, "README.md"), `${input}\n`);
    const result = spawnSync(process.execPath, [script, "--gate"], {
      cwd: root, encoding: "utf8", env: {},
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, count ? 1 : 0, result.stdout + result.stderr);
    const findings = input.split("\n").filter(() => count > 0);
    const expectedLines = count ? findings.map((line, i) => `  README.md:${i + 1}: ${line}`) : [];
    assert.equal(result.stdout, [
      `brand-release-audit: ${count} non-allowlisted "Paperclip" mention(s) in user-facing docs`,
      ...expectedLines,
      "brand-release-audit: 0 stale package.json repository/homepage/bugs URL(s)",
      ...(count ? [
        "brand-release-audit: report mode — findings listed above (a non-zero total is expected until the parallel DEBRAND parts land)",
        "brand-release-audit: --gate: failing",
      ] : ["brand-release-audit: clean"]),
      "",
    ].join("\n"));
    assert.equal(result.stderr, "");
  });
}
