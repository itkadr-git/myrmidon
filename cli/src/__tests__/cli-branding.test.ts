import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import packageJson from "../../package.json" with { type: "json" };

it("publishes both CLI aliases to the same entrypoint", () => {
  expect(packageJson.name).toBe("myrmidon");
  expect(packageJson.bin).toEqual({
    myrmidon: "./dist/index.js",
    paperclipai: "./dist/index.js",
  });
});

it("prints a deprecation warning only for the legacy binary", async () => {
  const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  expect(source).toContain('basename(process.argv[1] ?? "")');
  expect(source).toContain('"paperclipai", "paperclipai.cmd", "index.js"');
  expect(source).toContain("paperclipai is deprecated, use myrmidon");
});