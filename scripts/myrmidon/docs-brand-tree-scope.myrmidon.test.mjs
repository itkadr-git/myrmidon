import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const guard = fileURLToPath(new URL("./docs-branding-guard.mjs", import.meta.url));
const diagnostic = (file, line = 1) => `docs/${file}:${line}: non-allowlisted "Paperclip" mention`;
const summary = (count) => `docs-branding-guard: ${count} finding(s) — rename the product mention to Myrmidon or extend the allowlist (see docs/myrmidon/guides/docs-branding.md)`;

function runGuard(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "docs-brand-tree-"));
  try {
    const scripts = path.join(root, "scripts/myrmidon");
    fs.mkdirSync(scripts, { recursive: true });
    fs.mkdirSync(path.join(root, "docs"));
    fs.copyFileSync(guard, path.join(scripts, "docs-branding-guard.mjs"));
    for (const [name, contents] of Object.entries(files)) {
      const file = path.join(root, "docs", name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, contents);
    }
    const result = spawnSync(process.execPath, [path.join(scripts, "docs-branding-guard.mjs")], { encoding: "utf8" });
    assert.equal(result.error, undefined);
    assert.equal(result.stderr, "");
    return { status: result.status, lines: result.stdout.trimEnd().split("\n") };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function expectClean(files) {
  assert.deepEqual(runGuard(files), { status: 0, lines: ["docs-branding-guard: clean"] });
}

function expectFindings(files, expected) {
  const result = runGuard(files);
  assert.equal(result.status, 1);
  assert.equal(result.lines.pop(), summary(expected.length));
  assert.deepEqual(result.lines.sort(), [...expected].sort());
}

for (const name of ["architecture/README.md", "wiki/Home.md", "wiki/Home.ru.md"]) {
  test(`exact exemption ${name}`, () => expectClean({ [name]: "Paperclip\n" }));
}
for (const name of ["other/README.md", "other/Home.md", "other/Home.ru.md", "wiki/Home.extra.md"]) {
  test(`non-exempt path ${name}`, () => expectFindings({ [name]: "Paperclip\n" }, [diagnostic(name)]));
}
test("recursive markdown is inspected", () => expectFindings({ "a/b/c.md": "Paperclip\n" }, [diagnostic("a/b/c.md")]));
test("recursive JSON is inspected", () => expectFindings({ "a/b/c.json": "{\n  \"name\": \"Use Paperclip now\"\n}\n" }, [diagnostic("a/b/c.json", 2)]));
test("text files are ignored", () => expectClean({ "a/b/c.txt": "Paperclip\n" }));
test("MDX files are ignored", () => expectClean({ "a/b/c.mdx": "Paperclip\n" }));
test("clean nested tree succeeds", () => expectClean({ "a/b/c.md": "Myrmidon\n", "a/d/data.json": "{}\n" }));
test("findings include exact paths and blank-line-aware line numbers", () => expectFindings({
  "z/one.md": "\n\nPaperclip\n\nPaperclip\n",
  "a/two.json": "\nPaperclip\n",
}, [diagnostic("z/one.md", 3), diagnostic("z/one.md", 5), diagnostic("a/two.json", 2)]));
test("mixed exempt and bad files report only bad files", () => expectFindings({
  "architecture/README.md": "Paperclip\n", "wiki/Home.md": "Paperclip\n", "wiki/Home.ru.md": "Paperclip\n", "other/Home.md": "Paperclip\n",
}, [diagnostic("other/Home.md")]));
test("negative control rejects an incorrect expected diagnostic", () => {
  assert.throws(() => expectFindings({ "other/Home.md": "Paperclip\n" }, [diagnostic("other/Home.md", 2)]), assert.AssertionError);
});
test("negative control rejects clean output when a bad file is present", () => {
  assert.throws(() => expectClean({ "a/b.md": "Paperclip\n" }), assert.AssertionError);
});
