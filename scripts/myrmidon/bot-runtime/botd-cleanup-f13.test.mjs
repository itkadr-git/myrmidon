import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// myrmidon(1.6.5 BOT-DISK-H, F-13 part A): the cleanup policy of botd.
//   * ENOENT is success ("already gone") — in guardedRemove, verifyEntry, retain;
//   * EACCES/EPERM defers: nothing removed, one attention line per path per TTL
//     with the owner uid, never a chown;
//   * a failed `git bundle create` (anything but "empty bundle") falls back to a
//     verified `<base>.full.tar.zst` of the whole directory, which clears removal —
//     bounded: over the size cap or with no free space it is refused (ok:false)
//     and the directory stays;
//   * the rhythm cache: the same op on the same path runs at most once per hour,
//     keyed by path+op (a different op on the same path is a different decision);
//     a repeat inside the window is a silent skip; the pass ends with
//     `cleaned N, deferred M (...)`.
// Placeholder keys and repositories only.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const lib = (name) => path.join(ROOT, "docker/bot-runtime/botd/lib", name);
const { guardedRemove, inside } = await import(lib("remove.js"));
const { createAttention, createCooldown, DEFAULT_TTL_MS } = await import(lib("cache.js"));
const { archive, archiveTree, readManifest, retain, retainPass, verifyEntry, FULL_TAR_CAP_BYTES } = await import(lib("archive.js"));
const { createLoop } = await import(lib("loop.js"));
const { archiveThenRemove } = await import(lib("legacy.js"));

const KEY = "ABC-123";
let tmp;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "botd-f13-"));
});
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const git = (cwd, ...args) => {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const at = (iso) => new Date(iso);

/** A copy with one unpushed commit on a branch: the bundle would have real content. */
function makeRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const origin = path.join(dir, "origin.git");
  const copy = path.join(dir, "copy");
  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  git(dir, "clone", "-q", origin, copy);
  fs.writeFileSync(path.join(copy, "a.txt"), "one\n");
  git(copy, "add", ".");
  git(copy, "commit", "-qm", "base");
  git(copy, "push", "-q", "origin", "main");
  git(copy, "checkout", "-qb", `bot/${KEY}`);
  fs.writeFileSync(path.join(copy, "b.txt"), "unpushed\n");
  fs.writeFileSync(path.join(copy, "notes.md"), "scratch\n");
  git(copy, "add", "b.txt");
  git(copy, "commit", "-qm", "unpushed work");
  return { origin, copy };
}

