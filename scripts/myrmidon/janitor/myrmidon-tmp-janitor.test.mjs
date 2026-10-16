import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JANITOR = path.join(HERE, "myrmidon-tmp-janitor.sh");

const cleanups = new Set();

afterEach(() => {
  for (const dir of cleanups) {
    try {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch {}
  }
  cleanups.clear();
});

function makeTestSandbox() {
  const scratchRoot = process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || os.tmpdir();
  const dir = fs.mkdtempSync(path.join(scratchRoot, "janitor-test-"));
  cleanups.add(dir);
  return dir;
}

function runJanitor(args = [], env = {}) {
  const cleanEnv = { ...process.env };
  delete cleanEnv.BASH_ENV;
  delete cleanEnv.ENV;
  return spawnSync("bash", [JANITOR, ...args], {
    encoding: "utf8",
    env: {
      ...cleanEnv,
      ...env,
    },
  });
}

function setOldMtime(targetPath, minutesAgo = 120) {
  const past = new Date(Date.now() - minutesAgo * 60 * 1000);
  fs.utimesSync(targetPath, past, past);
}

describe("tmp-janitor", () => {
  it("shows usage with --help", () => {
    const res = runJanitor(["--help"]);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /Usage: myrmidon-tmp-janitor\.sh/);
  });

  it("cleans up whitelisted entries older than TTL", () => {
    const sandbox = makeTestSandbox();

    // Create old whitelisted entries
    const oldChr = path.join(sandbox, "chr-old-profile");
    const oldNative = path.join(sandbox, "native-old-session");
    const oldMdep = path.join(sandbox, "mdep-old-artifact");
    const oldInstall = path.join(sandbox, "myrmidon-install-test-old");

    fs.mkdirSync(oldChr);
    fs.mkdirSync(oldNative);
    fs.mkdirSync(oldMdep);
    fs.mkdirSync(oldInstall);

    setOldMtime(oldChr, 120);
    setOldMtime(oldNative, 120);
    setOldMtime(oldMdep, 120);
    setOldMtime(oldInstall, 120);

    const res = runJanitor(["--target", sandbox, "--ttl-minutes", "60"]);
    assert.equal(res.status, 0, res.stderr);

    assert.ok(!fs.existsSync(oldChr), "chr-* older than TTL should be deleted");
    assert.ok(!fs.existsSync(oldNative), "native-* older than TTL should be deleted");
    assert.ok(!fs.existsSync(oldMdep), "mdep-* older than TTL should be deleted");
    assert.ok(!fs.existsSync(oldInstall), "myrmidon-install-test-* older than TTL should be deleted");
    assert.match(res.stdout, /Removed: .*chr-old-profile/);
    assert.match(res.stdout, /cleaned: 4/);
  });

  it("preserves whitelisted entries younger than TTL", () => {
    const sandbox = makeTestSandbox();

    const youngChr = path.join(sandbox, "chr-young-profile");
    const youngNative = path.join(sandbox, "native-young-session");

    fs.mkdirSync(youngChr);
    fs.mkdirSync(youngNative);

    // Mtime is fresh (now)
    const res = runJanitor(["--target", sandbox, "--ttl-minutes", "60"]);
    assert.equal(res.status, 0, res.stderr);

    assert.ok(fs.existsSync(youngChr), "young chr-* profile must be preserved");
    assert.ok(fs.existsSync(youngNative), "young native-* session must be preserved");
    assert.match(res.stdout, /skipped young: 2/);
  });

  it("strictly protects claude-1002 and other live profiles even if older than TTL", () => {
    const sandbox = makeTestSandbox();

    const claude1002 = path.join(sandbox, "claude-1002");
    const claudeLive = path.join(sandbox, "claude-live-profile");

    fs.mkdirSync(claude1002);
    fs.mkdirSync(claudeLive);

    setOldMtime(claude1002, 1440); // 24 hours old
    setOldMtime(claudeLive, 1440);

    const res = runJanitor(["--target", sandbox, "--ttl-minutes", "60"]);
    assert.equal(res.status, 0, res.stderr);

    assert.ok(fs.existsSync(claude1002), "claude-1002 must NEVER be deleted");
    assert.ok(fs.existsSync(claudeLive), "claude-* live profiles must NEVER be deleted");
    assert.match(res.stdout, /cleaned: 0/);
  });

  it("ignores non-whitelisted files and directories", () => {
    const sandbox = makeTestSandbox();

    const regularFile = path.join(sandbox, "random-file.txt");
    const regularDir = path.join(sandbox, "important-dir");

    fs.writeFileSync(regularFile, "important data");
    fs.mkdirSync(regularDir);

    setOldMtime(regularFile, 120);
    setOldMtime(regularDir, 120);

    const res = runJanitor(["--target", sandbox, "--ttl-minutes", "60"]);
    assert.equal(res.status, 0, res.stderr);

    assert.ok(fs.existsSync(regularFile), "non-whitelisted file must be preserved");
    assert.ok(fs.existsSync(regularDir), "non-whitelisted dir must be preserved");
    assert.match(res.stdout, /cleaned: 0/);
  });

  it("dry-run logs actions without actually deleting files", () => {
    const sandbox = makeTestSandbox();

    const oldChr = path.join(sandbox, "chr-dry-profile");
    fs.mkdirSync(oldChr);
    setOldMtime(oldChr, 120);

    const res = runJanitor(["--target", sandbox, "--ttl-minutes", "60", "--dry-run"]);
    assert.equal(res.status, 0, res.stderr);

    assert.ok(fs.existsSync(oldChr), "dry-run must not delete candidate");
    assert.match(res.stdout, /\[DRY-RUN\] Would remove: .*chr-dry-profile/);
  });
});
