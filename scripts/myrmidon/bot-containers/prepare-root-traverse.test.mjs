import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// myrmidon(BOT-ROOT-TRAVERSE): the prepare helper must make the bot's root
// directory (the single bind mounted at /bot) traversable by the bot's uid, and
// must do it without ever entering, listing or rewriting the content behind it.
// The checked-in contract fixture tools/dockergate/contract/testdata/scripts/prepare.sh
// IS the script the driver generates (emit-fixtures.ts rewrites it from
// buildPrepareVolumesScript; CI diffs it, the Go gate byte-compares it), so running
// it here exercises the real shipped text. A root-owned 0710 host directory is
// unrepresentable without root, but an owner-unreachable 0400 directory fails the
// same traversal bit for the same code path, and the script never changes ownership.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const PREPARE_SH = path.join(ROOT, "tools/dockergate/contract/testdata/scripts/prepare.sh");
const PREPARE_SHARED_SH = path.join(ROOT, "tools/dockergate/contract/testdata/scripts/prepare-shared.sh");

/** A helper-container root: the bind mount points under one directory. */
function helperRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myrmidon-prepare-root-"));
  for (const d of ["data/hermes", "workspace", "scratch", "bot", "scope"]) fs.mkdirSync(path.join(dir, d), { recursive: true });
  return dir;
}

function runScript(script, dir) {
  return spawnSync("sh", [script, dir], { encoding: "utf8", timeout: 10_000 });
}

function mode(p) {
  return (fs.statSync(p).mode & 0o777).toString(8);
}

describe("prepare script: bot root traversal (BOT-ROOT-TRAVERSE)", () => {
  it("fixes a root that the bot's uid cannot enter, then hands it over — the rc.1 shape", () => {
    const dir = helperRoot();
    try {
      const sentinel = path.join(dir, "bot", "sentinel.bin");
      fs.writeFileSync(sentinel, "data");
      fs.chmodSync(path.join(dir, "bot"), 0o400); // readable but NOT executable: no traversal
      // Precondition for this uid: paths under the root resolve through it, so an
      // entry inside is unreachable — exactly the rc.1 symptom (EACCES through /bot).
      assert.throws(() => fs.statSync(sentinel), /EACCES/);
      const result = runScript(PREPARE_SH, dir);
      assert.equal(result.status, 0, result.stderr);
      // Traversal restored, content intact and never written into. 0711: group and
      // "other" get x without r (enter, cannot browse); only the owner (root on the
      // host; this temp dir's owner here) keeps r.
      assert.equal(mode(path.join(dir, "bot")), "711");
      assert.equal(fs.readFileSync(sentinel, "utf8"), "data");
      assert.equal(fs.readFileSync(path.join(dir, "bot", "sentinel.bin"), "utf8"), "data");
      // The three mount points are handed over as before.
      for (const d of ["data/hermes", "workspace", "scratch"]) assert.equal(mode(path.join(dir, d)), "700");
    } finally {
      fs.chmodSync(path.join(dir, "bot"), 0o755);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is idempotent: running it twice leaves the same modes", () => {
    const dir = helperRoot();
    try {
      fs.chmodSync(path.join(dir, "bot"), 0o711);
      assert.equal(runScript(PREPARE_SH, dir).status, 0);
      const first = mode(path.join(dir, "bot"));
      assert.equal(runScript(PREPARE_SH, dir).status, 0);
      assert.equal(mode(path.join(dir, "bot")), first);
      assert.equal(first, "711");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to be a vector into the content: it never opens a path below the root", () => {
    // The script is constant text: no recursion flag, no link option, no find/glob,
    // and its last (and only root) statement is a single chmod on the mount point.
    const script = fs.readFileSync(PREPARE_SH, "utf8");
    assert.doesNotMatch(script, / -R| -L| -H|find|xargs|\*|\?|`|\$\(/);
    const rootLine = script.trimEnd().split("\n").at(-1).trim();
    assert.equal(rootLine, "chmod 0711 bot");
    assert.equal(script.split("\n").length, 7); // set -eu, cd, for, chmod, chown, done, root chmod
  });

  it("the shared layout does not touch a /bot path: the instance directory it chowns is already entered by uid 10001", () => {
    const shared = fs.readFileSync(PREPARE_SHARED_SH, "utf8");
    assert.doesNotMatch(shared, /chmod 0711/);
    assert.match(shared, /for d in data\/hermes workspace scratch scope; do/);
    // Behaviour: the instance directory ("scope") ends up 0700 owned by this uid —
    // enterable by every member of the instance, which all run as the same uid.
    const dir = helperRoot(undefined);
    try {
      fs.mkdirSync(path.join(dir, "scope"), { recursive: true });
      fs.chmodSync(path.join(dir, "scope"), 0o400); // unreachable before
      const result = runScript(PREPARE_SHARED_SH, dir);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(mode(path.join(dir, "scope")), "700");
    } finally {
      fs.chmodSync(path.join(dir, "scope"), 0o755);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
