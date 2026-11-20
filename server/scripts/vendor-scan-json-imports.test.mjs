import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findRunnerExternalPackages } from "./verify-runner-vendor-dependencies.mjs";

let fixtureDir;

function fixture() {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  fixtureDir = mkdtempSync(join(scratch, "vendor-scan-json-"));
  return (name, content) => {
    const path = join(fixtureDir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    return path;
  };
}

afterEach(() => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  fixtureDir = undefined;
});

describe("vendor dependency scan of JSON imports", () => {
  it("inlines multiple local JSON files while retaining the external package", async () => {
    const write = fixture();
    const entry = write("entry.mjs", `
      import "json-scan-control";
      import config from "./config.json";
      import nested from "./nested/data.json";
      import empty from "./empty.json";
      export const values = [config, nested, empty];
    `);
    write("config.json", '{"name":"example"}');
    write("nested/data.json", '{"items":[1,2]}');
    write("empty.json", '{}');

    await expect(findRunnerExternalPackages([entry])).resolves.toEqual(new Set(["json-scan-control"]));
  });

  it("rejects malformed JSON and restores the same package set after repair", async () => {
    const write = fixture();
    const entry = write("entry.mjs", `
      import "json-scan-control";
      import data from "./nested/data.json";
      export const value = data;
    `);
    write("nested/data.json", '{"broken":');
    await expect(findRunnerExternalPackages([entry])).rejects.toThrow();

    write("nested/data.json", '{"fixed":true}');
    await expect(findRunnerExternalPackages([entry])).resolves.toEqual(new Set(["json-scan-control"]));
  });
});
