import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// myrmidon(1.6.5 BOT-DISK-H2d): `myr-ws close`. Real git against a local bare
// origin (file://); the archive module of botd is a fake that logs its calls.
// Placeholder owners/repositories only; nothing touches the network.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CLOSE_JS = path.join(ROOT, "docker/bot-runtime/myr-ws/lib/close.js");
const CONTRACT_TS = path.join(ROOT, "packages/shared/src/myrmidon-bot-workspace.ts");
const CONTRACT_DIR = path.join(ROOT, "docs/myrmidon/bot-disk-contract");
const require = createRequire(import.meta.url);
const closeMod = require(CLOSE_JS);

const hasGit = spawnSync("git", ["--version"]).status === 0;
const GIT_ENV = {
  PATH: process.env.PATH,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

let tmp;
let n = 0;

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...GIT_ENV, HOME: tmp } });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A fresh world: origin, bot home with base, /workspace and /scratch roots, registry. */
function world() {
  const dir = fs.mkdtempSync(path.join(tmp, `w${++n}-`));
  const origin = path.join(dir, "origin.git");
  git(dir, "init", "--bare", "--quiet", "-b", "main", origin);
  const seed = path.join(dir, "seed");
  fs.mkdirSync(seed);
  git(seed, "init", "--quiet", "-b", "main");
  fs.writeFileSync(path.join(seed, "README.md"), "hello\n");
  git(seed, "add", ".");
  git(seed, "commit", "--quiet", "-m", "init");
  git(seed, "push", "--quiet", origin, "main");
  const home = path.join(dir, "home");
  const basePath = path.join(home, "git-base/acme/widgets.git");
  fs.mkdirSync(path.dirname(basePath), { recursive: true });
  git(dir, "init", "--bare", "--quiet", basePath);
  git(basePath, "remote", "add", "origin", origin);
  git(basePath, "config", "--replace-all", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
  git(basePath, "fetch", "--quiet", "origin");
  const w = {
    dir,
    origin,
    home,
    basePath,
    workspaceRoot: path.join(dir, "workspace"),
    scratchRoot: path.join(dir, "scratch"),
    entries: [],
    calls: [],
  };
  fs.mkdirSync(w.workspaceRoot);
  fs.mkdirSync(w.scratchRoot);
  return w;
}

function writeRegistry(w) {
  fs.writeFileSync(path.join(w.home, "ws-registry.json"), `${JSON.stringify({ version: 1, entries: w.entries }, null, 2)}\n`);
}

/** Opens a task copy the way `myr-ws open` does: worktree + bot/<KEY> branch + registry entry. */
function openTask(w, key) {
  const copy = path.join(w.workspaceRoot, key);
  git(w.basePath, "worktree", "add", "--no-track", "-b", `bot/${key}`, copy, "refs/remotes/origin/main");
  w.entries.push({ key, repo: "acme/widgets", path: copy, class: "E", branch: `bot/${key}`, openedAt: "2026-10-06T14:00:00Z" });
  writeRegistry(w);
  return copy;
}

function deps(w, archive) {
  return {
    env: { ...GIT_ENV, HOME: tmp, MYRMIDON_WS_HOME: w.home },
    home: w.home,
    workspaceRoot: w.workspaceRoot,
    scratchRoot: w.scratchRoot,
    archive,
  };
}

function fakeArchive(w, result) {
  return async (copyPath, key) => {
    // Record whether the copy still existed when the archive ran.
    w.calls.push({ op: "archive", key, copyPath, existed: fs.existsSync(path.join(copyPath, ".git")) });
    return typeof result === "function" ? result(copyPath, key) : result;
  };
}

function registryKeys(w) {
  return JSON.parse(fs.readFileSync(path.join(w.home, "ws-registry.json"), "utf8")).entries.map((e) => e.key);
}

const branches = (w) => git(w.basePath, "for-each-ref", "--format=%(refname:short)", "refs/heads");
const worktrees = (w) => git(w.basePath, "worktree", "list", "--porcelain");

async function exitOf(promise) {
  try {
    await promise;
    return { code: 0 };
  } catch (e) {
    return { code: e.exitCode, message: e.message, name: e.name };
  }
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "myr-ws-close-test-"));
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("myr-ws close: contract parity", () => {
  it("mirrors the exit codes, paths and prefix of the shared contract", () => {
    const ts = fs.readFileSync(CONTRACT_TS, "utf8");
    const block = /export const MYR_WS_EXIT = \{([^}]+)\}/.exec(ts)[1];
    for (const [name, code] of Object.entries(closeMod.EXIT)) assert.match(block, new RegExp(`${name}:\\s*${code}\\b`));
    assert.match(ts, /export const WS_WORKSPACE_ROOT = "\/workspace"/);
    assert.match(ts, /export const WS_SCRATCH_ROOT = "\/scratch"/);
    assert.match(ts, /export const WS_TASK_BRANCH_PREFIX = "bot\/"/);
  });

  it("the contract fixture and the result have the same shape (key, removed, archived, archivePath?)", () => {
    const fixture = JSON.parse(fs.readFileSync(path.join(CONTRACT_DIR, "myr-ws-close.json"), "utf8"));
    const ts = fs.readFileSync(CONTRACT_TS, "utf8");
    const schema = /export const myrWsCloseResultSchema = z\.object\(\{([\s\S]*?)\}\);/.exec(ts)[1];
    const declared = [...schema.matchAll(/^\s+(\w+):/gm)].map((m) => m[1]).sort();
    assert.deepEqual(Object.keys(fixture).sort(), declared);
    assert.equal(fixture.ok, true);
    assert.equal(typeof fixture.removed, "boolean");
    assert.equal(typeof fixture.archived, "boolean");
  });
});

