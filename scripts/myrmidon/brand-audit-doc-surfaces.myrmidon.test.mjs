import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const audit = fileURLToPath(new URL("./brand-release-audit.mjs", import.meta.url));
const scratch = process.env.MYRMIDON_RUN_SCRATCH_DIR || process.env.PAPERCLIP_RUN_SCRATCH_DIR || path.join(os.homedir(), ".myrmidon-scratch");

function runFixture(t, files) {
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, "brand-doc-surfaces-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, "scripts/myrmidon/brand-release-audit.mjs");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.copyFileSync(audit, script);
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  const result = spawnSync(process.execPath, [script], { encoding: "utf8", env: {} });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return result.stdout;
}

const selected = [
  "README.md",
  "README.ru.md",
  "CONTRIBUTING.md",
  "ROADMAP.md",
  "DESIGN.md",
  "AGENTS.md",
  "CLAUDE.md",
  "docs/index.md",
  "docs/guide/setup.md",
  "docs/deep/nested/page.md",
];

for (const file of selected) {
  test(`reports ${file} at its actual line`, (t) => {
    const output = runFixture(t, { [file]: "# Guide\n\nPaperclip is the product.\n" });
    assert.ok(output.includes('brand-release-audit: 1 non-allowlisted "Paperclip" mention(s) in user-facing docs\n'), output);
    assert.ok(output.includes(`  ${file}:3: Paperclip is the product.\n`), output);
  });
}

for (const file of ["docs/guide.txt", "docs/nested/guide.txt", "doc/guide.md", "OTHER.md"]) {
  test(`does not scan ${file}`, (t) => {
    const output = runFixture(t, { [file]: "Paperclip is the product.\n" });
    assert.ok(output.includes('brand-release-audit: 0 non-allowlisted "Paperclip" mention(s) in user-facing docs\n'), output);
    assert.ok(!output.includes(`${file}:1:`), output);
    assert.ok(output.includes("brand-release-audit: clean\n"), output);
  });
}

test("missing root documents and docs directory are not errors", (t) => {
  const output = runFixture(t, {});
  assert.ok(output.includes('brand-release-audit: 0 non-allowlisted "Paperclip" mention(s) in user-facing docs\n'), output);
  assert.ok(output.includes("brand-release-audit: clean\n"), output);
});
