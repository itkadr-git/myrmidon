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
// it here exercises the real shipped text.
//
// The shipped script hands the three mount points to uid 10001 with a real chown,
// which needs CAP_CHOWN. In production the helper has it (it runs as root with
// CapAdd CHOWN+FOWNER); a test process only has it when it IS root. So the
// behavioural run keeps every chmod line byte-identical, and drops the chown lines
// when — and only when — this uid cannot chown (OPE-4844: hosted CI runners run as
// an unprivileged user, where `chown: Operation not permitted` under `set -eu`
// aborted the script before its root chmod). The ownership handover stays pinned
// by the static text assertion below, and where the process IS root the run is
// byte-exact and its observed uid change is asserted too.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const PREPARE_SH = path.join(ROOT, "tools/dockergate/contract/testdata/scripts/prepare.sh");
const PREPARE_SHARED_SH = path.join(ROOT, "tools/dockergate/contract/testdata/scripts/prepare-shared.sh");

const AM_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

/** True if this process can hand files to uid 10001, as the shipped script does
 *  (`chown 10001:10001`). Setting another uid needs CAP_CHOWN unless it is our own
 *  uid — the probe is the exact operation, on a throwaway file we own. */
function canChown(dir) {
  if (AM_ROOT) return true;
  try {
    const probe = path.join(dir, ".chown-probe");
    fs.writeFileSync(probe, "");
    fs.chownSync(probe, 10001, 10001);
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** A helper-container root: the bind mount points under one directory. */
function helperRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myrmidon-prepare-root-"));
  for (const d of ["data/hermes", "workspace", "scratch", "bot", "scope"]) fs.mkdirSync(path.join(dir, d), { recursive: true });
  return dir;
}

/**
 * Run the shipped script against `dir`. Where chown is available this is the
 * byte-exact script; where it is not, the chmod-only projection (every line kept
 * except the `chown` ones, order untouched) so the traversal behaviour — the
 * subject of this test — is still exercised on unprivileged runners.
 */
function runPrepare(scriptFile, dir) {
  const text = fs.readFileSync(scriptFile, "utf8");
  if (canChown(dir)) return { result: runScript(text, dir, scriptFile), chowned: true };
  const projected = text
    .split("\n")
    .filter((line) => !line.trim().startsWith("chown "))
    .join("\n");
  return { result: runScript(projected, dir, `${path.basename(scriptFile)} (chmod projection)`), chowned: false };
}

function runScript(scriptText, dir, _label) {
  const file = fs.mkdtempSync(path.join(os.tmpdir(), "myrmidon-prepare-run-"));
  const script = path.join(file, "run.sh");
  fs.writeFileSync(script, scriptText, { mode: 0o644 });
  try {
    return spawnSync("sh", [script, dir], { encoding: "utf8", timeout: 10_000 });
  } finally {
    fs.rmSync(file, { recursive: true, force: true });
  }
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
      // Under root that premise is unobservable: CAP_DAC_OVERRIDE walks through the
      // mode, so assert the untraversable mode itself — the bit the bot uid sees —
      // and let the script's real chmod fix it byte-exactly as in production.
      if (AM_ROOT) {
        assert.equal(mode(path.join(dir, "bot")), "400");
      } else {
        assert.throws(() => fs.statSync(sentinel), /EACCES/);
      }
      const { result, chowned } = runPrepare(PREPARE_SH, dir);
      assert.equal(result.status, 0, result.stderr);
      // Traversal restored, content intact and never written into. 0711: group and
      // "other" get x without r (enter, cannot browse); only the owner (root on the
      // host; this temp dir's owner here) keeps r.
      assert.equal(mode(path.join(dir, "bot")), "711");
      assert.equal(fs.readFileSync(sentinel, "utf8"), "data");
      assert.equal(fs.readFileSync(path.join(dir, "bot", "sentinel.bin"), "utf8"), "data");
      // The three mount points get mode 0700 as before...
      for (const d of ["data/hermes", "workspace", "scratch"]) assert.equal(mode(path.join(dir, d)), "700");
      // ...and, where the helper can chown as it does in production (root in the
      // container), they are handed to the bot's uid.
      if (chowned) {
        for (const d of ["data/hermes", "workspace", "scratch"]) assert.equal(fs.statSync(path.join(dir, d)).uid, 10001);
      }
    } finally {
      fs.chmodSync(path.join(dir, "bot"), 0o755);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is idempotent: running it twice leaves the same modes", () => {
    const dir = helperRoot();
    try {
      fs.chmodSync(path.join(dir, "bot"), 0o711);
      const first = runPrepare(PREPARE_SH, dir);
      assert.equal(first.result.status, 0, first.result.stderr);
      const before = mode(path.join(dir, "bot"));
      const second = runPrepare(PREPARE_SH, dir);
      assert.equal(second.result.status, 0, second.result.stderr);
      assert.equal(mode(path.join(dir, "bot")), before);
      assert.equal(before, "711");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to be a vector into the content: it never opens a path below the root", () => {
    // The script is constant text: no recursion flag, no link option, no find/glob,
    // and the root statement is a single chmod on the mount point. The package-cache
    // block (1.6.5-BOT-DISK-UV-B board side) follows it and is a fixed list of
    // `install -d` lines — still constant, still no recursion — under a `test -d`
    // guard so a bot without the cache bind is untouched.
    const script = fs.readFileSync(PREPARE_SH, "utf8");
    assert.doesNotMatch(script, / -R| -L| -H|find|xargs|\*|\?|`|\$\(/);
    const lines = script.trimEnd().split("\n");
    const rootIdx = lines.indexOf("chmod 0711 bot");
    assert.notEqual(rootIdx, -1, "the root statement is present");
    const cacheBlock = lines.slice(rootIdx + 1);
    assert.equal(cacheBlock[0], "if test -d package-cache; then");
    assert.equal(cacheBlock.at(-1), "fi");
    const installs = cacheBlock.slice(1, -1);
    assert.equal(installs.length, 6); // the PACKAGE_CACHE_MOUNTS list
    for (const line of installs) {
      assert.match(line, /^  install -d -o 10001 -g 10001 "package-cache\/[a-z-]+"$/);
    }
    // The ownership handover the behavioural run may not execute everywhere:
    // exactly one non-recursive chown of the three mount points to the bot's uid.
    assert.match(script, /^  chown 10001:10001 "\$d"$/m);
    assert.equal(script.split("\n").filter((l) => l.trim().startsWith("chown ")).length, 1);
  });

  it("the shared layout does not touch a /bot path: the instance directory it chowns is already entered by uid 10001", () => {
    const shared = fs.readFileSync(PREPARE_SHARED_SH, "utf8");
    assert.doesNotMatch(shared, /chmod 0711/);
    assert.match(shared, /for d in data\/hermes workspace scratch scope; do/);
    // Behaviour: the instance directory ("scope") ends up 0700 — enterable by every
    // member of the instance, which all run as the same uid, and the script hands it
    // to that uid where chown is available (root in production, this run when root).
    const dir = helperRoot();
    try {
      fs.chmodSync(path.join(dir, "scope"), 0o400); // unreachable before
      const { result, chowned } = runPrepare(PREPARE_SHARED_SH, dir);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(mode(path.join(dir, "scope")), "700");
      if (chowned) assert.equal(fs.statSync(path.join(dir, "scope")).uid, 10001);
    } finally {
      fs.chmodSync(path.join(dir, "scope"), 0o755);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
