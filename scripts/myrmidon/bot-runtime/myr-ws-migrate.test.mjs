import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// myrmidon(1.6.5 BOT-DISK-H2f): docker/bot-runtime/myr-ws/lib/migrate.js — the
// git-objects mirror (+refs/heads/*:refs/heads/*) becomes a class-D base. Real
// git, local file:// origin, placeholder owners only; nothing touches the network.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const WS_DIR = path.join(ROOT, "docker/bot-runtime/myr-ws");
const FIXTURE = path.join(ROOT, "docs/myrmidon/bot-disk-contract/myr-ws-migrate.json");
const require = createRequire(import.meta.url);
const { migrate, migrateAll, listMirrors, command, MIGRATED_MARKER } = require(path.join(WS_DIR, "lib/migrate.js"));
const { run } = require(path.join(WS_DIR, "lib/cli.js"));
const L = require(path.join(WS_DIR, "lib/layout.js"));

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
let originRoot;

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...GIT_ENV, HOME: tmp } });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function tryGit(cwd, ...args) {
  return spawnSync("git", args, { cwd, encoding: "utf8", env: { ...GIT_ENV, HOME: tmp } });
}

/** Origin with two branches and two commits on main; returns the commit ids. */
function makeOrigin(owner, repo) {
  const bare = path.join(originRoot, owner, `${repo}.git`);
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  git(tmp, "init", "--bare", "--quiet", "-b", "main", bare);
  const work = fs.mkdtempSync(path.join(tmp, "work-"));
  git(work, "init", "--quiet", "-b", "main");
  fs.writeFileSync(path.join(work, "a.txt"), "one\n");
  git(work, "add", ".");
  git(work, "commit", "--quiet", "-m", "c1");
  fs.writeFileSync(path.join(work, "a.txt"), "two\n");
  git(work, "commit", "--quiet", "-am", "c2");
  git(work, "checkout", "--quiet", "-b", "feature/x");
  fs.writeFileSync(path.join(work, "b.txt"), "x\n");
  git(work, "add", ".");
  git(work, "commit", "--quiet", "-m", "c3");
  git(work, "push", "--quiet", bare, "main", "feature/x");
  return { bare, main: git(work, "rev-parse", "main"), feature: git(work, "rev-parse", "feature/x") };
}

function newHome() {
  return fs.mkdtempSync(path.join(tmp, "home-"));
}

function envFor(home) {
  return {
    ...GIT_ENV,
    HOME: tmp,
    MYRMIDON_WS_HOME: home,
    MYRMIDON_GIT_REAL: "git",
    MYRMIDON_WS_REMOTE_BASE: `file://${originRoot}`,
  };
}

/** Old-style mirror (heads -> heads) with a secret-looking origin URL, plus a clone that borrows its objects. */
function makeMirror(home, owner, repo, origin) {
  const dir = path.join(home, "git-objects", owner, `${repo}.git`);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  git(tmp, "init", "--bare", "--quiet", "-b", "main", dir);
  git(dir, "remote", "add", "origin", `https://user:SECRET@example.invalid/${owner}/${repo}.git`);
  git(dir, "config", "remote.origin.fetch", "+refs/heads/*:refs/heads/*");
  git(dir, "fetch", "--quiet", `file://${origin.bare}`, "+refs/heads/*:refs/heads/*");
  return dir;
}

