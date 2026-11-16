import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("./myrmidon/ci/run-script-tests.sh", import.meta.url));

test("script lane executes root Myrmidon tests and existing nested tests only", () => {
  const root = mkdtempSync(join(tmpdir(), "myrmidon-script-discovery-"));
  try {
    mkdirSync(join(root, "scripts/myrmidon/nested"), { recursive: true });
    const fixture = (name, marker) => writeFileSync(join(root, name),
      `import { appendFileSync } from 'node:fs';\nimport { test } from 'node:test';\ntest('${marker}', () => appendFileSync('executed', '${marker}\\n'));\n`);
    fixture("scripts/root.myrmidon.test.mjs", "root");
    fixture("scripts/myrmidon/nested/legacy.test.mjs", "legacy");
    fixture("scripts/ignored.test.mjs", "ignored");
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync("bash", [runner], { cwd: root, encoding: "utf8", env });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /root/, result.stdout + result.stderr);
    assert.deepEqual(readFileSync(join(root, "executed"), "utf8").trim().split("\n").sort(), ["legacy", "root"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
