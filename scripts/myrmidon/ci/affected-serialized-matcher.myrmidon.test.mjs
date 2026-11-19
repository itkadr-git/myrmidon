import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { serializedServerMatcher } from "./affected-tests.mjs";

function fixture(t, source) {
  const parent = process.env.MYRMIDON_RUN_SCRATCH_DIR || process.env.PAPERCLIP_RUN_SCRATCH_DIR || path.join(os.homedir(), "scratch");
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "serialized-matcher-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "scripts"));
  fs.writeFileSync(path.join(root, "scripts/run-vitest-stable.mjs"), source);
  return serializedServerMatcher(root);
}

const cases = [
  ["server/src/routes.test.ts", true],
  ["server/src/api/user-route.test.ts", true],
  ["server/src/myrmidon/a/routes.myrmidon.test.ts", true],
  ["server/src/__tests__/authz.test.ts", true],
  ["server/src/services/team-authz-policy.test.ts", true],
  ["server/src/routes/plain.test.ts", false],
  ["server/src/route/plain.test.ts", false],
  ["server/src/authz/plain.test.ts", false],
  ["server/src/routes.spec.ts", false],
  ["server/src/route.test.tsx", false],
  ["server/src/authz.test.ts.bak", false],
  ["server/src/routes.test.js", false],
  ["server/src/ordinary.test.ts", false],
  ["server/src/__tests__/listed.test.ts", true],
  ["server/src/other/listed.test.ts", false],
  ["server/src/__tests__/second.test.ts", true],
  ["server/src/__tests__/after.test.ts", false],
  ["server/src/__tests__/listed.spec.ts", false],
  ["server/src/__tests__/listed.test.ts.bak", false],
  ["server/src/ROUTES.test.ts", false],
];

for (const [file, expected] of cases) {
  test(`serialized matcher: ${file} -> ${expected}`, (t) => {
    const matches = fixture(t, `const additionalSerializedServerTests = new Set([
      "server/src/__tests__/listed.test.ts",
      "server/src/__tests__/second.test.ts",
    ]);
    const unrelated = "server/src/__tests__/after.test.ts";
    `);
    assert.equal(matches(file), expected);
  });
}

test("missing serialized list does not add plain tests", (t) => {
  const matches = fixture(t, 'const unrelated = "server/src/__tests__/listed.test.ts";');
  assert.equal(matches("server/src/__tests__/listed.test.ts"), false);
  assert.equal(matches("server/src/api/routes.test.ts"), true);
});

test("empty serialized list does not add subsequent entries", (t) => {
  const matches = fixture(t, `const additionalSerializedServerTests = new Set([]);
    const unrelated = "server/src/__tests__/listed.test.ts";`);
  assert.equal(matches("server/src/__tests__/listed.test.ts"), false);
  assert.equal(matches("server/src/api/authz.test.ts"), true);
});
