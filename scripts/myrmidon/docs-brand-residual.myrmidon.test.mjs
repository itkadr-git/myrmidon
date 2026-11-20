import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const source = fileURLToPath(new URL("./docs-branding-guard.mjs", import.meta.url));
const cases = [
  ["header followed by bare name", "X-Paperclip-Run-Id and Paperclip", [1]],
  ["cloud followed by bare name", "Paperclip Cloud and Paperclip", [1]],
  ["cli followed by bare name", "paperclipai and Paperclip", [1]],
  ["all identifiers followed by bare name", "X-Paperclip-Run-Id Paperclip Cloud paperclipai Paperclip", [1]],
  ["header alone", "X-Paperclip-Run-Id", []],
  ["cloud alone", "Paperclip Cloud", []],
  ["cli alone", "paperclipai", []],
  ["identifiers alone", "X-Paperclip-Run-Id Paperclip Cloud paperclipai", []],
  ["multiple names on one line", "Paperclip and Paperclip", [1]],
  ["names on two lines", "Paperclip\nPaperclip", [1, 2]],
  ["punctuation around name", "(Paperclip),", [1]],
  ["word prefix", "SomePaperclip", []],
  ["word suffix", "PaperclipThing", []],
  ["at prefix", "@Paperclip", []],
  ["slash prefix", "/Paperclip", []],
  ["dash prefix", "other-Paperclip", []],
  ["dash suffix", "Paperclip-other", []],
  ["dot prefix", ".Paperclip", []],
];

function runGuard(content) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "docs-brand-residual-"));
  try {
    const scripts = path.join(root, "scripts", "myrmidon");
    fs.mkdirSync(scripts, { recursive: true });
    fs.mkdirSync(path.join(root, "docs"));
    fs.copyFileSync(source, path.join(scripts, "docs-branding-guard.mjs"));
    fs.writeFileSync(path.join(root, "docs", "fixture.md"), content);
    return spawnSync(process.execPath, [path.join(scripts, "docs-branding-guard.mjs")], { encoding: "utf8" });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function assertResult(result, lines) {
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, lines.length ? 1 : 0);
  assert.equal(result.stderr, "");
  const diagnostics = lines.map((line) => `docs/fixture.md:${line}: non-allowlisted "Paperclip" mention`);
  const summary = lines.length
    ? `docs-branding-guard: ${lines.length} finding(s) — rename the product mention to Myrmidon or extend the allowlist (see docs/myrmidon/guides/docs-branding.md)`
    : "docs-branding-guard: clean";
  assert.equal(result.stdout, [...diagnostics, summary, ""].join("\n"));
}

for (const [name, content, lines] of cases) {
  test(name, () => assertResult(runGuard(content), lines));
}

test("negative control: a wrong expected exit and finding is rejected", () => {
  const result = runGuard("Paperclip Cloud and Paperclip");
  assert.throws(() => assertResult(result, []), assert.AssertionError);
  assertResult(result, [1]);
});
