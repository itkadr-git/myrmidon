import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findMissingVendorDependencies, findRunnerExternalPackages } from "./verify-runner-vendor-dependencies.mjs";

let fixtureDir;
afterEach(() => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  fixtureDir = undefined;
});

describe("vendor dependency difference", () => {
  it.each([
    ["empty sets", [], [], []],
    ["all declared", ["alpha", "beta"], ["alpha", "beta"], []],
    ["unrelated declaration", ["alpha", "beta"], ["alpha", "unrelated"], ["beta"]],
    ["reverse insertion order", ["zeta", "middle", "alpha"], [], ["alpha", "middle", "zeta"]],
    ["case and scoped names", ["Package", "package", "@scope/pkg", "@Scope/pkg"], ["package", "@scope/pkg"], ["@Scope/pkg", "Package"]],
  ])("handles %s without mutating either input", (_label, imports, declarations, expected) => {
    const imported = new Set(imports);
    const declared = new Set(declarations);
    const importedBefore = [...imported];
    const declaredBefore = [...declared];
    const result = findMissingVendorDependencies(imported, declared);
    expect(result).toEqual(expected);
    expect([...imported]).toEqual(importedBefore);
    expect([...declared]).toEqual(declaredBefore);
    result.push("contamination");
    expect(findMissingVendorDependencies(imported, declared)).toEqual(expected);
    expect([...imported]).toEqual(importedBefore);
    expect([...declared]).toEqual(declaredBefore);
  });

  it("updates the difference when a scanned external is declared and removed", async () => {
    const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
    fixtureDir = mkdtempSync(join(scratch, "vendor-difference-"));
    const entry = join(fixtureDir, "entry.js");
    writeFileSync(entry, 'export { default } from "vendor-difference-control";\n');
    const imported = await findRunnerExternalPackages([entry]);
    const declared = new Set(["unrelated"]);
    expect(imported).toEqual(new Set(["vendor-difference-control"]));
    expect(findMissingVendorDependencies(imported, declared)).toEqual(["vendor-difference-control"]);
    expect(imported).toEqual(new Set(["vendor-difference-control"]));
    expect(declared).toEqual(new Set(["unrelated"]));
    declared.add("vendor-difference-control");
    expect(findMissingVendorDependencies(imported, declared)).toEqual([]);
    expect(imported).toEqual(new Set(["vendor-difference-control"]));
    expect(declared).toEqual(new Set(["unrelated", "vendor-difference-control"]));
    declared.delete("vendor-difference-control");
    expect(findMissingVendorDependencies(imported, declared)).toEqual(["vendor-difference-control"]);
    expect(imported).toEqual(new Set(["vendor-difference-control"]));
    expect(declared).toEqual(new Set(["unrelated"]));
  });
});
