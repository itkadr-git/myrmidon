import assert from "node:assert/strict";
import { test } from "node:test";
import { extractNames, findNewNames, isScanned, main, parseBaseline } from "./paperclip-names-ratchet.mjs";

test("extracts every PAPERCLIP_ token with its line, including ones inside longer identifiers", () => {
  const text = 'const a = process.env.PAPERCLIP_API_URL;\nconst ORIGINAL_PAPERCLIP_HOME = 1; // PAPERCLIP_* prose\n';
  assert.deepEqual(extractNames(text), [
    { name: "PAPERCLIP_API_URL", line: 1 },
    { name: "PAPERCLIP_HOME", line: 2 },
  ]);
});

test("the baseline ignores comments and blank lines", () => {
  const baseline = parseBaseline("# vendor\nPAPERCLIP_API_URL\n\nPAPERCLIP_HOME  # kept\n");
  assert.deepEqual([...baseline], ["PAPERCLIP_API_URL", "PAPERCLIP_HOME"]);
});

test("a name outside the baseline fails with its locations; known names pass", () => {
  const baseline = parseBaseline("PAPERCLIP_API_URL\n");
  const fresh = findNewNames(
    [
      { path: "packages/adapters/x/src/a.ts", text: "env.PAPERCLIP_API_URL\nenv.PAPERCLIP_X_PROVIDERS\n" },
      { path: "server/src/b.ts", text: "readProductEnv(\"X_PROVIDERS\") // was PAPERCLIP_X_PROVIDERS\n" },
    ],
    baseline,
  );
  assert.deepEqual(fresh, [
    { name: "PAPERCLIP_X_PROVIDERS", places: ["packages/adapters/x/src/a.ts:2", "server/src/b.ts:1"] },
  ]);
  assert.deepEqual(findNewNames([{ path: "a.ts", text: "PAPERCLIP_API_URL" }], baseline), []);
});

test("documentation, lock files and the check's own files are not scanned", () => {
  assert.equal(isScanned("docs/myrmidon/SETTINGS.md"), false);
  assert.equal(isScanned("doc/runbooks/t9-center-standby.md"), false);
  assert.equal(isScanned("packages/adapters/hermes/skills/x/SKILL.md"), false);
  assert.equal(isScanned("pnpm-lock.yaml"), false);
  assert.equal(isScanned("scripts/myrmidon/ci/paperclip-names-baseline.txt"), false);
  assert.equal(isScanned("scripts/myrmidon/ci/paperclip-names-ratchet.test.mjs"), false);
  assert.equal(isScanned("docker/bot-runtime/github-broker/gh"), true);
  assert.equal(isScanned("docker/bot-runtime/patches/09-run-scoped-github-broker.patch"), true);
  assert.equal(isScanned("server/src/index.ts"), true);
});

test("the repository introduces no PAPERCLIP_* name outside the baseline", () => {
  assert.equal(main([]), 0, "new PAPERCLIP_* names: see the list above; name them MYRMIDON_*");
});
