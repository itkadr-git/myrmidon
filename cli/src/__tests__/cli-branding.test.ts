import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import packageJson from "../../package.json" with { type: "json" };

it("publishes both CLI aliases to the same entrypoint", () => {
  expect(packageJson.name).toBe("myrmidon");
  expect(packageJson.bin).toEqual({
    myrmidon: "./dist/index.js",
    paperclipai: "./dist/index.js",
  });
});

it("prints a deprecation warning only for the legacy binary", () => {
  const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  expect(source).toContain('basename(process.argv[1] ?? "")');
  expect(source).toContain('replace(/\\.(cmd|exe)$/i, "") === "paperclipai"');
  expect(source).toContain("paperclipai is deprecated, use myrmidon");
});

it("runs the built entrypoint under both aliases and warns once only for paperclipai", () => {
  const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const testDir = mkdtempSync(resolve(cliRoot, ".cli-branding-"));
  const aliases = ["myrmidon", "paperclipai"] as const;
  try {
    execFileSync("pnpm", ["run", "build"], { cwd: cliRoot, stdio: "pipe" });
    for (const binary of aliases) {
      symlinkSync(resolve(cliRoot, "dist/index.js"), resolve(testDir, binary));
    }
    for (const [binary, expectedWarning] of [
      ["myrmidon", false],
      ["paperclipai", true],
    ] as const) {
      const result = spawnSync(resolve(testDir, binary), ["--help"], {
        encoding: "utf8",
        cwd: resolve(cliRoot, ".."),
        env: { ...process.env, PAPERCLIP_CONFIG_PATH: "/dev/null" },
      });

      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("Usage: myrmidon");
      const warnings = result.stderr.match(/paperclipai is deprecated, use myrmidon/g) ?? [];
      expect(warnings).toHaveLength(expectedWarning ? 1 : 0);
    }
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});
