import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const source = fileURLToPath(new URL("./release-package-map.mjs", import.meta.url));
const version = "2026.11.17-rc.1";

test("set-version rewrites workspace specs in all dependency sections and preserves other fields", () => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const root = realpathSync(mkdtempSync(join(scratch, "myrmidon-version-sections-")));
  const put = (path, data) => {
    const dest = join(root, path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, data);
  };
  const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
  try {
    const sections = ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"];
    const inputDeps = {
      "@myrmidon/star": "workspace:*",
      "@myrmidon/caret": "workspace:^",
      "@myrmidon/tilde": "workspace:~",
      "@myrmidon/pinned": "^1.2.3",
      "external-workspace": "workspace:*",
      "external-package": "~4.5.6",
    };
    const expectedDeps = {
      "@myrmidon/star": version,
      "@myrmidon/caret": version,
      "@myrmidon/tilde": version,
      "@myrmidon/pinned": "^1.2.3",
      "external-workspace": "workspace:*",
      "external-package": "~4.5.6",
    };
    const cli = {
      name: "myrmidon", version: "old", custom: { keep: [1, "two"] },
      scripts: { build: "node build.mjs" }, exports: { ".": "./dist/index.js" },
      ...Object.fromEntries(sections.map((section) => [section, inputDeps])),
    };
    const expected = { ...cli, version, ...Object.fromEntries(sections.map((section) => [section, expectedDeps])) };
    const names = ["star", "caret", "tilde"];
    const entries = [{ dir: "cli", name: "myrmidon", publishFromCi: true }, ...names.map((name) => ({
      dir: `packages/${name}`, name: `@myrmidon/${name}`, publishFromCi: true,
    }))];
    put("scripts/release-package-manifest.json", json(entries));
    copyFileSync(source, join(root, "scripts/release-package-map.mjs"));
    put("cli/package.json", json(cli));
    put("cli/src/index.ts", 'program.version("old");\n');
    for (const name of names) put(`packages/${name}/package.json`, json({ name: `@myrmidon/${name}`, version: "old", custom: true }));

    const result = spawnSync(process.execPath, [join(root, "scripts/release-package-map.mjs"), "set-version", version], { encoding: "utf8", timeout: 15_000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(readFileSync(join(root, "cli/package.json"), "utf8"), json(expected));
    assert.equal(readFileSync(join(root, "cli/src/index.ts"), "utf8"), `program.version("${version}");\n`);
    for (const name of names) {
      assert.equal(readFileSync(join(root, `packages/${name}/package.json`), "utf8"), json({ name: `@myrmidon/${name}`, version, custom: true }));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