describe("guardedRemove: ENOENT is success", () => {
  it("a vanished path returns 'already gone' instead of raising", () => {
    const gone = path.join(tmp, "already", "gone");
    assert.equal(guardedRemove(gone, [tmp]), "already gone");
    // once existed, removed, then removed again — the second call is the quiet one
    const dir = path.join(tmp, "existed");
    fs.mkdirSync(dir, { recursive: true });
    assert.equal(guardedRemove(dir, [tmp]), "removed");
    assert.equal(guardedRemove(dir, [tmp]), "already gone");
  });

  it("verifyEntry does not pass an archive whose files are all gone; retain still drops it silently", () => {
    const aRoot = path.join(tmp, "v-archive");
    const entry = { key: KEY, bundle: path.join(aRoot, `${KEY}-x.bundle`), createdAt: new Date().toISOString(), sizeBytes: 1 };
    // nothing on disk under aRoot: every file is gone. verifyEntry is the readability
    // re-check of an EXISTING archive — a fully gone one proves nothing and must not
    // pass a gate that could stand in front of a source-data removal.
    const v = verifyEntry(entry);
    assert.equal(v.ok, false);
    assert.match(v.reason, /archive files are gone/);
    // retain keeps the idempotent shortcut: "already gone" is the achieved end state there
    fs.mkdirSync(aRoot, { recursive: true });
    fs.writeFileSync(path.join(aRoot, "manifest.json"), JSON.stringify({ version: 1, archives: [entry] }));
    const r = retain(aRoot, { now: new Date(), maxAgeDays: 365, capBytes: 10_000_000_000 });
    assert.equal(r.ok, true, r.reason);
    assert.deepEqual(r.removed, []); // vanished entries are not "removed" — no error row
    assert.deepEqual(readManifest(aRoot).archives, []); // and they leave the manifest
  });

  it("a partially gone entry is still an error (in doubt: report, do not hide)", () => {
    const aRoot = path.join(tmp, "v-partial");
    fs.mkdirSync(aRoot, { recursive: true });
    const bundle = path.join(aRoot, "k.bundle");
    fs.writeFileSync(bundle, "x");
    const entry = { key: KEY, bundle, patch: path.join(aRoot, "k.patch"), createdAt: new Date().toISOString() };
    const r = verifyEntry(entry);
    assert.equal(r.ok, false);
    assert.match(r.reason, /is missing/);
  });

  it("guards are unchanged: links and outside-root paths are refused", () => {
    const outside = path.join(tmp, "target-dir");
    fs.mkdirSync(outside, { recursive: true });
    assert.throws(() => guardedRemove(outside, [path.join(tmp, "nope")]), /outside the allowed roots/);
    const link = path.join(tmp, "link");
    fs.symlinkSync(outside, link);
    assert.throws(() => guardedRemove(link, [tmp]), /symlink/);
    assert.ok(fs.existsSync(outside));
    assert.equal(inside(tmp, tmp), false);
  });
});

describe("guardedRemove: EACCES defers without deleting", () => {
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  it(
    "a path we have no permission on stays exactly where it is, error carries deferred+uid",
    { skip: isRoot ? "root ignores file permissions" : false },
    () => {
      const parent = path.join(tmp, "locked");
      const blocked = path.join(parent, "blockme");
      fs.mkdirSync(blocked, { recursive: true });
      fs.writeFileSync(path.join(blocked, "f.txt"), "kept\n");
      fs.chmodSync(blocked, 0o000);
      try {
        assert.throws(
          () => guardedRemove(blocked, [tmp]),
          (err) => err.deferred === "foreign-uid" && (err.code === "EACCES" || err.code === "EPERM") && err.uid === process.getuid(),
        );
        assert.ok(fs.existsSync(blocked), "the directory must survive a deferred removal");
      } finally {
        fs.chmodSync(blocked, 0o755);
      }
    }
  );

  it("attention fires once per path per TTL and repeats silently", () => {
    const file = path.join(tmp, "attention", "botd-attention.json");
    const logs = [];
    let clock = Date.parse("2026-10-08T12:00:00Z");
    const attention = createAttention(file, { now: () => new Date(clock), log: (l) => logs.push(l) });
    const p = "/workspace/ABC-777";
    assert.equal(attention.signal(p, { reason: "EACCES foreign-uid", uid: 4321 }), true);
    assert.equal(attention.signal(p, { reason: "EACCES foreign-uid", uid: 4321 }), false); // second pass: silent
    assert.equal(attention.signal(p, { reason: "EACCES foreign-uid", uid: 4321 }), false);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /attention: \/workspace\/ABC-777 deferred \(EACCES foreign-uid, uid 4321\)/);
    // the cache file holds {reason, uid, at} keyed by path
    const stored = JSON.parse(fs.readFileSync(file, "utf8"))[p];
    assert.deepEqual(Object.keys(stored).sort(), ["at", "reason", "uid"]);
    assert.equal(stored.uid, 4321);
    // a new failure reason is a new signal
    assert.equal(attention.signal(p, { reason: "EPERM foreign-uid", uid: 4321 }), true);
    // and the same reason fires again once the TTL passed (>= 1 h by default)
    clock += DEFAULT_TTL_MS + 1;
    assert.equal(attention.signal(p, { reason: "EACCES foreign-uid", uid: 4321 }), true);
    assert.ok(DEFAULT_TTL_MS >= 3_600_000);
  });

  it("a broken or unwritable attention cache never breaks the signal", () => {
    const file = path.join(tmp, "attention-broken", "botd-attention.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ not json");
    const logs = [];
    const attention = createAttention(file, { log: (l) => logs.push(l) });
    assert.equal(attention.signal("/workspace/ABC-1", { reason: "EACCES", uid: 7 }), true);
    assert.equal(logs.length, 1);
  });
});

