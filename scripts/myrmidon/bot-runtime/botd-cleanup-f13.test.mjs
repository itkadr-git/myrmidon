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
//     verified `<base>.full.tar.zst` of the whole directory, which clears removal;
//   * the rhythm cache: the same op on the same path runs at most once per hour,
//     a repeat inside the window is a silent skip; the pass ends with
//     `cleaned N, deferred M (...)`.
// Placeholder keys and repositories only.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const lib = (name) => path.join(ROOT, "docker/bot-runtime/botd/lib", name);
const { guardedRemove, inside } = await import(lib("remove.js"));
const { createAttention, createCooldown, DEFAULT_TTL_MS } = await import(lib("cache.js"));
const { archive, readManifest, retain, verifyEntry } = await import(lib("archive.js"));
const { createLoop } = await import(lib("loop.js"));

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

  it("verifyEntry passes an archive whose files are all gone; retain drops it silently", () => {
    const aRoot = path.join(tmp, "v-archive");
    const entry = { key: KEY, bundle: path.join(aRoot, `${KEY}-x.bundle`), createdAt: new Date().toISOString(), sizeBytes: 1 };
    // nothing on disk under aRoot: every file is gone
    assert.deepEqual(verifyEntry(entry), { ok: true, detail: "already gone" });
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
function loopRig({ actions, executor, cooldown }) {
  const logs = [];
  const calls = [];
  const loop = createLoop({
    desired: { poll: async () => ({ ok: true, state: { pressure: {}, assignments: [] } }) },
    rules: { plan: () => ({ actions, held: [], pressure: "none" }) },
    gather: async () => ({ inventory: { worktrees: [], scratch: [], bases: [], archives: [] }, parts: {} }),
    executor,
    cooldown,
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
    // another op on the same path is a different decision and still runs
    const { loop: loop2 } = loopRig({ actions: [{ op: "prune", path: "/scratch/x1", reason: "stale" }], executor: { prune: async () => "pruned" }, cooldown });
    await loop2.runOnce();
    const re = await loop.runOnce();
    assert.equal(re.executed.filter((r) => r.path === "/scratch/x1").length, 1); // remove is still on cooldown
    // and after the TTL it runs again
    const later = createCooldown(file, { now: () => new Date(Date.parse("2026-10-08T12:00:00Z") + DEFAULT_TTL_MS + 1000) });
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
