import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { vitestProjectDirs } from "./affected-tests.mjs";

const scratch = process.env.MYRMIDON_RUN_SCRATCH_DIR
  || process.env.PAPERCLIP_RUN_SCRATCH_DIR
  || path.join(os.homedir(), ".myrmidon-test-scratch");

function fixture(t, config) {
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, "affected-project-dirs-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  if (config !== undefined) fs.writeFileSync(path.join(root, "vitest.config.ts"), config);
  return root;
}

const cases = [
  ["double quoted project", 'projects: ["server"]', ["server"]],
  ["single quoted project", "projects: ['ui']", ["ui"]],
  ["mixed quotes", `projects: ["server", 'ui']`, ["server", "ui"]],
  ["multiline whitespace", `projects: [\n  "server",\n\t'ui',\n]`, ["server", "ui"]],
  ["empty list", "projects: []", []],
  ["nested package paths", `projects: ["packages/shared", 'packages/plugins/alpha']`, ["packages/shared", "packages/plugins/alpha"]],
  ["preserves order", `projects: ["ui", "server", "packages/db"]`, ["ui", "server", "packages/db"]],
  ["preserves duplicates", `projects: ["server", "ui", "server"]`, ["server", "ui", "server"]],
  ["ignores unrelated configuration before projects", `export default { name: "not-a-project", test: { projects: ['server'] } }`, ["server"]],
  ["ignores strings after closing bracket", `projects: ["server"], name: "not-a-project"`, ["server"]],
  ["empty list ignores later strings", `projects: [], name: 'not-a-project'`, []],
  ["trailing comma", `projects: ["packages/db",]`, ["packages/db"]],
];

describe("vitest project directories", () => {
  for (const [name, config, expected] of cases) {
    it(name, (t) => {
      assert.deepEqual(vitestProjectDirs(fixture(t, config)), expected);
    });
  }

  it("throws ENOENT when the configuration file is missing", (t) => {
    assert.throws(() => vitestProjectDirs(fixture(t)), { code: "ENOENT" });
  });
});