describe("archive(): failed bundle falls back to a verified full tar", () => {
  // A git shim that makes `git bundle create` fail with a real (non-"empty") error
  // and forwards everything else to the real git.
  const bundleFailShim = (dir) => {
    const fake = path.join(dir, "git-fail-bundle");
    fs.writeFileSync(
      fake,
      '#!/bin/sh\nfor arg in "$@"; do case "$arg" in create) shift 0;; esac; done\ncase " $* " in\n  *" bundle create "*) echo "fatal: pack has a corrupted entry" >&2; exit 128;;\nesac\nexec git "$@"\n',
      { mode: 0o755 }
    );
    return fake;
  };

  it("bundle create failure (not 'empty bundle') => full.tar.zst + incompleteBundle + removal cleared", () => {
    const dir = path.join(tmp, "fb1");
    const { copy } = makeRepo(dir);
    const archiveRoot = path.join(dir, "archive");
    const r = archive(copy, KEY, { archiveRoot, gitBin: bundleFailShim(dir), now: at("2026-10-08T12:00:00Z") });
    assert.equal(r.ok, true, r.reason);
    const e = r.entry;
    assert.equal(e.incompleteBundle, true);
    assert.equal(e.bundle, undefined);
    assert.ok(e.fullTar.endsWith(".full.tar.zst"), e.fullTar);
    assert.ok(fs.existsSync(e.fullTar), "the fallback tar exists");
    // the tar passed `tar -tf` inside archive(); assert it really lists the work:
    const listing = spawnSync("tar", ["-tf", e.fullTar], { encoding: "utf8" }).stdout;
    assert.match(listing, /\.git/); // the repository itself is inside
    assert.match(listing, /notes\.md/); // and the untracked files
    assert.match(listing, /b\.txt/); // and the committed work
    // manifest records the entry
    assert.deepEqual(readManifest(archiveRoot).archives, [e]);
    // a verified full tar clears the removal (the policy of the fallback path)
    assert.equal(guardedRemove(copy, [dir]), "removed");
    assert.equal(fs.existsSync(copy), false);
  });

  it("the full tar counts in the retention quota", () => {
    const dir = path.join(tmp, "fb2");
    const { copy } = makeRepo(dir);
    const archiveRoot = path.join(dir, "archive");
    const r = archive(copy, KEY, { archiveRoot, gitBin: bundleFailShim(dir) });
    assert.equal(r.ok, true, r.reason);
    const size = fs.statSync(r.entry.fullTar).size;
    // a quota below the single entry must retire it via the fullTar size
    const res = retain(archiveRoot, { now: new Date(Date.parse(r.entry.createdAt) + 1000), maxAgeDays: 365, capBytes: Math.max(1, size - 1) });
    assert.equal(res.ok, true, res.reason);
    assert.equal(res.removed.length, 1);
    assert.equal(res.removed[0].reason, "cap");
  });

  it("when even the fallback tar cannot be written, nothing is archived and no manifest entry survives", () => {
    const dir = path.join(tmp, "fb3");
    const { copy } = makeRepo(dir);
    const archiveRoot = path.join(dir, "archive");
    fs.mkdirSync(archiveRoot, { recursive: true });
    fs.chmodSync(archiveRoot, 0o555); // same uid as botd: the tar write itself fails
    try {
      const r = archive(copy, KEY, { archiveRoot, gitBin: bundleFailShim(dir), now: at("2026-10-08T12:00:00Z") });
      assert.equal(r.ok, false);
      assert.match(r.reason, /fallback tar failed/);
      assert.match(r.reason, /bundle create failed/);
      assert.ok(fs.existsSync(copy), "in doubt: the directory is left where it is");
      assert.equal(fs.readdirSync(archiveRoot).length, 0, "no half-written archive or manifest survives");
    } finally {
      fs.chmodSync(archiveRoot, 0o755);
    }
  });

  it("a directory over the fallback cap is NOT tarred: ok:false with the reason, nothing removed", () => {
    const dir = path.join(tmp, "fb-cap");
    const { copy } = makeRepo(dir);
    const archiveRoot = path.join(dir, "archive");
    const r = archive(copy, KEY, { archiveRoot, gitBin: bundleFailShim(dir), now: at("2026-10-08T12:00:00Z"), fullTarCapBytes: 1 });
    assert.equal(r.ok, false);
    assert.match(r.reason, /bundle create failed/);
    assert.match(r.reason, /fallback skipped: the directory is \d+ bytes, over the fallback limit of 1/);
    assert.match(r.reason, /left in place/);
    assert.ok(fs.existsSync(copy), "in doubt: the directory is left where it is");
    assert.deepEqual(fs.readdirSync(archiveRoot), [], "no tar was ever started");
    assert.deepEqual(readManifest(archiveRoot).archives, [], "no manifest entry for a refused fallback");
  });

  it("the fallback tar verifies with the listing streamed to /dev/null (no stdout buffering)", () => {
    const dir = path.join(tmp, "fb-stream");
    const { copy } = makeRepo(dir);
    const archiveRoot = path.join(dir, "archive");
    const r = archive(copy, KEY, { archiveRoot, gitBin: bundleFailShim(dir), now: at("2026-10-08T12:00:00Z") });
    assert.equal(r.ok, true, r.reason);
    // verifyEntry lists the fullTar through the same non-buffering check
    assert.equal(verifyEntry(r.entry).ok, true);
    fs.rmSync(r.entry.fullTar);
    const v = verifyEntry(r.entry);
    assert.equal(v.ok, false);
    assert.match(v.reason, /archive files are gone/);
  });

  it("an empty bundle (nothing beyond origin) stays as-is: ok, no bundle, no full tar", () => {
    const dir = path.join(tmp, "eb");
    const origin = path.join(dir, "origin.git");
    const copy = path.join(dir, "copy");
    fs.mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q", "--bare", "-b", "main", origin);
    git(dir, "clone", "-q", origin, copy);
    fs.writeFileSync(path.join(copy, "readme.md"), "clean\n");
    git(copy, "add", ".");
    git(copy, "commit", "-qm", "base");
    git(copy, "push", "-q", "origin", "main");
    git(copy, "checkout", "-qb", `bot/${KEY}`);
    const archiveRoot = path.join(dir, "archive");
    const r = archive(copy, KEY, { archiveRoot, now: at("2026-10-08T12:00:00Z") });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.entry.incompleteBundle, undefined);
    assert.equal(r.entry.fullTar, undefined);
  });
});

