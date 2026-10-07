import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// myrmidon(1.6.5-BOT-DISK-H, rc.9): nested repositories are seen by the classifier, archived one by
// one before a directory is removed, and a truncated or failed archive keeps the directory;
// `botd --once --plan` is a dry run. Fixtures on disk, no network.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const lib = (n) => path.join(ROOT, "docker/bot-runtime/botd/lib", n);
const { measureTree, classifyAll, toInventory } = await import(lib("classify.js"));
const { findNestedGit, scratchInventory, archiveThenRemove } = await import(lib("legacy.js"));
const archiveMod = await import(lib("archive.js"));
const hasGit = spawnSync("git", ["--version"]).status === 0;

let tmp;
let archiveRoot;

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
function gitRepo(dir, { dirty = true } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const g = (...a) => spawnSync("git", a, { cwd: dir, encoding: "utf8", env: GIT_ENV });
  assert.equal(g("init", "-q", "-b", "main").status, 0);
  fs.writeFileSync(path.join(dir, "tracked.txt"), "v1\n");
  g("add", "."), g("commit", "-q", "-m", "c");
  if (dirty) {
    fs.writeFileSync(path.join(dir, "tracked.txt"), "v2 dirty\n");
    fs.writeFileSync(path.join(dir, "untracked.txt"), "work in progress\n");
  }
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "botd-policy-"));
  archiveRoot = path.join(tmp, "archive");
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("nested repositories are seen", () => {
  it("measureTree and findNestedGit list repositories below the root, not the root's own, not node_modules", () => {
    const dir = path.join(tmp, "classify", "srv-dev");
    for (const sub of ["repo", "sub/x", "a/b/c"]) fs.mkdirSync(path.join(dir, sub, ".git"), { recursive: true });
    fs.mkdirSync(path.join(dir, ".git"), { recursive: true }); // its own
    fs.mkdirSync(path.join(dir, "node_modules/pkg/.git"), { recursive: true });
    fs.mkdirSync(path.join(dir, "a/b/c/d/.git"), { recursive: true }); // too deep
    const expected = [path.join(dir, "a/b/c"), path.join(dir, "repo"), path.join(dir, "sub/x")];
    assert.deepEqual(measureTree(dir).nestedGit, expected);
    assert.deepEqual(findNestedGit(dir), expected);
  });

  it("a directory with only nested repositories counts as git in the inventory", () => {
    const dir = path.join(tmp, "inv", "srv-dev");
    fs.mkdirSync(path.join(dir, "repo", ".git"), { recursive: true });
    const items = [{ path: dir, class: "G", sign: null, ageSec: 99999, sizeBytes: 5, mtimeMs: 1, isGit: false, nestedGit: [path.join(dir, "repo")] }];
    const [sc] = scratchInventory([], items, Date.now(), () => false);
    assert.equal(sc.isGit, true);
    assert.deepEqual(sc.nestedGit, [path.join(dir, "repo")]);
    assert.equal(toInventory(items).scratch[0].isGit, true);
  });
});

