import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, expect, it } from "vitest";
import { findRunnerExternalPackages } from "./verify-runner-vendor-dependencies.mjs";

let fixtureDir;

afterEach(() => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  fixtureDir = undefined;
});

function fixture() {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), ".cache", "vendor-scan-tests");
  mkdirSync(scratch, { recursive: true });
  fixtureDir = mkdtempSync(join(scratch, "vendor-scan-"));
  return fixtureDir;
}

function snapshot(root, dir = root) {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const path = join(dir, entry.name);
    const name = relative(root, path);
    return entry.isDirectory() ? [[name, "directory"], ...snapshot(root, path)] : [[name, readFileSync(path).toString("hex")]];
  });
}

it("scans twice without writing files, executing modules, or sharing mutable state", async () => {
  const root = fixture();
  const marker = join(root, "executed.marker");
  const nested = join(root, "nested", "side-effect.js");
  mkdirSync(dirname(nested), { recursive: true });
  writeFileSync(nested, `import "@scan-fixture/side-effect/subpath";\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "executed");\nthrow new Error("fixture executed");\n`);
  const index = join(root, "index.js");
  const other = join(root, "other.js");
  writeFileSync(index, 'import "./nested/side-effect.js";\nimport "scan-fixture-index";\n');
  writeFileSync(other, 'import "scan-fixture-other";\n');
  const entryPoints = [index, other];
  const originalEntries = [...entryPoints];
  const before = snapshot(root);
  const expected = new Set(["@scan-fixture/side-effect", "scan-fixture-index", "scan-fixture-other"]);

  const first = await findRunnerExternalPackages(entryPoints);
  expect(first).toEqual(expected);
  expect(entryPoints).toEqual(originalEntries);
  expect(snapshot(root)).toEqual(before);
  expect(existsSync(join(root, ".vendor-dependency-scan"))).toBe(false);
  expect(existsSync(marker)).toBe(false);
  first.add("injected-result");

  const second = await findRunnerExternalPackages(entryPoints);
  expect(second).not.toBe(first);
  expect(second).toEqual(expected);
  expect(second.has("injected-result")).toBe(false);
  expect(entryPoints).toEqual(originalEntries);
  expect(snapshot(root)).toEqual(before);
  expect(existsSync(join(root, ".vendor-dependency-scan"))).toBe(false);
  expect(existsSync(marker)).toBe(false);
});

it("derives the package set from the actual fixture instead of returning a constant", async () => {
  const root = fixture();
  const entry = join(root, "entry.js");
  writeFileSync(entry, 'import "different-scan-fixture";\n');
  expect(await findRunnerExternalPackages([entry])).toEqual(new Set(["different-scan-fixture"]));
});