// A minimal fake loop rig: static rules, counting executor, canned board answer.
function loopRig({ actions, executor, cooldown, retention }) {
  const logs = [];
  const calls = [];
  const loop = createLoop({
    desired: { poll: async () => ({ ok: true, state: { pressure: {}, assignments: [] } }) },
    rules: { plan: () => ({ actions, held: [], pressure: "none" }) },
    gather: async () => ({ inventory: { worktrees: [], scratch: [], bases: [], archives: [] }, parts: {} }),
    executor,
    cooldown,
    retention,
    report: { build: (parts) => ({ built: true, parts }), send: async () => ({ ok: true, nextReportSec: 300 }) },
    writeDiskState: () => {},
    log: (l) => logs.push(l),
    now: () => new Date("2026-10-08T12:00:00Z"),
    jitter: () => 0,
  });
  return { loop, logs, calls };
}

describe("loop: the rhythm cache and the pass summary", () => {
  it("the same op on the same path is skipped silently inside the window", async () => {
    const file = path.join(tmp, "cooldown", "botd-cooldown.json");
    const cooldown = createCooldown(file);
    let calls = 0;
    const actions = [{ op: "remove", path: "/scratch/x1", reason: "age" }];
    const { loop, logs } = loopRig({ actions, executor: { remove: async () => { calls += 1; return "removed"; } }, cooldown });
    const first = await loop.runOnce();
    assert.equal(calls, 1);
    assert.equal(first.executed.filter((r) => r.path === "/scratch/x1").length, 1);
    assert.ok(logs.some((l) => l.includes("cleaned 1, deferred 0")), logs.join("\n"));
    const second = await loop.runOnce();
    assert.equal(calls, 1, "a repeat within the TTL must not execute the op");
    assert.equal(second.executed.filter((r) => r.path === "/scratch/x1").length, 0, "the skip is silent: no report row");
    assert.equal(logs.filter((l) => l.includes("cleaned")).length, 1, "an all-cooldown pass adds no summary noise");
    // another op on the same path is a different decision and still runs —
    // and must NOT evict the remove's cooldown entry (the key is path+op)
    const { loop: loop2 } = loopRig({ actions: [{ op: "prune", path: "/scratch/x1", reason: "stale" }], executor: { prune: async () => "pruned" }, cooldown });
    const pr = await loop2.runOnce();
    assert.equal(pr.executed.filter((r) => r.path === "/scratch/x1").length, 1);
    const re = await loop.runOnce();
    assert.equal(re.executed.filter((r) => r.path === "/scratch/x1").length, 0, "remove is still on cooldown: a foreign op must not overwrite its entry");
    // both entries live side by side under the composite path+op key: the remove
    // entry survives the foreign op's write (the old plain-path cache lost it).
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(Object.keys(stored).length, 2, `expected 2 entries, got: ${Object.keys(stored).join(", ")}`);
    // and after the TTL it runs again (a clock past the recorded `at` + TTL:
    // the records above went in under the real clock, so jump past it)
    const later = createCooldown(file, { now: () => new Date(Date.now() + DEFAULT_TTL_MS + 1000) });
    const { loop: loop3, calls: _c } = loopRig({ actions, executor: { remove: async () => { calls += 1; return "removed"; } }, cooldown: later });
    await loop3.runOnce();
    assert.equal(calls, 2);
  });

  it("without the cooldown module every action runs (behaviour unchanged)", async () => {
    let calls = 0;
    const { loop } = loopRig({ actions: [{ op: "remove", path: "/scratch/y", reason: "age" }], executor: { remove: async () => { calls += 1; return "removed"; } } });
    await loop.runOnce();
    await loop.runOnce();
    assert.equal(calls, 2);
  });

  it("both caches sweep entries older than max(ttl, 1d) on write", () => {
    const cFile = path.join(tmp, "sweep", "botd-cooldown.json");
    const aFile = path.join(tmp, "sweep", "botd-attention.json");
    fs.mkdirSync(path.dirname(cFile), { recursive: true });
    const ancient = { op: "remove", result: "ok", at: "2026-09-01T00:00:00Z" }; // weeks old
    fs.writeFileSync(cFile, JSON.stringify({ "/scratch/ancient": ancient }));
    fs.writeFileSync(aFile, JSON.stringify({ "/scratch/ancient": { reason: "deferred", uid: null, at: "2026-09-01T00:00:00Z" } }));
    const nowMs = Date.parse("2026-10-08T12:00:00Z");
    const cooldown = createCooldown(cFile, { now: () => new Date(nowMs) });
    cooldown.record("/scratch/fresh", "remove", "ok");
    const cStored = JSON.parse(fs.readFileSync(cFile, "utf8"));
    assert.equal(Object.keys(cStored).length, 1);
    assert.ok(Object.keys(cStored)[0].includes("/scratch/fresh"), Object.keys(cStored).join(","));
    const attention = createAttention(aFile, { now: () => new Date(nowMs), log: () => {} });
    attention.signal("/scratch/fresh", { reason: "deferred", uid: 1 });
    const aStored = JSON.parse(fs.readFileSync(aFile, "utf8"));
    assert.deepEqual(Object.keys(aStored), ["/scratch/fresh"]);
    // an entry inside the window survives the sweep
    cooldown.record("/scratch/recent", "remove", "ok");
    const cStored2 = JSON.parse(fs.readFileSync(cFile, "utf8"));
    assert.equal(Object.keys(cStored2).length, 2);
  });

  it("archiveThenRemove probes permissions before archiving: a deferred probe creates no archive", () => {
    const dir = path.join(tmp, "probe-first");
    fs.mkdirSync(dir, { recursive: true });
    const archived = [];
    const r = archiveThenRemove({ path: dir, key: "ABC-9" }, {
      archiveMod: { archive: (p, k) => { archived.push(k); return { ok: true, entry: { key: k } }; }, archiveTree: (p, k) => { archived.push(k); return { ok: true, entry: { key: k } }; } },
      isGit: () => false,
      nestedGit: () => [],
      probe: () => ({ deferred: "foreign-uid", detail: "EACCES: permission denied" }),
      remove: () => { throw new Error("remove must not run after a deferred probe"); },
      archiveRoot: path.join(tmp, "probe-archive"),
    });
    assert.equal(r.deferred, "foreign-uid");
    assert.equal(archived.length, 0, "a path that cannot be removed must not be re-archived every pass");
    assert.ok(fs.existsSync(dir));
  });

  it("removePath wiring: a deferred guardedRemove signals attention once and hands {deferred} to the loop", async () => {
    // The exact combination botd builds in main(): guardedRemove wrapped by the
    // attention policy, used as the executor's remove op under the loop's tally.
    const file = path.join(tmp, "combo", "botd-attention.json");
    const attentionLogs = [];
    const attention = createAttention(file, { log: (l) => attentionLogs.push(l), now: () => new Date("2026-10-08T12:00:00Z") });
    const foreign = new Error("EACCES: permission denied");
    foreign.deferred = "foreign-uid";
    foreign.code = "EACCES"; // uid is taken from lstat of the real path (remove.js), like in production
    const removePath = (p, roots) => {
      try {
        return guardedRemove(p, roots);
      } catch (err) {
        if (err && err.deferred === "foreign-uid") {
          attention.signal(p, { reason: `${err.code} foreign-uid`, uid: err.uid });
          return { deferred: err.deferred, detail: err.message };
        }
        throw err;
      }
    };
    const target = path.join(tmp, "combo-target");
    fs.mkdirSync(target, { recursive: true });
    const origRm = fs.rmSync;
    fs.rmSync = () => { throw foreign; };
    try {
      const actions = [{ op: "remove", path: target, reason: "age" }];
      const executor = { remove: async (a) => removePath(a.path, [tmp]) };
      const { loop, logs } = loopRig({ actions, executor });
      const r1 = await loop.runOnce();
      const rows = r1.executed.filter((x) => x.path === target);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].result, "skipped");
      assert.match(rows[0].detail, /deferred: foreign-uid \(EACCES/);
      assert.equal(attentionLogs.length, 1);
      assert.match(attentionLogs[0], /EACCES foreign-uid, uid \d+/);
      assert.ok(logs.some((l) => l.includes("botd loop: cleaned 0, deferred 1 (foreign-uid: 1)")), logs.join("\n"));
    } finally {
      fs.rmSync = origRm;
    }
  });

  it("a deferred executor result is skipped, not an error, and lands in the summary", async () => {
    const actions = [
      { op: "remove", path: "/workspace/ABC-1", reason: "age" },
      { op: "remove", path: "/workspace/ABC-2", reason: "age" },
    ];
    const executor = {
      remove: async (a) => (a.path.endsWith("ABC-2") ? { deferred: "foreign-uid", detail: "EACCES: permission denied" } : "already gone"),
    };
    const { loop, logs } = loopRig({ actions, executor });
    const r = await loop.runOnce();
    const rows = r.executed.filter((x) => String(x.path).startsWith("/workspace/ABC"));
    assert.equal(rows.length, 2);
    const deferredRow = rows.find((x) => x.path.endsWith("ABC-2"));
    assert.equal(deferredRow.result, "skipped");
    assert.match(deferredRow.detail, /deferred: foreign-uid \(EACCES: permission denied\)/);
    assert.equal(rows.find((x) => x.path.endsWith("ABC-1")).result, "ok");
    assert.ok(logs.some((l) => l.includes("botd loop: cleaned 1, deferred 1 (foreign-uid: 1)")), logs.join("\n"));
    assert.equal(logs.filter((l) => l.includes("failed")).length, 0, "a deferral must not look like an error");
  });
});

