import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { main } from "./prod-runtime-exports.mjs";

const cases = [
  ["missing command", (root) => ["--root", root], /usage/i],
  ["unknown argument", (root) => ["apply", "--entry", "@test/entry", "--root", root, "--unknown"], /unknown argument.*--unknown/i],
  ["two commands", (root) => ["apply", "--entry", "@test/entry", "--root", root, "restore"], /duplicate command/i],
  ["repeated entry", (root) => ["apply", "--root", root, "--entry", "@test/entry", "--entry", "@test/entry"], /duplicate.*--entry/i],
  ["repeated root", (root) => ["restore", "--root", root, "--root", root], /duplicate.*--root/i],
  ["missing entry value", (root) => ["apply", "--root", root, "--entry"], /--entry.*requires a value/i],
  ["missing root value", () => ["restore", "--root"], /--root.*requires a value/i],
  ["option as entry value", (root) => ["apply", "--root", root, "--entry", "--dry-run"], /--entry.*requires a value/i],
  ["option as root value", () => ["restore", "--root", "--dry-run"], /--root.*requires a value/i],
  ["apply without entry", (root) => ["apply", "--root", root], /apply requires.*--entry/i],
  ["restore with entry", (root) => ["restore", "--root", root, "--entry", "@test/entry"], /restore takes no.*--entry/i],
];

for (const [name, args, diagnostic] of cases) {
  test(name, () => {
    const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
    const root = mkdtempSync(join(scratch, "runtime-cli-guards-"));
    try {
      const manifest = join(root, "packages", "dep", "package.json");
      const entry = join(root, "packages", "entry", "package.json");
      const backup = join(root, "node_modules", ".cache", "myrmidon-prod-exports", "backup.json");
      const write = (file, text) => {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, text);
      };
      write(join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
      write(entry, '{"name":"@test/entry","dependencies":{"@test/dep":"workspace:*"}}\n');
      write(manifest, '{"name":"@test/dep","exports":"./src/index.ts","publishConfig":{"exports":"./dist/index.js"}}\n');
      mkdirSync(join(root, "packages", "dep", "dist"));
      write(backup, JSON.stringify({ version: 1, packages: { "@test/dep": {
        packageFile: "packages/dep/package.json", originalText: '{"name":"restored"}\n',
        originalFields: {}, appliedFields: ["exports"],
      } } }) + "\n");
      const files = [entry, manifest, backup];
      const before = files.map((file) => readFileSync(file));
      const errors = [];
      let code;
      try {
        code = main(args(root), { log() {}, error: (message) => errors.push(String(message)) });
      } finally {
        for (const [index, file] of files.entries()) {
          assert.deepEqual(readFileSync(file), before[index], `${name}: ${file} changed`);
        }
      }
      assert.equal(code, 1);
      assert.match(errors.join("\n"), diagnostic);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
