import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// myrmidon(1.6.5-BOT-DISK-H): directories outside the myr-ws registry (legacy task
// directories, foreign class X) reach the rules inventory and are archived and
// removed without `myr-ws close`. Fixtures on disk, no network.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const lib = (n) => path.join(ROOT, "docker/bot-runtime/botd/lib", n);
const { classifyAll } = await import(lib("classify.js"));
const { plan } = await import(lib("rules.js"));
const archiveMod = await import(lib("archive.js"));
const { scratchInventory, inRegistry, archiveThenRemove, findNestedGit, isUsableRepo } = await import(lib("legacy.js"));
const hasGit = spawnSync("git", ["--version"]).status === 0;

const HOUR = 3600 * 1000;
const REMOTE = '[remote "origin"]\n\turl = https://example.com/acme/widgets.git\n';
let tmp;
let ws;
let archiveRoot;

function mkRepo(dir, config) {
  fs.mkdirSync(path.join(dir, ".git", "objects"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".git", "refs"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(dir, ".git", "config"), config);
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "botd-legacy-"));
  ws = path.join(tmp, "workspace");
  archiveRoot = path.join(tmp, "archive");
  fs.mkdirSync(ws, { recursive: true });
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const classified = () => classifyAll({ roots: [ws], workspaceRoot: ws, gitBaseDir: path.join(tmp, "base"), registry: [] });
const hasDotGit = (p) => fs.existsSync(path.join(p, ".git"));
const desired = (workspaces = []) => ({ workspaces, grace: { closingMinutes: 30, scratchTtlHours: 24, orphanHours: 24 } });

describe("gather: class X and legacy G enter the inventory", () => {
  it("full-clone, no-remote and plain task directories become scratch entries; the registry copy does not", () => {
    mkRepo(path.join(ws, "OPE-1"), REMOTE); // X full-clone
    mkRepo(path.join(ws, "OPE-2"), ""); // X no-remote
    fs.mkdirSync(path.join(ws, "OPE-3")); // G, no .git
    fs.writeFileSync(path.join(ws, "OPE-3", "n.txt"), "n");
    const { items } = classified();
    const entries = [{ key: "OPE-3", path: path.join(ws, "OPE-3"), class: "G", openedAt: 1, clean: null, pushed: null }];
    const sc = scratchInventory(entries, items, Date.now(), hasDotGit);
    const byName = Object.fromEntries(sc.map((s) => [s.name, s]));
    assert.equal(byName["OPE-1"].isGit, true);
    assert.equal(byName["OPE-2"].isGit, true);
    assert.equal(byName["OPE-3"].mtime, 1, "registry entry is not duplicated by the classifier item");
    assert.equal(sc.filter((s) => s.name === "OPE-3").length, 1);
    assert.ok(Number.isFinite(byName["OPE-1"].mtime));
  });

  it("rules: past the TTL X is archived+removed; inside it, kept; a live task of the same key is protected", () => {
    const { items } = classified();
    const sc = scratchInventory([], items, Date.now(), hasDotGit);
    const later = Date.now() + 25 * HOUR;
    const idle = { live: false };
    const acts = plan({ worktrees: [], scratch: sc, bases: [], archives: [], run: idle }, desired(), later).actions;
    const a1 = acts.find((a) => a.path.endsWith("OPE-1"));
    assert.equal(a1.op, "archive-remove");
    assert.equal(plan({ worktrees: [], scratch: sc, bases: [], archives: [] }, desired(), Date.now()).actions.length, 0);
    const live = desired([{ key: "OPE-1", state: "active" }]);
    const protectedActs = plan({ worktrees: [], scratch: sc, bases: [], archives: [] }, live, later).actions;
    assert.equal(protectedActs.find((a) => a.path.endsWith("OPE-1")), undefined);
    // an active task on the board is a live run: the other unsaved git copy is kept too, and reported
    assert.equal(protectedActs.find((a) => a.path.endsWith("OPE-2")), undefined);
    assert.ok(plan({ worktrees: [], scratch: sc, bases: [], archives: [] }, live, later).held.some((h) => h.kind === "unsafe-git-live-run" && h.path.endsWith("OPE-2")));
  });
});

describe("inRegistry", () => {
  it("matches the exact path only", () => {
    const reg = [{ key: "OPE-9", path: "/workspace/OPE-9" }];
    assert.equal(inRegistry(reg, "/workspace/OPE-9"), true);
    assert.equal(inRegistry(reg, "/workspace/OPE-9/"), true);
    assert.equal(inRegistry(reg, "/workspace/OPE-1"), false);
    assert.equal(inRegistry(undefined, "/workspace/OPE-1"), false);
  });
});