describe("archiveTree: bounded like the fallback tar", () => {
  const makeTree = (name, bytes) => {
    const dir = path.join(tmp, name, "tree");
    fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(dir, "node_modules", "big.bin"), Buffer.alloc(bytes, 1));
    fs.mkdirSync(path.join(dir, ".git"));
    fs.writeFileSync(path.join(dir, ".git", "huge"), Buffer.alloc(50_000, 2)); // never part of the tar
    return { dir, archiveRoot: path.join(tmp, name, "archive") };
  };

  it("a tree under the limit is archived and verified (control)", () => {
    const { dir, archiveRoot } = makeTree("tree-ok", 10_000);
    const r = archiveTree(dir, "legacy-ok", { archiveRoot, fullTarCapBytes: 20_000, minFreeBytes: 0 });
    assert.equal(r.ok, true, r.reason);
    assert.ok(fs.existsSync(r.entry.dirTar));
  });

  it("a tree over the limit is refused: ok:false, no tar, no manifest entry, directory in place", () => {
    const { dir, archiveRoot } = makeTree("tree-cap", 10_000);
    const r = archiveTree(dir, "legacy-cap", { archiveRoot, fullTarCapBytes: 5_000, minFreeBytes: 0 });
    assert.equal(r.ok, false);
    assert.match(r.reason, /not archived: the directory is \d+ bytes, over the fallback limit of 5000/);
    assert.match(r.reason, /left in place/);
    assert.ok(fs.existsSync(path.join(dir, "node_modules", "big.bin")));
    assert.deepEqual(fs.readdirSync(archiveRoot), [], "no tar was started");
  });

  it(".git does not count toward the limit (the tar excludes it)", () => {
    const { dir, archiveRoot } = makeTree("tree-git", 1_000);
    const r = archiveTree(dir, "legacy-git", { archiveRoot, fullTarCapBytes: 5_000, minFreeBytes: 0 });
    assert.equal(r.ok, true, r.reason);
  });

  it("without free space in the archive root the tree is refused", () => {
    const { dir, archiveRoot } = makeTree("tree-free", 1_000);
    const r = archiveTree(dir, "legacy-free", { archiveRoot, minFreeBytes: Number.MAX_SAFE_INTEGER });
    assert.equal(r.ok, false);
    assert.match(r.reason, /only \d+ bytes free in .* for a \d+-byte directory/);
    assert.deepEqual(fs.readdirSync(archiveRoot), []);
    assert.ok(fs.existsSync(dir));
  });

  it("legacy.archiveThenRemove keeps the directory when archiveTree refuses it", () => {
    const { dir, archiveRoot } = makeTree("tree-legacy", 10_000);
    let removed = false;
    assert.throws(
      () =>
        archiveThenRemove(
          { path: dir, key: "legacy-x" },
          {
            archiveMod: { archive, archiveTree: (p, k, o) => archiveTree(p, k, { ...o, fullTarCapBytes: 5_000, minFreeBytes: 0 }) },
            isGit: () => false,
            remove: () => { removed = true; },
            archiveRoot,
            nestedGit: () => [],
          },
        ),
      /archive-incomplete: directory tree: .*over the fallback limit/,
    );
    assert.equal(removed, false);
    assert.ok(fs.existsSync(dir));
  });
});

