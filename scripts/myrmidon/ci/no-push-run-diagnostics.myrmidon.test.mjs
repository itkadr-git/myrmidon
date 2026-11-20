import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ALLOW_MARKER, runCheck } from "../../check-no-git-push.mjs";

function fixture(t) {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || path.join(os.homedir(), "cache/scratch");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(path.join(scratch, "no-push-diagnostics-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    write(relative, contents) {
      const file = path.join(root, relative);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, contents);
    },
  };
}

function check(root, scanRoots) {
  const logs = [];
  const errors = [];
  const code = runCheck({ repoRoot: root, scanRoots, log: (message) => logs.push(message), error: (message) => errors.push(message) });
  return { code, logs, errors };
}

test("reports every offense once across independent scan roots", (t) => {
  const { root, write } = fixture(t);
  write("alpha/src/a.ts", "const safe = 1;\nexec('git push origin alpha');\n\nexec('git push --tags');\n");
  write("beta/src/b.js", "execFile('git', ['push', 'origin']);\nconst safe = 2;\nconst alsoSafe = 3;\nspawn('git', ['push', '--mirror']);\n");
  write("alpha/src/safe.ts", "const action = 'git fetch';\n");
  write("alpha/dist/ignored.js", "exec('git push dist');\n");
  write("outside/not-scanned.js", "exec('git push outside');\n");

  const { code, logs, errors } = check(root, ["alpha", "beta"]);
  assert.equal(code, 1);
  assert.deepEqual(logs, []);
  assert.equal(errors.length, 7);
  const expected = [
    "  alpha/src/a.ts:2: exec('git push origin alpha');",
    "  alpha/src/a.ts:4: exec('git push --tags');",
    "  beta/src/b.js:1: execFile('git', ['push', 'origin']);",
    "  beta/src/b.js:4: spawn('git', ['push', '--mirror']);",
  ];
  assert.deepEqual(errors.slice(1, -2).sort(), expected.sort());
  assert.match(errors[0], /^ERROR:.*found in adapter\/runtime code:/);
  assert.match(errors.at(-2), /Adapter and runtime code must not push to a git remote/);
  assert.ok(errors.at(-1).includes(`${ALLOW_MARKER}: <reason>`));
  assert.match(errors.at(-1), /matching line or the line immediately above/);
});

test("safe and missing roots succeed without scanning unrequested roots", (t) => {
  const { root, write } = fixture(t);
  write("safe/index.ts", "const command = 'git fetch';\n");
  write("other/index.ts", "exec('git push origin main');\n");
  const { code, logs, errors } = check(root, ["safe", "missing"]);
  assert.equal(code, 0);
  assert.deepEqual(errors, []);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /No unapproved `git push` invocations found/);
});

test("an inline allow marker does not suppress the next offense", (t) => {
  const { root, write } = fixture(t);
  write("scoped/index.ts", `exec('git push allowed'); // ${ALLOW_MARKER}: configured\nconst safe = 1;\nexec('git push rejected');\n`);
  const { code, logs, errors } = check(root, ["scoped"]);
  assert.equal(code, 1);
  assert.deepEqual(logs, []);
  assert.equal(errors.length, 4);
  assert.equal(errors[1], "  scoped/index.ts:3: exec('git push rejected');");
});