describe("archiveThenRemove: legacy path outside the registry", () => {
  const mk = () => {
    const removed = [];
    return { removed, remove: (p) => removed.push(p) };
  };

  it("non-git directory: tar archive (without .git), then remove", () => {
    const dir = path.join(ws, "OPE-20");
    fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
    fs.writeFileSync(path.join(dir, "sub", "f.txt"), "payload");
    const { removed, remove } = mk();
    const detail = archiveThenRemove({ path: dir, key: "OPE-20" }, { archiveMod, isGit: hasDotGit, remove, archiveRoot });
    assert.equal(detail, "archived, removed");
    assert.deepEqual(removed, [dir]);
    const manifest = archiveMod.readManifest(archiveRoot);
    const e = manifest.archives.find((x) => x.key === "OPE-20");
    assert.ok(e.dirTar.endsWith(".dir.tar") && fs.existsSync(e.dirTar));
    const listing = spawnSync("tar", ["-tf", e.dirTar], { encoding: "utf8" }).stdout;
    assert.match(listing, /sub\/f\.txt/);
    assert.equal(archiveMod.verifyEntry(e).ok, true);
  });

  it("git clone with a non-issue name: bundle/patch/untracked archive, then remove", { skip: !hasGit && "git not available" }, () => {
    const dir = path.join(ws, "old-clone");
    fs.mkdirSync(dir, { recursive: true });
    const g = (...args) =>
      spawnSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    assert.equal(g("init", "-q", "-b", "main").status, 0);
    fs.writeFileSync(path.join(dir, "w.txt"), "w");
    g("add", "."), g("commit", "-q", "-m", "c");
    fs.writeFileSync(path.join(dir, "u.txt"), "untracked");
    const { removed, remove } = mk();
    archiveThenRemove({ path: dir, key: "old-clone" }, { archiveMod, isGit: hasDotGit, remove, archiveRoot });
    assert.deepEqual(removed, [dir]);
    const e = archiveMod.readManifest(archiveRoot).archives.find((x) => x.key === "old-clone");
    assert.ok(e.bundle && e.untrackedTar);
  });

  it("a failed archive leaves the directory in place (nothing is removed)", () => {
    const { removed, remove } = mk();
    const failing = { archive: () => ({ ok: false, reason: "boom" }), archiveTree: () => ({ ok: false, reason: "boom" }) };
    assert.throws(() => archiveThenRemove({ path: path.join(ws, "x"), key: "x" }, { archiveMod: failing, isGit: () => false, remove, archiveRoot }), /archive-incomplete: directory tree: boom, not removed/);
    assert.throws(() => archiveThenRemove({ path: path.join(ws, "x"), key: "x" }, { archiveMod: null, isGit: () => false, remove, archiveRoot }), /not in this image/);
    assert.deepEqual(removed, []);
  });

  it("archiveTree rejects an unsafe key and a missing directory", () => {
    assert.equal(archiveMod.archiveTree(ws, "../evil", { archiveRoot }).ok, false);
    assert.equal(archiveMod.archiveTree(path.join(ws, "nope"), "nope", { archiveRoot }).ok, false);
  });
});

describe("archiveThenRemove: a broken nested .git is not a repository", { skip: !hasGit && "git not available" }, () => {
  const mk = () => {
    const removed = [];
    return { removed, remove: (p) => removed.push(p) };
  };
  const brokenGit = (dir) => {
    fs.mkdirSync(path.join(dir, ".git"), { recursive: true }); // hollowed out: no HEAD/objects/refs
    fs.writeFileSync(path.join(dir, "src.txt"), "work tree file");
  };

  it("isUsableRepo: hollow .git fails, a real repository passes", () => {
    const hollow = path.join(ws, "hollow");
    brokenGit(hollow);
    assert.equal(isUsableRepo(hollow), false);
    const real = path.join(ws, "real");
    fs.mkdirSync(real, { recursive: true });
    assert.equal(spawnSync("git", ["init", "-q", "-b", "main"], { cwd: real }).status, 0);
    assert.equal(isUsableRepo(real), true);
  });

  it("closed task directory with a broken nested .git: archived as files, then removed", () => {
    const dir = path.join(ws, "OPE-4433");
    brokenGit(path.join(dir, "repo"));
    fs.writeFileSync(path.join(dir, "top.txt"), "top");
    assert.deepEqual(findNestedGit(dir), []);
    const { removed, remove } = mk();
    const detail = archiveThenRemove({ path: dir, key: "OPE-4433" }, { archiveMod, isGit: hasDotGit, remove, archiveRoot });
    assert.equal(detail, "archived, removed");
    assert.deepEqual(removed, [dir]);
    const e = archiveMod.readManifest(archiveRoot).archives.find((x) => x.key === "OPE-4433");
    assert.ok(e.dirTar && !e.bundle);
    const listing = spawnSync("tar", ["-tf", e.dirTar], { encoding: "utf8" }).stdout;
    assert.match(listing, /repo\/src\.txt/);
    assert.match(listing, /top\.txt/);
    assert.doesNotMatch(listing, /\.git/);
  });

  it("a broken .git on the directory itself is also plain files", () => {
    const dir = path.join(ws, "OPE-4434");
    brokenGit(dir);
    const { removed, remove } = mk();
    assert.equal(archiveThenRemove({ path: dir, key: "OPE-4434" }, { archiveMod, isGit: hasDotGit, remove, archiveRoot }), "archived, removed");
    assert.deepEqual(removed, [dir]);
    const e = archiveMod.readManifest(archiveRoot).archives.find((x) => x.key === "OPE-4434");
    assert.match(spawnSync("tar", ["-tf", e.dirTar], { encoding: "utf8" }).stdout, /src\.txt/);
  });

  it("a real repository whose bundle fails is still not removed", () => {
    const dir = path.join(ws, "OPE-4435");
    const repo = path.join(dir, "repo");
    fs.mkdirSync(repo, { recursive: true });
    assert.equal(spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo }).status, 0);
    fs.writeFileSync(path.join(repo, "f.txt"), "f");
    const failing = { ...archiveMod, archive: () => ({ ok: false, reason: "bundle create failed: boom" }) };
    const { removed, remove } = mk();
    assert.throws(() => archiveThenRemove({ path: dir, key: "OPE-4435" }, { archiveMod: failing, isGit: hasDotGit, remove, archiveRoot }), /archive-incomplete: nested repository repo: bundle create failed: boom, not removed/);
    assert.deepEqual(removed, []);
    assert.ok(fs.existsSync(path.join(repo, "f.txt")));
  });
});
