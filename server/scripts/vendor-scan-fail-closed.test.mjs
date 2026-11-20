import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findRunnerExternalPackages } from "./verify-runner-vendor-dependencies.mjs";

let fixtureDir;

function fixture() {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  fixtureDir = mkdtempSync(join(scratch, "vendor-scan-fail-closed-"));
  return (name, content) => {
    const path = join(fixtureDir, name);
    writeFileSync(path, content);
    return path;
  };
}

afterEach(() => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  fixtureDir = undefined;
});

describe("vendor dependency scan fails closed", () => {
  it("rejects a missing second entry and scans both entries after repair", async () => {
    const write = fixture();
    const first = write("first.js", 'export { default } from "first-marker";\n');
    const missing = join(fixtureDir, "second.js");
    await expect(findRunnerExternalPackages([first, missing])).rejects.toThrow(
      /expected build output at .*second\.js.*Run "pnpm --filter @myrmidon\/paperclip-runner build" first/s,
    );
    write("second.js", 'export { default } from "second-marker";\n');
    await expect(findRunnerExternalPackages([first, missing])).resolves.toEqual(
      new Set(["first-marker", "second-marker"]),
    );
  });

  it("rejects a missing reachable relative import and scans it after repair", async () => {
    const write = fixture();
    const entry = write("entry.js", 'export { default } from "./dependency.js";\n');
    await expect(findRunnerExternalPackages([entry])).rejects.toThrow();
    write("dependency.js", 'export { default } from "relative-marker";\n');
    await expect(findRunnerExternalPackages([entry])).resolves.toEqual(new Set(["relative-marker"]));
  });

  it("rejects invalid reachable JavaScript and scans it after repair", async () => {
    const write = fixture();
    const entry = write("entry.js", 'export { default } from "./dependency.js";\n');
    write("dependency.js", "export const broken = ;\n");
    await expect(findRunnerExternalPackages([entry])).rejects.toThrow();
    write("dependency.js", 'export { default } from "syntax-marker";\n');
    await expect(findRunnerExternalPackages([entry])).resolves.toEqual(new Set(["syntax-marker"]));
  });
});
