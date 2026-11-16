import assert from "node:assert/strict";
import { test } from "node:test";
import { BASELINE_FILE, isScanned, parseBaseline } from "./paperclip-names-ratchet.mjs";

const legacyPrefix = ["PAPER", "CLIP"].join("") + "_";

test("only root documentation directories are excluded by prefix", () => {
  const cases = [
    ["docs/example.ts", false], ["doc/example.ts", false],
    ["docs-old/example.ts", true], ["document/example.ts", true],
    ["nested/docs/example.ts", true], ["nested/doc/example.ts", true],
    ["Docs/example.ts", true], ["DOC/example.ts", true],
  ];
  for (const [file, expected] of cases) assert.equal(isScanned(file), expected, file);
});

test("excluded suffixes match exactly and are case-sensitive", () => {
  const suffixes = [
    ".md", ".mdx", "pnpm-lock.yaml", "package-lock.json",
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".svg", ".pdf",
    ".woff", ".woff2", ".ttf", ".otf", ".zip", ".gz", ".tgz", ".wasm",
  ];
  for (const suffix of suffixes) {
    const file = `src/example${suffix}`;
    assert.equal(isScanned(file), false, file);
    assert.equal(isScanned(`${file}.ts`), true, `${file}.ts`);
    assert.equal(isScanned(`src/example${suffix.toUpperCase()}`), true, suffix.toUpperCase());
  }
});

test("self files are excluded only at their exact paths", () => {
  const selfFiles = [
    BASELINE_FILE,
    "scripts/myrmidon/ci/" + ["paperclip", "names-ratchet.mjs"].join("-"),
    "scripts/myrmidon/ci/" + ["paperclip", "names-ratchet.test.mjs"].join("-"),
  ];
  for (const file of selfFiles) {
    assert.equal(isScanned(file), false, file);
    assert.equal(isScanned(`nested/${file}`), true, `nested/${file}`);
    assert.equal(isScanned(`${file}.ts`), true, `${file}.ts`);
    assert.equal(isScanned(file.toUpperCase()), true, file.toUpperCase());
  }
});

test("baseline accepts CRLF and removes duplicate records", () => {
  const a = `${legacyPrefix}ALPHA`;
  const b = `${legacyPrefix}BETA`;
  assert.deepEqual([...parseBaseline(`${a}\r\n${b}\r\n${a}\r\n`)], [a, b]);
});

test("baseline strips inline comments and ignores blank-only input", () => {
  const name = `${legacyPrefix}ENTRY`;
  assert.deepEqual([...parseBaseline(`  ${name}  # note\r\n # comment\n\t\n`)], [name]);
  assert.deepEqual([...parseBaseline(" \r\n\t\n  ")], []);
});

test("baseline retains the last record without a newline", () => {
  const a = `${legacyPrefix}FIRST`;
  const b = `${legacyPrefix}LAST`;
  assert.deepEqual([...parseBaseline(`${a}\n${b}`)], [a, b]);
});