describe("myr-ws close", { skip: !hasGit && "git missing" }, () => {
  it("clean pushed copy: worktree removed, branch deleted, registry updated, exit 0", async () => {
    const w = world();
    const copy = openTask(w, "ABC-101");
    const other = openTask(w, "ABC-102");
    const res = await closeMod.closeCopy({ key: "ABC-101" }, deps(w, fakeArchive(w, { ok: true })));
    assert.deepEqual(res, { key: "ABC-101", removed: true, archived: false });
    assert.equal(fs.existsSync(copy), false);
    assert.doesNotMatch(branches(w), /bot\/ABC-101/);
    assert.match(branches(w), /bot\/ABC-102/, "a neighbour copy is untouched");
    assert.doesNotMatch(worktrees(w), /ABC-101/);
    assert.deepEqual(registryKeys(w), ["ABC-102"]);
    assert.equal(fs.existsSync(other), true);
    assert.deepEqual(w.calls, [], "nothing to archive");
  });

  it("a pushed branch counts as pushed; a clean copy on the base ref too", async () => {
    const w = world();
    const copy = openTask(w, "ABC-110");
    fs.writeFileSync(path.join(copy, "feature.txt"), "x\n");
    git(copy, "add", ".");
    git(copy, "commit", "--quiet", "-m", "feature");
    git(copy, "push", "--quiet", w.origin, "bot/ABC-110");
    git(w.basePath, "fetch", "--quiet", "origin");
    const res = await closeMod.closeCopy({ key: "ABC-110" }, deps(w, fakeArchive(w, { ok: true })));
    assert.equal(res.removed, true);
    assert.equal(fs.existsSync(copy), false);
  });

  it("dirty copy without --force: exit 7, directory and branch intact, no archive", async () => {
    const w = world();
    const copy = openTask(w, "ABC-103");
    fs.writeFileSync(path.join(copy, "wip.txt"), "unsaved\n");
    const r = await exitOf(closeMod.closeCopy({ key: "ABC-103" }, deps(w, fakeArchive(w, { ok: true }))));
    assert.equal(r.code, 7);
    assert.match(r.message, /uncommitted/);
    assert.equal(fs.readFileSync(path.join(copy, "wip.txt"), "utf8"), "unsaved\n");
    assert.match(branches(w), /bot\/ABC-103/);
    assert.deepEqual(registryKeys(w), ["ABC-103"]);
    assert.deepEqual(w.calls, []);
  });

  it("unpushed commit without --force: exit 7, nothing removed", async () => {
    const w = world();
    const copy = openTask(w, "ABC-104");
    fs.writeFileSync(path.join(copy, "a.txt"), "a\n");
    git(copy, "add", ".");
    git(copy, "commit", "--quiet", "-m", "local only");
    const r = await exitOf(closeMod.closeCopy({ key: "ABC-104" }, deps(w, fakeArchive(w, { ok: true }))));
    assert.equal(r.code, 7);
    assert.match(r.message, /not on origin/);
    assert.equal(fs.existsSync(path.join(copy, "a.txt")), true);
    assert.match(branches(w), /bot\/ABC-104/);
    assert.deepEqual(registryKeys(w), ["ABC-104"]);
  });

  it("--force on a dirty copy: archive runs BEFORE the removal, then the copy goes", async () => {
    const w = world();
    const copy = openTask(w, "ABC-105");
    fs.writeFileSync(path.join(copy, "wip.txt"), "unsaved\n");
    fs.writeFileSync(path.join(copy, "b.txt"), "b\n");
    git(copy, "add", "b.txt");
    git(copy, "commit", "--quiet", "-m", "local only");
    const archivePath = path.join(w.home, "archive/ABC-105-20261006T150000Z.bundle");
    const res = await closeMod.closeCopy({ key: "ABC-105", force: true }, deps(w, fakeArchive(w, { ok: true, archivePath })));
    assert.deepEqual(res, { key: "ABC-105", removed: true, archived: true, archivePath });
    assert.deepEqual(w.calls, [{ op: "archive", key: "ABC-105", copyPath: copy, existed: true }]);
    assert.equal(fs.existsSync(copy), false);
    assert.doesNotMatch(branches(w), /bot\/ABC-105/);
    assert.deepEqual(registryKeys(w), []);
  });

  it("--force with a failed archive: the copy stays, nothing is deleted", async () => {
    const w = world();
    const copy = openTask(w, "ABC-106");
    fs.writeFileSync(path.join(copy, "wip.txt"), "unsaved\n");
    for (const bad of [{ ok: false, error: "bundle verify failed" }, null]) {
      const r = await exitOf(closeMod.closeCopy({ key: "ABC-106", force: true }, deps(w, fakeArchive(w, bad))));
      assert.equal(r.code, 1);
      assert.match(r.message, /not removed/);
    }
    assert.equal(fs.existsSync(path.join(copy, "wip.txt")), true);
    assert.match(branches(w), /bot\/ABC-106/);
    assert.deepEqual(registryKeys(w), ["ABC-106"]);
  });

  it("an archive that throws leaves the copy in place", async () => {
    const w = world();
    const copy = openTask(w, "ABC-107");
    fs.writeFileSync(path.join(copy, "wip.txt"), "x\n");
    const boom = async () => {
      throw new Error("disk full");
    };
    const r = await exitOf(closeMod.closeCopy({ key: "ABC-107", force: true }, deps(w, boom)));
    assert.notEqual(r.code, 0);
    assert.equal(fs.existsSync(path.join(copy, "wip.txt")), true);
    assert.deepEqual(registryKeys(w), ["ABC-107"]);
  });

  it("unknown key: exit 6 (also with an empty registry)", async () => {
    const w = world();
    openTask(w, "ABC-108");
    assert.equal((await exitOf(closeMod.closeCopy({ key: "ZZZ-1" }, deps(w, fakeArchive(w, { ok: true }))))).code, 6);
    const empty = world();
    assert.equal((await exitOf(closeMod.closeCopy({ key: "ABC-1" }, deps(empty, fakeArchive(empty, { ok: true }))))).code, 6);
    assert.deepEqual(registryKeys(w), ["ABC-108"]);
  });

  it("invalid keys (path tricks) are exit 2", async () => {
    const w = world();
    for (const bad of ["../x", "a/b", "", "..", "-rf", "A B"]) {
      assert.equal((await exitOf(closeMod.closeCopy({ key: bad }, deps(w, fakeArchive(w, { ok: true }))))).code, 2, JSON.stringify(bad));
    }
  });

  it("a registry path outside /workspace and /scratch is refused (exit 2), the path is untouched", async () => {
    const w = world();
    const victim = path.join(w.dir, "precious");
    fs.mkdirSync(victim);
    fs.writeFileSync(path.join(victim, "f"), "keep\n");
    w.entries.push({ key: "ABC-109", path: victim, class: "G", openedAt: "2026-10-06T14:00:00Z" });
    writeRegistry(w);
    const r = await exitOf(closeMod.closeCopy({ key: "ABC-109", force: true }, deps(w, fakeArchive(w, { ok: true }))));
    assert.equal(r.code, 2);
    assert.equal(fs.readFileSync(path.join(victim, "f"), "utf8"), "keep\n");
    assert.deepEqual(w.calls, []);
  });

  it("registered but already gone from disk: entry dropped, stale worktree record pruned, removed:false", async () => {
    const w = world();
    const copy = openTask(w, "ABC-111");
    fs.rmSync(copy, { recursive: true, force: true }); // a bot's rm -rf
    assert.match(worktrees(w), /ABC-111/);
    const res = await closeMod.closeCopy({ key: "ABC-111" }, deps(w, fakeArchive(w, { ok: true })));
    assert.deepEqual(res, { key: "ABC-111", removed: false, archived: false });
    assert.doesNotMatch(worktrees(w), /ABC-111/);
    assert.deepEqual(registryKeys(w), []);
  });

  it("scratch: empty directory is removed; a non-empty one needs --force and an archive", async () => {
    const w = world();
    const empty = path.join(w.scratchRoot, "probe");
    fs.mkdirSync(empty);
    const full = path.join(w.scratchRoot, "notes");
    fs.mkdirSync(full);
    fs.writeFileSync(path.join(full, "n.txt"), "n\n");
    w.entries.push(
      { key: "probe", path: empty, class: "G", openedAt: "2026-10-06T14:00:00Z" },
      { key: "notes", path: full, class: "G", openedAt: "2026-10-06T14:00:00Z" },
    );
    writeRegistry(w);
    const d = deps(w, fakeArchive(w, { ok: true, archivePath: "/a/notes.bundle" }));
    assert.deepEqual(await closeMod.closeCopy({ key: "probe" }, d), { key: "probe", removed: true, archived: false });
    assert.equal(fs.existsSync(empty), false);
    assert.equal((await exitOf(closeMod.closeCopy({ key: "notes" }, d))).code, 7);
    assert.equal(fs.existsSync(full), true);
    const res = await closeMod.closeCopy({ key: "notes", force: true }, d);
    assert.equal(res.archived, true);
    assert.equal(fs.existsSync(full), false);
    assert.deepEqual(registryKeys(w), []);
  });

  it("scratch worktree (detached head): removed, base pruned, no branch deleted", async () => {
    const w = world();
    const copy = path.join(w.scratchRoot, "tryout");
    git(w.basePath, "worktree", "add", "--detach", copy, "refs/remotes/origin/main");
    w.entries.push({ key: "tryout", repo: "acme/widgets", path: copy, class: "G", openedAt: "2026-10-06T14:00:00Z" });
    writeRegistry(w);
    const res = await closeMod.closeCopy({ key: "tryout" }, deps(w, fakeArchive(w, { ok: true })));
    assert.equal(res.removed, true);
    assert.equal(fs.existsSync(copy), false);
    assert.doesNotMatch(worktrees(w), /tryout/);
  });

  it("CLI handler shape: positionals/flags in, contract result out; wrong arity is exit 2", async () => {
    const w = world();
    openTask(w, "ABC-112");
    const res = await closeMod.close({ positionals: ["ABC-112"], flags: { json: true, force: false }, env: deps(w).env }, deps(w, fakeArchive(w, { ok: true })));
    assert.deepEqual(res, { key: "ABC-112", removed: true, archived: false });
    for (const positionals of [[], ["A-1", "B-2"]]) {
      const r = await exitOf(closeMod.close({ positionals, flags: {}, env: {} }, deps(w)));
      assert.equal(r.code, 2);
    }
    const e = await exitOf(closeMod.closeCopy({ key: "ZZZ-9" }, deps(w)));
    assert.equal(e.name, "MyrWsError");
  });
});
