import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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

  it("rejects non-numeric, zero, or negative --ttl-minutes", () => {
    const sandbox = makeTestSandbox();
    for (const invalidTtl of ["0", "-10", "abc", "00"]) {
      const res = runJanitor(["--target", sandbox, "--ttl-minutes", invalidTtl]);
      assert.notEqual(res.status, 0, `Expected error status for TTL ${invalidTtl}`);
      assert.match(res.stderr || res.stdout, /Invalid TTL_MINUTES/);
    }
  });

  it("recursively detects open files in subdirectories and preserves active candidate", async () => {
    const sandbox = makeTestSandbox();
    const activeDir = path.join(sandbox, "chr-active-profile");
    const subDir = path.join(activeDir, "Default", "Storage");
    fs.mkdirSync(subDir, { recursive: true });
    const lockFile = path.join(subDir, "session.lock");
    fs.writeFileSync(lockFile, "lock");
    setOldMtime(activeDir, 120);

    // Keep lockFile open in a child process with deterministic readiness handshake
    const holder = spawn(
      process.execPath,
      [
        "-e",
        "const fs = require('fs'); const fd = fs.openSync(process.argv[1], 'r'); process.stdout.write('OPENED\\n'); setInterval(() => {}, 1000);",
        lockFile,
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    let holderStderr = "";
    holder.stderr.on("data", (chunk) => {
      holderStderr += chunk;
    });

    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timeout waiting for child process to open file")), 5000);
        holder.stdout.once("data", () => {
          clearTimeout(timer);
          resolve();
        });
        holder.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
        holder.on("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`Child process exited prematurely with code ${code}: ${holderStderr}`));
        });
      });

      const resActive = runJanitor(["--target", sandbox, "--ttl-minutes", "60"]);
      assert.equal(resActive.status, 0, resActive.stderr);
      assert.ok(fs.existsSync(activeDir), "active profile with open file in subfolder must not be deleted");
      assert.match(resActive.stdout, /skipped active: 1/);
    } finally {
      holder.kill();
      await new Promise((resolve) => {
        if (holder.exitCode !== null) return resolve();
        holder.on("exit", resolve);
        setTimeout(resolve, 1000);
      });
    }

    const resClean = runJanitor(["--target", sandbox, "--ttl-minutes", "60"]);
    assert.equal(resClean.status, 0, resClean.stderr);
    assert.ok(!fs.existsSync(activeDir), "profile should be cleaned up after process terminates");
    assert.match(resClean.stdout, /cleaned: 1/);
  });

  it("detects active process with cwd inside candidate directory and preserves it", async () => {
    const sandbox = makeTestSandbox();
    const activeDir = path.join(sandbox, "native-active-session");
    const subDir = path.join(activeDir, "workspace");
    fs.mkdirSync(subDir, { recursive: true });
    setOldMtime(activeDir, 120);

    const holder = spawn(
      process.execPath,
      ["-e", "process.stdout.write('READY\\n'); setInterval(() => {}, 1000);"],
      {
        cwd: subDir,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    let holderStderr = "";
    holder.stderr.on("data", (chunk) => {
      holderStderr += chunk;
    });

    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timeout waiting for child process to start")), 5000);
        holder.stdout.once("data", () => {
          clearTimeout(timer);
          resolve();
        });
        holder.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
        holder.on("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`Child process exited prematurely with code ${code}: ${holderStderr}`));
        });
      });

      const resActive = runJanitor(["--target", sandbox, "--ttl-minutes", "60"]);
      assert.equal(resActive.status, 0, resActive.stderr);
      assert.ok(fs.existsSync(activeDir), "session directory with active process cwd must not be deleted");
      assert.match(resActive.stdout, /skipped active: 1/);
    } finally {
      holder.kill();
      await new Promise((resolve) => {
        if (holder.exitCode !== null) return resolve();
        holder.on("exit", resolve);
        setTimeout(resolve, 1000);
      });
    }

    const resClean = runJanitor(["--target", sandbox, "--ttl-minutes", "60"]);
    assert.equal(resClean.status, 0, resClean.stderr);
    assert.ok(!fs.existsSync(activeDir), "session directory should be cleaned up after process terminates");
    assert.match(resClean.stdout, /cleaned: 1/);
  });

  it("fails closed when process inspection is unavailable or fails", () => {
    const sandbox = makeTestSandbox();
    const candidate = path.join(sandbox, "chr-failclosed-profile");
    fs.mkdirSync(candidate);
    setOldMtime(candidate, 120);

    const res = runJanitor(["--target", sandbox, "--ttl-minutes", "60"], {
      MYRMIDON_JANITOR_FORCE_INSPECTION_UNAVAILABLE: "1",
    });
    assert.equal(res.status, 0, res.stderr);
    assert.ok(fs.existsSync(candidate), "candidate must be preserved when process inspection is unavailable (fail-closed)");
    assert.match(res.stdout, /skipped active: 1/);
    assert.match(res.stdout, /cleaned: 0/);
  });
});