describe("archiveThenRemove with nested repositories", { skip: !hasGit && "git not available" }, () => {
  const hasDotGit = (p) => fs.existsSync(path.join(p, ".git"));
  const mk = () => {
    const removed = [];
    return { removed, remove: (p) => removed.push(p) };
  };

  it("srv-dev: two nested repositories with dirty files are archived one by one, plus the tree, then removed", () => {
    const dir = path.join(tmp, "ws1", "srv-dev");
    gitRepo(path.join(dir, "api"));
    gitRepo(path.join(dir, "web/app"));
    fs.writeFileSync(path.join(dir, "notes.txt"), "loose file\n");
    const { removed, remove } = mk();
    const detail = archiveThenRemove({ path: dir, key: "srv-dev" }, { archiveMod, isGit: hasDotGit, remove, archiveRoot, nestedGit: findNestedGit });
    assert.match(detail, /2 nested repositories/);
    assert.deepEqual(removed, [dir]);
    const entries = archiveMod.readManifest(archiveRoot).archives;
    const keys = entries.map((e) => e.key).sort();
    assert.deepEqual(keys.filter((k) => k.startsWith("srv-dev")), ["srv-dev", "srv-dev--api", "srv-dev--web_app"]);
    const api = entries.find((e) => e.key === "srv-dev--api");
    assert.ok(api.patch && fs.readFileSync(api.patch, "utf8").includes("v2 dirty"));
    assert.ok(api.untrackedTar && spawnSync("tar", ["-tf", api.untrackedTar], { encoding: "utf8" }).stdout.includes("untracked.txt"));
    assert.ok(api.bundle === undefined || fs.existsSync(api.bundle));
    const tree = entries.find((e) => e.key === "srv-dev");
    assert.match(spawnSync("tar", ["-tf", tree.dirTar], { encoding: "utf8" }).stdout, /notes\.txt/);
  });

  it("a truncated archive of ANY part keeps the whole directory", () => {
    const dir = path.join(tmp, "ws2", "srv-dev");
    gitRepo(path.join(dir, "api"));
    const { removed, remove } = mk();
    const truncating = {
      archive: (p, key, o) => {
        const r = archiveMod.archive(p, key, o);
        return r.ok ? { ...r, entry: { ...r.entry, truncatedUntracked: true } } : r;
      },
      archiveTree: archiveMod.archiveTree,
    };
    assert.throws(
      () => archiveThenRemove({ path: dir, key: "srv-dev" }, { archiveMod: truncating, isGit: hasDotGit, remove, archiveRoot, nestedGit: findNestedGit }),
      /archive-incomplete: nested repository api: untracked files over the cap/,
    );
    assert.deepEqual(removed, []);
    assert.ok(fs.existsSync(path.join(dir, "api", "untracked.txt")));
  });

  it("a failing nested archive keeps the directory and stops before the tree is archived", () => {
    const dir = path.join(tmp, "ws3", "srv-dev");
    gitRepo(path.join(dir, "api"));
    const { removed, remove } = mk();
    let treeCalled = false;
    const failing = { archive: () => ({ ok: false, reason: "boom" }), archiveTree: () => ((treeCalled = true), { ok: true, entry: {} }) };
    assert.throws(() => archiveThenRemove({ path: dir, key: "srv-dev" }, { archiveMod: failing, isGit: hasDotGit, remove, archiveRoot, nestedGit: findNestedGit }), /archive-incomplete/);
    assert.deepEqual(removed, []);
    assert.equal(treeCalled, false);
  });

  it("a repository without nested ones keeps the old behavior (no tree archive next to it)", () => {
    const dir = path.join(tmp, "ws4", "OPE-9");
    gitRepo(dir);
    const { removed, remove } = mk();
    assert.equal(archiveThenRemove({ path: dir, key: "OPE-9" }, { archiveMod, isGit: hasDotGit, remove, archiveRoot, nestedGit: findNestedGit }), "archived, removed");
    assert.deepEqual(removed, [dir]);
    assert.equal(archiveMod.readManifest(archiveRoot).archives.find((e) => e.key === "OPE-9").dirTar, undefined);
  });
});

describe("botd --once --plan", () => {
  it("is a dry run: JSON on stdout, the disk is untouched, no board needed", () => {
    const home = path.join(tmp, "plan-home");
    const hermes = path.join(home, "hermes");
    fs.mkdirSync(hermes, { recursive: true });
    const marker = path.join(tmp, "plan-ws", "OPE-1", "f.txt");
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, "x");
    // the entry is CommonJS; the repository's package.json makes extension-less files ESM, so run a copy
    const entryDir = path.join(tmp, "plan-entry");
    fs.mkdirSync(entryDir, { recursive: true });
    fs.writeFileSync(path.join(entryDir, "botd.cjs"), fs.readFileSync(path.join(ROOT, "docker/bot-runtime/botd/botd"), "utf8").replace(/^#!.*\n/, ""));
    fs.symlinkSync(path.join(ROOT, "docker/bot-runtime/botd/lib"), path.join(entryDir, "lib"));
    const r = spawnSync(process.execPath, [path.join(entryDir, "botd.cjs"), "--once", "--plan"], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HERMES_HOME: hermes,
        MYRMIDON_WS_HOME: path.join(home, "ws"),
        MYRMIDON_BOTD_ENV_FILE: path.join(home, "none.env"),
        MYRMIDON_WS_BIN: "/nonexistent/myr-ws",
      },
    });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim().split("\n").pop());
    assert.equal(out.desiredOk, false);
    assert.deepEqual(out.actions, []);
    assert.ok(fs.existsSync(marker));
    assert.equal(fs.existsSync(path.join(home, "ws", "disk-state.json")), false);
  });
});
