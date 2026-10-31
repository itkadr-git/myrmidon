import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  countPacks,
  formatBytes,
  getDirSizeBytes,
  hasLockFile,
  repackAllBases,
  repackRepo,
  shouldRepack,
  MARKER_FILE,
} from "../../../docker/bot-runtime/botd/lib/repack.js";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "myr-repack-test-"));
}

describe("botd repack: git-base optimization (OPE-10039)", () => {
  it("formats bytes into human readable sizes", () => {
    assert.equal(formatBytes(500), "500 B");
    assert.equal(formatBytes(2048), "2.0 KB");
    assert.equal(formatBytes(10 * 1024 * 1024), "10.0 MB");
    assert.equal(formatBytes(2 * 1024 * 1024 * 1024), "2.00 GB");
  });

  it("counts packs in objects/pack", () => {
    const dir = makeTempDir();
    const packDir = path.join(dir, "objects", "pack");
    fs.mkdirSync(packDir, { recursive: true });
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(packDir, `pack-${i}.pack`), "data");
      fs.writeFileSync(path.join(packDir, `pack-${i}.idx`), "idx");
    }
    assert.equal(countPacks(dir), 5);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("detects lock files in repo root and objects/pack and refs", () => {
    const dir = makeTempDir();
    const packDir = path.join(dir, "objects", "pack");
    const refsDir = path.join(dir, "refs", "heads");
    fs.mkdirSync(packDir, { recursive: true });
    fs.mkdirSync(refsDir, { recursive: true });

    assert.equal(hasLockFile(dir), false);

    // Lock in root
    const rootLock = path.join(dir, "config.lock");
    fs.writeFileSync(rootLock, "");
    assert.equal(hasLockFile(dir), true);
    fs.unlinkSync(rootLock);
    assert.equal(hasLockFile(dir), false);

    // Lock in pack dir
    const packLock = path.join(packDir, "pack-1.lock");
    fs.writeFileSync(packLock, "");
    assert.equal(hasLockFile(dir), true);
    fs.unlinkSync(packLock);
    assert.equal(hasLockFile(dir), false);

    // Lock in refs
    const refLock = path.join(refsDir, "main.lock");
    fs.writeFileSync(refLock, "");
    assert.equal(hasLockFile(dir), true);
    fs.unlinkSync(refLock);
    assert.equal(hasLockFile(dir), false);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("shouldRepack returns true if packs > 20 even if recently repacked", () => {
    const dir = makeTempDir();
    const packDir = path.join(dir, "objects", "pack");
    fs.mkdirSync(packDir, { recursive: true });
    for (let i = 0; i < 25; i++) {
      fs.writeFileSync(path.join(packDir, `pack-${i}.pack`), "pack");
    }
    const marker = path.join(dir, MARKER_FILE);
    fs.writeFileSync(marker, ""); // fresh marker

    const decision = shouldRepack(dir, { maxPacks: 20 });
    assert.equal(decision.should, true);
    assert.equal(decision.reason, "pack-count");
    assert.equal(decision.packs, 25);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("shouldRepack returns true on schedule (>= 24h) or when marker missing", () => {
    const dir = makeTempDir();
    const packDir = path.join(dir, "objects", "pack");
    fs.mkdirSync(packDir, { recursive: true });
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(packDir, `pack-${i}.pack`), "pack");
    }

    // No marker
    let decision = shouldRepack(dir, { maxPacks: 20 });
    assert.equal(decision.should, true);
    assert.equal(decision.reason, "schedule");

    // Fresh marker
    const marker = path.join(dir, MARKER_FILE);
    const now = Date.now();
    fs.writeFileSync(marker, "");
    fs.utimesSync(marker, new Date(now), new Date(now));

    decision = shouldRepack(dir, { now, maxPacks: 20 });
    assert.equal(decision.should, false);
    assert.equal(decision.reason, "recent");

    // Stale marker (> 24h)
    const staleTime = now - (25 * 3600 * 1000);
    fs.utimesSync(marker, new Date(staleTime), new Date(staleTime));

    decision = shouldRepack(dir, { now, maxPacks: 20 });
    assert.equal(decision.should, true);
    assert.equal(decision.reason, "schedule");

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("repackRepo skips if lock file is present", async () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "packed-refs.lock"), "");
    const logs = [];
    const res = await repackRepo(dir, {
      log: (l) => logs.push(l),
    });
    assert.equal(res.ok, false);
    assert.equal(res.skipped, true);
    assert.equal(res.reason, "locked");
    assert.ok(logs.some((l) => l.includes("lock file present")));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("repackRepo executes git repack and git prune, updating marker and logging sizes", async () => {
    const dir = makeTempDir();
    const packDir = path.join(dir, "objects", "pack");
    fs.mkdirSync(packDir, { recursive: true });
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(path.join(packDir, `pack-${i}.pack`), "0123456789");
    }

    const st = fs.statSync(dir);
    const commands = [];
    const runCmd = async (bin, args, opts) => {
      commands.push({ bin, args, opts });
      if (args.includes("repack")) {
        // simulate repacking 3 packs into 1
        for (let i = 0; i < 3; i++) {
          try { fs.unlinkSync(path.join(packDir, `pack-${i}.pack`)); } catch {}
        }
        fs.writeFileSync(path.join(packDir, "pack-combined.pack"), "0123456789");
      }
      return { code: 0, stdout: "", stderr: "" };
    };

    const logs = [];
    const res = await repackRepo(dir, {
      runCmd,
      log: (l) => logs.push(l),
    });

    assert.equal(res.ok, true);
    assert.equal(res.packsBefore, 3);
    assert.equal(res.packsAfter, 1);
    assert.equal(commands.length, 2);
    assert.deepEqual(commands[0].args, ["-C", dir, "repack", "-A", "-d"]);
    assert.equal(commands[0].opts.uid, st.uid);
    assert.equal(commands[0].opts.gid, st.gid);
    assert.deepEqual(commands[1].args, ["-C", dir, "prune", "--expire=2.weeks"]);
    assert.equal(commands[1].opts.uid, st.uid);
    assert.equal(commands[1].opts.gid, st.gid);
    assert.ok(fs.existsSync(path.join(dir, MARKER_FILE)));
    assert.ok(logs.some((l) => l.includes("repacked") && l.includes("packs 3 -> 1")));

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("repackRepo passes repository owner uid and gid credentials to git repack and prune", async () => {
    const dir = makeTempDir();
    const commands = [];
    const runCmd = async (bin, args, opts) => {
      commands.push({ bin, args, opts });
      return { code: 0, stdout: "", stderr: "" };
    };

    const res = await repackRepo(dir, { runCmd, uid: 2001, gid: 2002 });
    assert.equal(res.ok, true);
    assert.equal(commands.length, 2);

    assert.ok(commands[0].args.includes("repack"));
    assert.equal(commands[0].opts.uid, 2001);
    assert.equal(commands[0].opts.gid, 2002);

    assert.ok(commands[1].args.includes("prune"));
    assert.equal(commands[1].opts.uid, 2001);
    assert.equal(commands[1].opts.gid, 2002);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("repackAllBases scans repositories under baseDir and repacks when needed", async () => {
    const baseDir = makeTempDir();
    const repo1 = path.join(baseDir, "owner1", "repo1.git");
    const repo2 = path.join(baseDir, "owner2", "repo2.git");
    fs.mkdirSync(path.join(repo1, "objects", "pack"), { recursive: true });
    fs.mkdirSync(path.join(repo2, "objects", "pack"), { recursive: true });

    // repo1 has 25 packs (> 20 threshold)
    for (let i = 0; i < 25; i++) {
      fs.writeFileSync(path.join(repo1, "objects", "pack", `p-${i}.pack`), "p");
    }
    // repo2 has fresh marker and only 2 packs
    for (let i = 0; i < 2; i++) {
      fs.writeFileSync(path.join(repo2, "objects", "pack", `p-${i}.pack`), "p");
    }
    fs.writeFileSync(path.join(repo2, MARKER_FILE), "");

    const runCmd = async () => ({ code: 0, stdout: "", stderr: "" });
    const logs = [];
    const results = await repackAllBases(baseDir, {
      runCmd,
      log: (l) => logs.push(l),
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].repo, "owner1/repo1.git");
    assert.equal(results[0].packsBefore, 25);

    fs.rmSync(baseDir, { recursive: true, force: true });
  });
});