function makeAlternatesClone(mirror, name) {
  const clone = path.join(tmp, name);
  git(tmp, "clone", "--quiet", "--shared", mirror, clone);
  assert.ok(fs.readFileSync(path.join(clone, ".git/objects/info/alternates"), "utf8").includes(mirror));
  return clone;
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "myr-ws-migrate-"));
  originRoot = path.join(tmp, "origin");
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("myr-ws migrate", { skip: !hasGit }, () => {
  it("turns an old-refspec mirror into a base with the standard refspec; all commits reachable; alternates clone keeps working", () => {
    const home = newHome();
    const o = makeOrigin("acme", "widgets");
    const mirror = makeMirror(home, "acme", "widgets", o);
    const clone = makeAlternatesClone(mirror, "clone-a");
    const env = envFor(home);

    const res = migrate("acme/widgets", { env });
    const base = path.join(home, "git-base/acme/widgets.git");
    assert.deepEqual(res, { repo: "acme/widgets", basePath: base, refs: 2 });

    // standard refspec and hygiene, no credentials from the mirror
    assert.equal(git(base, "config", "--get-all", "remote.origin.fetch"), L.WS_GIT_BASE_REFSPEC);
    assert.equal(git(base, "config", "fetch.prune"), "true");
    assert.equal(git(base, "config", "gc.auto"), "0");
    assert.equal(git(base, "config", "gc.pruneExpire"), "never");
    const cfg = fs.readFileSync(path.join(base, "config"), "utf8");
    assert.ok(!cfg.includes("SECRET") && !cfg.includes("user:"), "mirror credentials must not leak into the base");

    // every commit reachable through the new refs
    assert.equal(git(base, "rev-parse", "refs/remotes/origin/main"), o.main);
    assert.equal(git(base, "rev-parse", "refs/remotes/origin/feature/x"), o.feature);
    assert.equal(git(base, "rev-list", "--count", "refs/remotes/origin/feature/x"), "3");
    assert.equal(git(base, "fsck", "--connectivity-only"), "");
    assert.equal(tryGit(base, "rev-parse", "--verify", "--quiet", "refs/heads/main").status, 1, "no refs/heads in the base");

    // mirror kept, marked; old clone still works
    assert.ok(fs.existsSync(path.join(mirror, MIGRATED_MARKER)));
    assert.ok(fs.existsSync(path.join(mirror, "HEAD")));
    assert.equal(git(clone, "log", "--oneline", "origin/feature/x").split("\n").length, 3);
    assert.equal(git(clone, "log", "--oneline", "-n", "1").split("\n").length, 1);
    assert.equal(git(clone, "fsck", "--connectivity-only"), "");
    assert.equal(git(mirror, "rev-parse", "refs/heads/main"), o.main, "mirror refs untouched");

    // the base does not borrow from the mirror
    assert.ok(!fs.existsSync(path.join(base, "objects/info/alternates")));
  });

  it("is a no-op on the second run", () => {
    const home = newHome();
    const o = makeOrigin("acme", "gadgets");
    const mirror = makeMirror(home, "acme", "gadgets", o);
    const env = envFor(home);
    const first = migrate("acme/gadgets", { env });
    const base = first.basePath;
    const marker = fs.readFileSync(path.join(mirror, MIGRATED_MARKER), "utf8");
    const headIno = fs.statSync(path.join(base, "HEAD")).ino;
    const refsBefore = git(base, "for-each-ref");
    const second = migrate("acme/gadgets", { env });
    assert.deepEqual(second, first);
    assert.equal(fs.readFileSync(path.join(mirror, MIGRATED_MARKER), "utf8"), marker, "marker not rewritten");
    assert.equal(fs.statSync(path.join(base, "HEAD")).ino, headIno);
    assert.equal(git(base, "for-each-ref"), refsBefore);
    assert.deepEqual(migrateAll({ env }), { results: [], errors: [] });
  });

  it("failed fsck: mirror not marked, no base left, exit code != 0", () => {
    const home = newHome();
    const o = makeOrigin("acme", "broken");
    const mirror = makeMirror(home, "acme", "broken", o);
    // lose a tree object: refs still resolve, connectivity does not
    const tree = git(mirror, "rev-parse", "refs/heads/main^{tree}");
    const loose = path.join(mirror, "objects", tree.slice(0, 2), tree.slice(2));
    assert.ok(fs.existsSync(loose), "small fetch leaves loose objects");
    fs.rmSync(loose);
    assert.equal(tryGit(mirror, "fsck", "--connectivity-only").status !== 0, true, "precondition: mirror is broken");
    const env = envFor(home);
    assert.throws(
      () => migrate("acme/broken", { env }),
      (e) => e.name === "MyrWsError" && e.exitCode !== 0 && /integrity/.test(e.message),
    );
    assert.ok(!fs.existsSync(path.join(mirror, MIGRATED_MARKER)), "mirror must stay unmarked");
    assert.ok(!fs.existsSync(path.join(home, "git-base/acme/broken.git")), "no half-built base");
    assert.ok(!fs.existsSync(path.join(home, "git-base/acme/broken.git.migrating")));
  });

  it("CLI frame: exit code != 0 and the contract error shape on failure", async () => {
    const home = newHome();
    const env = envFor(home);
    const r = await run(["migrate", "acme/none", "--json"], { env, commands: { migrate: command } });
    assert.equal(r.exitCode, 6);
    const body = JSON.parse(r.stdout);
    assert.equal(body.ok, false);
    assert.equal(body.exitCode, 6);
    const bad = await run(["migrate", "--json"], { env, commands: { migrate: command } });
    assert.equal(bad.exitCode, 2);
  });

  it("matches the contract fixture (myr-ws-migrate.json) in shape and types", async () => {
    const home = newHome();
    const o = makeOrigin("acme", "shape");
    makeMirror(home, "acme", "shape", o);
    const env = envFor(home);
    const r = await run(["migrate", "acme/shape", "--json"], { env, commands: { migrate: command } });
    assert.equal(r.exitCode, 0);
    const out = JSON.parse(r.stdout);
    const fx = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
    assert.deepEqual(Object.keys(out).sort(), Object.keys(fx).sort());
    assert.equal(out.ok, true);
    assert.match(out.repo, /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/);
    assert.ok(path.isAbsolute(out.basePath) && out.basePath.endsWith(".git"));
    assert.ok(Number.isInteger(out.refs) && out.refs >= 0);
    for (const k of Object.keys(fx)) assert.equal(typeof out[k], typeof fx[k], k);
  });

  it("refuses a ninth base (exit 4) and a bad name (exit 2)", () => {
    const home = newHome();
    const o = makeOrigin("acme", "ninth");
    makeMirror(home, "acme", "ninth", o);
    for (let i = 0; i < L.WS_GIT_BASE_LIMIT; i++) {
      fs.mkdirSync(path.join(home, "git-base/other", `r${i}.git`), { recursive: true });
      fs.writeFileSync(path.join(home, "git-base/other", `r${i}.git`, "HEAD"), "ref: refs/heads/main\n");
    }
    const env = envFor(home);
    assert.throws(() => migrate("acme/ninth", { env }), (e) => e.exitCode === 4);
    assert.ok(!fs.existsSync(path.join(home, "git-objects/acme/ninth.git", MIGRATED_MARKER)));
    assert.throws(() => migrate("../etc/passwd", { env }), (e) => e.exitCode === 2);
    assert.throws(() => migrate("acme/x/y", { env }), (e) => e.exitCode === 2);
  });

  it("merges into a base that already exists without overwriting its refs", () => {
    const home = newHome();
    const o = makeOrigin("acme", "prebuilt");
    const mirror = makeMirror(home, "acme", "prebuilt", o);
    const env = envFor(home);
    const base = path.join(home, "git-base/acme/prebuilt.git");
    fs.mkdirSync(path.dirname(base), { recursive: true });
    git(tmp, "init", "--bare", "--quiet", base);
    git(base, "fetch", "--quiet", `file://${o.bare}`, "+refs/heads/main:refs/remotes/origin/main");
    const res = migrate("acme/prebuilt", { env });
    assert.equal(res.refs, 2);
    assert.equal(git(base, "rev-parse", "refs/remotes/origin/feature/x"), o.feature);
    assert.ok(fs.existsSync(path.join(mirror, MIGRATED_MARKER)));
  });

  it("migrateAll collects per-repo errors and keeps going; listMirrors sees marks", () => {
    const home = newHome();
    const a = makeOrigin("acme", "all-a");
    const b = makeOrigin("acme", "all-b");
    makeMirror(home, "acme", "all-a", a);
    const mb = makeMirror(home, "acme", "all-b", b);
    const tree = git(mb, "rev-parse", "refs/heads/main^{tree}");
    const loose = path.join(mb, "objects", tree.slice(0, 2), tree.slice(2));
    fs.rmSync(loose);
    const env = envFor(home);
    const out = migrateAll({ env });
    assert.equal(out.results.length, 1);
    assert.equal(out.results[0].repo, "acme/all-a");
    assert.equal(out.errors.length, 1);
    assert.equal(out.errors[0].repo, "acme/all-b");
    assert.notEqual(out.errors[0].exitCode, 0);
    const marks = Object.fromEntries(listMirrors(env).map((m) => [m.slug, m.migrated]));
    assert.deepEqual(marks, { "acme/all-a": true, "acme/all-b": false });
  });
});