describe("retention is part of the botd pass", () => {
  const seed = (name, entries) => {
    const archiveRoot = path.join(tmp, name);
    fs.mkdirSync(archiveRoot, { recursive: true });
    const archives = entries.map(({ key, createdAt, bytes }) => {
      const f = path.join(archiveRoot, `${key}.patch`);
      fs.writeFileSync(f, Buffer.alloc(bytes, 1));
      return { key, patch: f, createdAt, sizeBytes: bytes, truncatedUntracked: false };
    });
    fs.writeFileSync(path.join(archiveRoot, "manifest.json"), JSON.stringify({ version: 1, archives }));
    return archiveRoot;
  };

  it("retainPass retires an expired entry and keeps the one created in this pass even over the cap", () => {
    const now = at("2026-10-09T12:00:00Z");
    const archiveRoot = seed("ret-1", [
      { key: "OLD-1", createdAt: "2026-08-01T00:00:00Z", bytes: 100 },
      { key: "NEW-1", createdAt: "2026-10-09T11:59:59Z", bytes: 5_000 },
    ]);
    const r = retainPass(archiveRoot, { startedAt: at("2026-10-09T11:59:00Z"), now, capBytes: 10 });
    assert.equal(r.ok, true, r.reason);
    assert.deepEqual(r.removed.map((x) => [x.key, x.reason]), [["OLD-1", "age"]]);
    assert.deepEqual(readManifest(archiveRoot).archives.map((e) => e.key), ["NEW-1"]);
    assert.ok(fs.existsSync(path.join(archiveRoot, "NEW-1.patch")));
    assert.ok(!fs.existsSync(path.join(archiveRoot, "OLD-1.patch")));
  });

  it("the quota evicts an older entry that is not from this pass", () => {
    const archiveRoot = seed("ret-2", [
      { key: "A-1", createdAt: "2026-10-01T00:00:00Z", bytes: 4_000 },
      { key: "B-1", createdAt: "2026-10-09T11:59:59Z", bytes: 4_000 },
    ]);
    const r = retainPass(archiveRoot, { startedAt: at("2026-10-09T11:59:00Z"), now: at("2026-10-09T12:00:00Z"), capBytes: 5_000 });
    assert.deepEqual(r.removed.map((x) => [x.key, x.reason]), [["A-1", "cap"]]);
  });

  it("the loop calls retention after the actions of an executed pass, and a throwing hook does not break the pass", async () => {
    const order = [];
    const actions = [{ op: "remove", path: "/scratch/r1", reason: "age" }];
    const { loop, logs } = loopRig({
      actions,
      executor: { remove: async () => { order.push("action"); return "removed"; } },
      retention: async ({ startedAt }) => {
        order.push("retention");
        assert.ok(startedAt instanceof Date);
        throw new Error("manifest locked");
      },
    });
    const r = await loop.runOnce();
    assert.deepEqual(order, ["action", "retention"]);
    assert.equal(r.executed.filter((x) => x.path === "/scratch/r1")[0].result, "ok");
    assert.ok(logs.some((l) => l.includes("archive retention failed: manifest locked")), logs.join("\n"));
  });

  it("a dry run (--plan) never runs retention", async () => {
    let called = false;
    const { loop } = loopRig({ actions: [], executor: {}, retention: async () => { called = true; } });
    await loop.runOnce({ dryRun: true });
    assert.equal(called, false);
  });
});
