import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// myrmidon(1.6.2 BOT-DISK-C): docker/bot-runtime/git-reference/git — the git
// wrapper that makes the board's shared mirrors transparent — and the
// bot-clone-hygiene reporter that sits next to it. Placeholder owners and
// repositories only; nothing here touches the network.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const WRAPPER_SRC = path.join(ROOT, "docker/bot-runtime/git-reference/git");
const HYGIENE = path.join(ROOT, "docker/bot-runtime/git-reference/bot-clone-hygiene");

const hasGit = spawnSync("git", ["--version"]).status === 0;
const hasPython = spawnSync("python3", ["--version"]).status === 0;

let tmp;
let wrapper; // CommonJS copy of the wrapper, loadable by require()
let lib;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "git-reference-test-"));
  wrapper = path.join(tmp, "git-wrapper.cjs");
  fs.copyFileSync(WRAPPER_SRC, wrapper);
  lib = createRequire(import.meta.url)(wrapper);
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function git(cwd, ...args) {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: tmp,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

describe("git wrapper: which clones get a reference", () => {
  const mirrors = () => {
    const root = path.join(tmp, "mirrors");
    fs.mkdirSync(path.join(root, "owner", "repo.git", "objects"), { recursive: true });
    fs.writeFileSync(path.join(root, "owner", "repo.git", "HEAD"), "ref: refs/heads/main\n");
    return root;
  };

  it("recognises https, ssh and scp-like GitHub URLs, case-insensitively, and nothing else", () => {
    for (const url of [
      "https://github.com/Owner/Repo",
      "https://github.com/owner/repo.git",
      "https://www.github.com/owner/repo/",
      "git@github.com:owner/repo.git",
      "ssh://git@github.com/owner/repo",
    ]) {
      assert.equal(lib.githubRepo(url), "owner/repo", url);
    }
    for (const url of [
      "https://gitlab.com/owner/repo",
      "https://github.com.evil.example/owner/repo",
      "https://github.com/owner",
      "https://github.com/owner/repo/extra",
      "https://github.com/-bad/repo",
      "https://github.com/owner/..",
      "/local/path/repo",
      "http://github.com/owner/repo",
    ]) {
      assert.equal(lib.githubRepo(url), null, url);
    }
  });

  it("adds --reference-if-able for a mirrored repository, after global options", () => {
    const root = mirrors();
    const mirror = path.join(root, "owner", "repo.git");
    assert.deepEqual(lib.rewriteArgs(["clone", "https://github.com/Owner/Repo", "dest"], root), [
      "clone",
      "--reference-if-able",
      mirror,
      "https://github.com/Owner/Repo",
      "dest",
    ]);
    assert.deepEqual(lib.rewriteArgs(["-C", "/x", "-c", "a=b", "clone", "-b", "main", "git@github.com:owner/repo.git"], root), [
      "-C",
      "/x",
      "-c",
      "a=b",
      "clone",
      "--reference-if-able",
      mirror,
      "-b",
      "main",
      "git@github.com:owner/repo.git",
    ]);
  });

  it("leaves everything else untouched", () => {
    const root = mirrors();
    const untouched = [
      ["status"],
      ["fetch", "https://github.com/owner/repo"],
      ["clone", "https://github.com/owner/unmirrored", "d"], // no mirror
      ["clone", "https://gitlab.com/owner/repo", "d"],
      ["clone", "--dissociate", "https://github.com/owner/repo"],
      ["clone", "--filter=blob:none", "https://github.com/owner/repo"],
      ["clone", "--mirror", "https://github.com/owner/repo"],
      ["clone", "--shared", "https://github.com/owner/repo"],
      ["clone"],
      [],
    ];
    for (const argv of untouched) assert.deepEqual(lib.rewriteArgs(argv, root), argv, JSON.stringify(argv));
    // An option value that looks like a URL is not the repository.
    assert.deepEqual(
      lib.rewriteArgs(["clone", "-o", "https://github.com/owner/repo", "https://gitlab.com/o/r"], root),
      ["clone", "-o", "https://github.com/owner/repo", "https://gitlab.com/o/r"],
    );
  });

  // myrmidon(1.6.5 BOT-DISK-G-A): naming a reference or bounding the history is
  // not a decision about OUR storage. Task clones in the field carry exactly
  // `--reference-if-able <stale> --depth 50`; while those counted as opt-outs
  // the store stayed empty on every bot and each clone copied a full history.
  it("still adds the store's reference to a clone that names a reference or bounds its history", () => {
    const root = mirrors();
    const mirror = path.join(root, "owner", "repo.git");
    for (const argv of [
      ["clone", "--reference", "/x", "https://github.com/owner/repo"],
      ["clone", "--reference-if-able", "/workspace/myrmidon", "--depth", "50", "https://github.com/owner/repo"],
      ["clone", "--depth", "1", "https://github.com/owner/repo", "dest"],
      ["clone", "--depth=1", "https://github.com/owner/repo"],
      ["clone", "--shallow-since", "2026-01-01", "https://github.com/owner/repo"],
      ["clone", "--no-local", "https://github.com/owner/repo"],
    ]) {
      const out = lib.rewriteArgs(argv, root);
      assert.equal(out[1], "--reference-if-able", JSON.stringify(argv));
      assert.equal(out[2], mirror, JSON.stringify(argv));
      assert.deepEqual(out.slice(3), argv.slice(1), `the caller's own argv survives: ${JSON.stringify(argv)}`);
    }
    // A clone that does decide the storage of its own objects stays untouched.
    for (const argv of [
      ["clone", "--dissociate", "--depth", "1", "https://github.com/owner/repo"],
      ["clone", "--shared", "https://github.com/owner/repo"],
      ["clone", "-s", "https://github.com/owner/repo"],
      ["clone", "--local", "/src", "dest"],
      ["clone", "--mirror", "https://github.com/owner/repo"],
      ["clone", "--filter", "blob:none", "https://github.com/owner/repo"],
    ]) {
      assert.deepEqual(lib.rewriteArgs(argv, root), argv, JSON.stringify(argv));
    }
    // The scanner names exactly the same opt-outs.
    for (const [argv, detail] of [
      [["clone", "--dissociate", "https://github.com/owner/repo"], "--dissociate"],
      [["clone", "--shared", "https://github.com/owner/repo"], "--shared"],
      [["clone", "--mirror", "https://github.com/owner/repo"], "--mirror"],
      [["clone", "--filter=blob:none", "https://github.com/owner/repo"], "--filter=blob:none"],
      [["clone", "--filter", "blob:none", "https://github.com/owner/repo"], "--filter"],
    ]) {
      assert.equal(lib.scanClone(argv).optOut, detail, JSON.stringify(argv));
    }
    assert.equal(lib.scanClone(["clone", "--reference-if-able", "/x", "--depth", "50", "https://github.com/owner/repo"]).optOut, null);
  });

  it("never builds a mirror path from an unsafe name", () => {
    const root = mirrors();
    for (const url of ["https://github.com/owner/..%2f..", "https://github.com/../repo", "https://github.com/owner/re po"]) {
      const argv = ["clone", url];
      assert.deepEqual(lib.rewriteArgs(argv, root), argv, url);
    }
  });

  // myrmidon(1.6.5 BOT-DISK-G): the bot-local mirror is the second reference source.
  it("prefers the board's mirror and falls back to the local one; scanCloneArgs finds only rewritable clones", () => {
    const root = mirrors();
    const local = path.join(tmp, "local-store", "owner", "repo.git");
    const argv = ["clone", "https://github.com/owner/repo", "dest"];
    // Board mirror wins when both exist.
    assert.deepEqual(lib.rewriteArgs(argv, root, local), ["clone", "--reference-if-able", path.join(root, "owner", "repo.git"), "https://github.com/owner/repo", "dest"]);
    // No board mirror: the local one is used.
    assert.deepEqual(lib.rewriteArgs(argv, path.join(tmp, "no-board"), local), ["clone", "--reference-if-able", local, "https://github.com/owner/repo", "dest"]);
    // Neither: untouched.
    assert.deepEqual(lib.rewriteArgs(argv, path.join(tmp, "no-board"), null), argv);
    // scanCloneArgs names the repository of exactly the clones rewriteArgs would touch.
    assert.deepEqual(lib.scanCloneArgs(argv), { cloneAt: 0, url: "https://github.com/owner/repo" });
    assert.deepEqual(lib.scanCloneArgs(["-C", "/x", "clone", "-b", "main", "git@github.com:owner/repo.git"]), { cloneAt: 2, url: "git@github.com:owner/repo.git" });
    assert.deepEqual(lib.scanCloneArgs(["clone", "--", "https://github.com/owner/repo"]), { cloneAt: 0, url: "https://github.com/owner/repo" });
    // A named reference or a bounded history is still a clone the store takes
    // (BOT-DISK-G-A): only the options that decide our storage opt out.
    assert.deepEqual(lib.scanCloneArgs(["clone", "--depth", "1", "https://github.com/owner/repo"]), { cloneAt: 0, url: "https://github.com/owner/repo" });
    assert.deepEqual(lib.scanCloneArgs(["clone", "--reference-if-able", "/workspace/myrmidon", "--depth", "50", "https://github.com/owner/repo"]), { cloneAt: 0, url: "https://github.com/owner/repo" });
    for (const other of [["status"], ["clone", "--dissociate", "https://github.com/owner/repo"], ["clone", "--shared", "https://github.com/owner/repo"], ["clone", "--mirror", "https://github.com/owner/repo"], ["clone"], ["-c", "a=b", "fetch"]]) {
      assert.equal(lib.scanCloneArgs(other), null, JSON.stringify(other));
    }
  });

  it("resolves the local store: environment first, then the profile .env, then the default under HERMES_HOME", () => {
    const home = path.join(tmp, "store-home");
    fs.mkdirSync(home, { recursive: true });
    assert.equal(lib.localMirrorRoot({}, home), path.join(home, ".myrmidon", "git-objects"));
    fs.writeFileSync(path.join(home, ".env"), 'MYRMIDON_GIT_LOCAL_MIRROR="/bot-scope/.git-objects"\n', "utf8");
    assert.equal(lib.localMirrorRoot({}, home), "/bot-scope/.git-objects");
    assert.equal(lib.localMirrorRoot({ MYRMIDON_GIT_LOCAL_MIRROR: "/env/override" }, home), "/env/override");
    // An explicit empty value is kept: the store is off.
    assert.equal(lib.localMirrorRoot({ MYRMIDON_GIT_LOCAL_MIRROR: "" }, home), "");
  });
});

describe("git wrapper: end to end with a local mirror", { skip: !hasGit }, () => {
  it("clones with an alternate to the mirror, passes the exit status through, and other commands run unchanged", () => {
    // A "GitHub" repository that exists only as a local path, reached through insteadOf.
    const origin = path.join(tmp, "origin");
    fs.mkdirSync(origin);
    git(origin, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(origin, "a.txt"), "a\n");
    git(origin, "add", ".");
    git(origin, "commit", "-q", "-m", "one");

    const mirrorRoot = path.join(tmp, "e2e-mirrors");
    const mirror = path.join(mirrorRoot, "owner", "repo.git");
    fs.mkdirSync(path.dirname(mirror), { recursive: true });
    git(tmp, "clone", "-q", "--bare", origin, mirror);

    const env = {
      PATH: process.env.PATH,
      HOME: tmp,
      GIT_CONFIG_NOSYSTEM: "1",
      MYRMIDON_GIT_REAL: spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim(),
      MYRMIDON_GIT_MIRROR_ROOT: mirrorRoot,
    };
    const dest = path.join(tmp, "clone");
    const run = (...args) => spawnSync(process.execPath, [wrapper, ...args], { env, encoding: "utf8", cwd: tmp });

    const cloned = run("-c", `url.file://${origin}.insteadOf=https://github.com/owner/repo`, "clone", "-q", "https://github.com/owner/repo", dest);
    assert.equal(cloned.status, 0, cloned.stderr);
    const alternates = fs.readFileSync(path.join(dest, ".git", "objects", "info", "alternates"), "utf8").trim();
    // git records the realpath of the alternate; a tmpdir behind a symlink (a container's
    // scratch under a linked home) must not make this comparison depend on spelling.
    assert.equal(alternates, fs.realpathSync(path.join(mirror, "objects")));
    assert.equal(fs.readFileSync(path.join(dest, "a.txt"), "utf8"), "a\n");
    // The clone's own object store holds no commit, tree or blob of the mirrored history.
    const own = git(dest, "count-objects", "-v");
    assert.match(own, /^count: 0$/m);
    assert.match(own, /^in-pack: 0$/m);

    assert.equal(run("rev-parse", "--is-inside-work-tree").status, 128); // not a repository: status passes through
    assert.equal(run("-C", dest, "rev-parse", "--is-inside-work-tree").stdout.trim(), "true");
  });
});

// myrmidon(1.6.5 BOT-DISK-G): the bot's OWN mirror, made on the first clone and
// borrowed by every later one, with no board /cache/git mount anywhere.
describe("git wrapper: bot-local mirror end to end", { skip: !hasGit }, () => {
  const realGit = () => spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();

  /** A local "GitHub" origin, reached from the wrapper through insteadOf. */
  function makeOrigin(name) {
    const origin = path.join(tmp, name);
    fs.mkdirSync(origin);
    git(origin, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(origin, "a.txt"), "a\n");
    git(origin, "add", ".");
    git(origin, "commit", "-q", "-m", "one");
    fs.writeFileSync(path.join(origin, "b.txt"), "b\n");
    git(origin, "add", ".");
    git(origin, "commit", "-q", "-m", "two");
    return origin;
  }

  function runWrapper(storeRoot, mirrorRoot, ...args) {
    return spawnSync(process.execPath, [wrapper, ...args], {
      encoding: "utf8",
      cwd: tmp,
      env: {
        PATH: process.env.PATH,
        HOME: tmp,
        HERMES_HOME: path.join(tmp, "hermes-home"), // where a bypass trail would be written
        GIT_CONFIG_NOSYSTEM: "1",
        MYRMIDON_GIT_REAL: realGit(),
        MYRMIDON_GIT_MIRROR_ROOT: mirrorRoot,
        MYRMIDON_GIT_LOCAL_MIRROR: storeRoot,
      },
    });
  }

  it("first clone builds the mirror, later clones borrow its objects, gc never prunes", () => {
    const origin = makeOrigin("local-origin");
    const store = path.join(tmp, "local-store");
    const noBoard = path.join(tmp, "no-board-mirrors");
    const instead = `url.file://${origin}.insteadOf=https://github.com/owner/repo`;
    const cloneUrl = "https://github.com/owner/repo";

    const first = path.join(tmp, "local-clone1");
    const r1 = runWrapper(store, noBoard, "-c", instead, "clone", "-q", cloneUrl, first);
    assert.equal(r1.status, 0, r1.stderr);
    assert.match(r1.stderr, /shared object store: first fetch/);
    const mirror = path.join(store, "owner", "repo.git");
    assert.ok(fs.existsSync(path.join(mirror, "objects")), "the store holds a bare mirror after the first clone");
    // git writes the realpath of the alternate (the tmp dir may live behind a symlink).
    assert.equal(fs.readFileSync(path.join(first, ".git", "objects", "info", "alternates"), "utf8").trim(), fs.realpathSync(path.join(mirror, "objects")));
    // gc of the mirror must keep objects a borrowed clone may still read.
    const gcAuto = git(mirror, "config", "gc.auto");
    const prune = git(mirror, "config", "gc.pruneExpire");
    assert.equal(gcAuto, "0");
    assert.equal(prune, "never");
    // Only the board's own objects live in the clone.
    const own = git(first, "count-objects", "-v");
    assert.match(own, /^count: 0$/m);

    // A second clone borrows too, without a second fetch (the stamp is fresh).
    const second = path.join(tmp, "local-clone2");
    const r2 = runWrapper(store, noBoard, "-c", instead, "clone", "-q", cloneUrl, second);
    assert.equal(r2.status, 0, r2.stderr);
    assert.doesNotMatch(r2.stderr, /first fetch/, "the second clone does not rebuild the mirror");
    assert.ok(fs.existsSync(path.join(second, ".git", "objects", "info", "alternates")));
    // The clone reads the mirrored history through the alternate.
    assert.equal(git(second, "log", "--oneline").split("\n").length, 2);

    // A clone with its own storage decision is not touched.
    const dissociated = path.join(tmp, "local-clone3");
    const r3 = runWrapper(store, noBoard, "-c", instead, "clone", "-q", "--dissociate", cloneUrl, dissociated);
    assert.equal(r3.status, 0, r3.stderr);
    assert.ok(!fs.existsSync(path.join(dissociated, ".git", "objects", "info", "alternates")), "--dissociate keeps its own objects");

    // The board's mirror still wins when present.
    const board = path.join(tmp, "board-mirrors");
    fs.mkdirSync(path.join(board, "owner", "repo.git", "objects"), { recursive: true });
    fs.writeFileSync(path.join(board, "owner", "repo.git", "HEAD"), "ref: refs/heads/main\n");
    const fourth = path.join(tmp, "local-clone4");
    const r4 = runWrapper(store, board, "-c", instead, "clone", "-q", cloneUrl, fourth);
    assert.equal(r4.status, 0, r4.stderr);
    assert.equal(fs.readFileSync(path.join(fourth, ".git", "objects", "info", "alternates"), "utf8").trim(), fs.realpathSync(path.join(board, "owner", "repo.git", "objects")));
  });

  it("an empty MYRMIDON_GIT_LOCAL_MIRROR turns the store off (the documented disable)", () => {
    const origin = makeOrigin("off-origin");
    const dest = path.join(tmp, "off-clone");
    const instead = `url.file://${origin}.insteadOf=https://github.com/owner2/repo`;
    const r = runWrapper("", path.join(tmp, "no-board2"), "-c", instead, "clone", "-q", "https://github.com/owner2/repo", dest);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!fs.existsSync(path.join(dest, ".git", "objects", "info", "alternates")), "no store: a plain full clone");
  });

  // myrmidon(1.6.5 BOT-DISK-G-A): the argv task clones carry in the field —
  // a stale reference plus a bounded history — used to opt the clone out of the
  // store, which is why the store stayed empty on every bot of the fleet.
  it("takes the field's task-clone argv (--reference-if-able + --depth) through the store", () => {
    const origin = makeOrigin("field-origin");
    const store = path.join(tmp, "field-store");
    const noBoard = path.join(tmp, "field-no-board");
    // The stale /workspace/<old> a task clone points at: the same repository.
    const stale = path.join(tmp, "field-stale.git");
    git(tmp, "clone", "-q", "--bare", origin, stale);
    const dest = path.join(tmp, "field-clone");
    const r = runWrapper(store, noBoard, "-c", `url.file://${origin}.insteadOf=https://github.com/owner/repo`,
      "clone", "-q", "--reference-if-able", stale, "--depth", "50", "https://github.com/owner/repo", dest);
    assert.equal(r.status, 0, r.stderr);
    const mirror = path.join(store, "owner", "repo.git");
    assert.ok(fs.existsSync(path.join(mirror, "objects")), "the field argv fills the store");
    // The clone borrows the store's objects — next to the caller's own stale
    // reference, which git keeps as a second alternate.
    const alternates = fs.readFileSync(path.join(dest, ".git", "objects", "info", "alternates"), "utf8").trim().split("\n");
    assert.ok(alternates.includes(fs.realpathSync(path.join(mirror, "objects"))), `the store is an alternate: ${alternates.join(" ")}`);
    assert.ok(alternates.includes(fs.realpathSync(path.join(stale, "objects"))), "the caller's own reference survives");
    assert.equal(fs.readFileSync(path.join(dest, "a.txt"), "utf8"), "a\n");
  });

  // The bypass is not silent any more: it leaves a trail the clone-hygiene
  // reporter reads, and a clone the store takes leaves none.
  it("records a bypass in the reporter's trail file, and stays quiet when the store takes the clone", () => {
    const home = path.join(tmp, "hermes-home");
    fs.rmSync(home, { recursive: true, force: true });
    const trail = path.join(home, ".myrmidon", "git-objects-last-error.json");
    const read = () => JSON.parse(fs.readFileSync(trail, "utf8"));
    const store = path.join(tmp, "trail-store");
    const noBoard = path.join(tmp, "trail-no-board");
    const origin = makeOrigin("trail-origin");

    // A clone the store takes leaves no trail at all.
    const taken = runWrapper(store, noBoard, "-c", `url.file://${origin}.insteadOf=https://github.com/owner/repo`, "clone", "-q", "https://github.com/owner/repo", path.join(tmp, "trail-taken"));
    assert.equal(taken.status, 0, taken.stderr);
    assert.ok(!fs.existsSync(trail), "a clone through the store writes no bypass trail");

    // A clone with its own storage decision: recorded, and said out loud.
    const optOut = runWrapper(store, noBoard, "-c", `url.file://${origin}.insteadOf=https://github.com/owner/repo`, "clone", "-q", "--dissociate", "https://github.com/owner/repo", path.join(tmp, "trail-c1"));
    assert.match(optOut.stderr, /\[myrmidon-git\] shared object store bypassed: the clone carries a storage option of its own \(--dissociate\)/);
    assert.equal(read().kind, "bypass");
    assert.equal(read().reason, "opt-out");
    assert.equal(read().detail, "--dissociate");
    assert.ok(read().argv.includes("clone"), `the trail records the argv: ${read().argv.join(" ")}`);

    // A remote that is not GitHub at all.
    const other = runWrapper(store, noBoard, "-c", `url.file://${origin}.insteadOf=https://gitlab.com/owner/repo`, "clone", "-q", "https://gitlab.com/owner/repo", path.join(tmp, "trail-c2"));
    assert.equal(other.status, 0, other.stderr);
    assert.equal(read().reason, "url");
    assert.equal(read().url, "https://gitlab.com/owner/repo");
    // Counters accumulate instead of being overwritten.
    assert.equal(read().totals["bypass:opt-out"], 1);
    assert.equal(read().totals["bypass:url"], 1);

    // A deliberately switched-off store is recorded too, but stays quiet.
    const off = runWrapper("", noBoard, "-c", `url.file://${origin}.insteadOf=https://github.com/owner/repo`, "clone", "-q", "https://github.com/owner/repo", path.join(tmp, "trail-c3"));
    assert.equal(off.status, 0, off.stderr);
    assert.equal(read().reason, "store-off");
    assert.doesNotMatch(off.stderr, /bypassed/, "the documented disable is not an error");
  });
});

describe("bot-clone-hygiene", { skip: !hasGit || !hasPython }, () => {
  function report(roots, extraEnv = {}) {
    const out = path.join(tmp, `report-${Math.random().toString(36).slice(2)}.json`);
    const r = spawnSync("python3", [HYGIENE, "--once"], {
      env: {
        PATH: process.env.PATH,
        HOME: tmp,
        GIT_CONFIG_NOSYSTEM: "1",
        MYRMIDON_HYGIENE_ROOTS: roots.join(":"),
        MYRMIDON_HYGIENE_REPORT: out,
        ...extraEnv,
      },
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    const parsed = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.equal(parsed.version, 1);
    assert.ok(!Number.isNaN(Date.parse(parsed.inspectedAt)));
    const map = new Map(parsed.repos.map((repo) => [repo.path, repo]));
    map.removed = parsed.removed;
    map.reportPath = out;
    return map;
  }

  it("tells merged, pushed, dirty, unpushed, stashed, borrowed and worktree-base clones apart", () => {
    const base = path.join(tmp, "hygiene");
    const remote = path.join(base, "remote.git");
    const volume = path.join(base, "volume");
    fs.mkdirSync(volume, { recursive: true });
    git(base, "init", "-q", "--bare", "-b", "main", remote);

    const seed = path.join(base, "seed");
    fs.mkdirSync(seed);
    git(seed, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(seed, "a.txt"), "a\n");
    git(seed, "add", ".");
    git(seed, "commit", "-q", "-m", "one");
    git(seed, "remote", "add", "origin", remote);
    git(seed, "push", "-q", "origin", "main");

    const clone = (name, ...extra) => {
      const dir = path.join(volume, name);
      git(base, "clone", "-q", ...extra, remote, dir);
      return dir;
    };

    clone("clean");

    const dirty = clone("dirty");
    fs.writeFileSync(path.join(dirty, "a.txt"), "changed\n");

    const untracked = clone("untracked");
    fs.writeFileSync(path.join(untracked, "new.txt"), "n\n");

    const unpushed = clone("unpushed");
    fs.writeFileSync(path.join(unpushed, "b.txt"), "b\n");
    git(unpushed, "add", ".");
    git(unpushed, "commit", "-q", "-m", "local only");

    const pushed = clone("pushed");
    git(pushed, "checkout", "-q", "-b", "feature");
    fs.writeFileSync(path.join(pushed, "c.txt"), "c\n");
    git(pushed, "add", ".");
    git(pushed, "commit", "-q", "-m", "on a remote branch");
    git(pushed, "push", "-q", "origin", "feature");

    const stashed = clone("stashed");
    fs.writeFileSync(path.join(stashed, "a.txt"), "stash me\n");
    git(stashed, "stash", "push", "-q");

    const noRemote = path.join(volume, "no-remote");
    fs.mkdirSync(noRemote);
    git(noRemote, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(noRemote, "x"), "x\n");
    git(noRemote, "add", ".");
    git(noRemote, "commit", "-q", "-m", "x");

    const baseClone = clone("base");
    git(baseClone, "worktree", "add", "-q", "-b", "wt", path.join(volume, "wt"));

    const borrowed = clone("borrowed");
    const borrower = path.join(volume, "borrower");
    git(base, "clone", "-q", "--reference", borrowed, remote, borrower);

    // Ignored directories are not entered, and an ignored file is not "dirty".
    fs.mkdirSync(path.join(volume, "clean", "node_modules", "x"), { recursive: true });
    fs.mkdirSync(path.join(volume, "nested", "owner"), { recursive: true });
    git(base, "clone", "-q", remote, path.join(volume, "nested", "owner", "deep"));

    const r = report([volume]);
    const by = (name) => r.get(path.join(volume, name));

    assert.equal(by("clean").dirty, false);
    assert.equal(by("clean").unpushedCommits, 0);
    assert.equal(by("clean").hasRemote, true);
    assert.equal(by("clean").branch, "main");
    assert.equal(by("clean").mergedIntoDefault, true);
    assert.equal(by("clean").error, null);
    assert.equal(by("dirty").dirty, true);
    assert.equal(by("untracked").dirty, true);
    assert.equal(by("unpushed").unpushedCommits, 1);
    assert.equal(by("unpushed").mergedIntoDefault, false);
    assert.equal(by("pushed").unpushedCommits, 0); // on origin/feature
    assert.equal(by("pushed").mergedIntoDefault, false);
    assert.equal(by("stashed").stashCount, 1);
    assert.equal(by("no-remote").hasRemote, false);
    assert.equal(by("no-remote").unpushedCommits, 1);
    assert.equal(by("base").linkedWorktrees, 1);
    assert.equal(by("wt").error, null);
    assert.equal(by("borrowed").referencedBy, 1);
    assert.equal(by("borrower").referencedBy, 0);
    assert.ok(r.has(path.join(volume, "nested", "owner", "deep")), "a repository two levels down is found");
    assert.ok(![...r.keys()].some((key) => key.includes("node_modules")));
  });

  it("reports an operation in progress", () => {
    const base = path.join(tmp, "hygiene-merge");
    const repo = path.join(base, "volume", "conflict");
    fs.mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repo, "f"), "1\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "base");
    git(repo, "checkout", "-q", "-b", "other");
    fs.writeFileSync(path.join(repo, "f"), "2\n");
    git(repo, "commit", "-q", "-am", "other");
    git(repo, "checkout", "-q", "main");
    fs.writeFileSync(path.join(repo, "f"), "3\n");
    git(repo, "commit", "-q", "-am", "main");
    // A conflicting merge exits non-zero and leaves MERGE_HEAD behind.
    const merge = spawnSync("git", ["merge", "other"], {
      cwd: repo,
      env: { PATH: process.env.PATH, HOME: tmp, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" },
    });
    assert.notEqual(merge.status, 0);
    const r = report([path.join(base, "volume")]);
    assert.equal(r.get(repo).inProgress, true);
    assert.equal(r.get(repo).dirty, true);
  });

  it("removes only clean, pushed, idle clones and plain idle directories, in the container, when a TTL is set", async () => {
    const base = path.join(tmp, "reap");
    const remote = path.join(base, "remote.git");
    const volume = path.join(base, "workspace");
    fs.mkdirSync(volume, { recursive: true });
    git(base, "init", "-q", "--bare", "-b", "main", remote);
    const seed = path.join(base, "seed");
    fs.mkdirSync(seed);
    git(seed, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(seed, "a.txt"), "a\n");
    git(seed, "add", ".");
    git(seed, "commit", "-q", "-m", "one");
    git(seed, "remote", "add", "origin", remote);
    git(seed, "push", "-q", "origin", "main");
    const clone = (name) => {
      const dir = path.join(volume, name);
      git(base, "clone", "-q", remote, dir);
      return dir;
    };
    const clean = clone("clean");
    const dirty = clone("dirty");
    fs.writeFileSync(path.join(dirty, "a.txt"), "changed\n");
    const unpushed = clone("unpushed");
    fs.writeFileSync(path.join(unpushed, "b.txt"), "b\n");
    git(unpushed, "add", ".");
    git(unpushed, "commit", "-q", "-m", "local only");
    const stashed = clone("stashed");
    fs.writeFileSync(path.join(stashed, "a.txt"), "s\n");
    git(stashed, "stash", "push", "-q");
    fs.mkdirSync(path.join(volume, "plain"));
    fs.writeFileSync(path.join(volume, "plain", "note"), "x\n");
    fs.mkdirSync(path.join(volume, "alive"));
    fs.writeFileSync(path.join(volume, "alive", ".heartbeat"), "");
    fs.mkdirSync(path.join(volume, ".pnpm-store"));
    const outside = path.join(base, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "keep"), "k\n");
    fs.symlinkSync(outside, path.join(volume, "link"));

    // No TTL: report only, nothing removed.
    report([volume]);
    assert.ok(fs.existsSync(clean));

    await new Promise((resolve) => setTimeout(resolve, 2200));
    // A TTL that has not passed yet for a fresh touch: the dirty clone's file is touched now.
    const r = report([volume], { MYRMIDON_CLONE_IDLE_TTL_SEC: "1" });
    assert.ok(!fs.existsSync(clean), "clean, pushed, idle clone is removed");
    assert.ok(fs.existsSync(dirty), "dirty clone is kept");
    assert.ok(fs.existsSync(unpushed), "clone with an unpushed commit is kept");
    assert.ok(fs.existsSync(stashed), "clone with a stash is kept");
    assert.ok(!fs.existsSync(path.join(volume, "plain")), "plain idle directory is removed");
    assert.ok(fs.existsSync(path.join(volume, "alive")), "a directory with a heartbeat marker is kept");
    assert.ok(fs.existsSync(path.join(volume, ".pnpm-store")), "a dot entry (the pnpm store) is kept");
    assert.ok(fs.existsSync(path.join(outside, "keep")), "a symbolic link is never followed");
    assert.ok(r.removed.includes(clean));
    assert.ok(r.has(unpushed) && r.get(unpushed).idleSeconds >= 1);
    assert.equal(r.has(clean), false);
  });

  // myrmidon(BOT-DISK-D): /workspace is a LINK into the bot's single mount in the container.
  // A root that is a link must still be reaped inside (the real path stays under the real root),
  // while a link below the root is still never followed.
  it("reaps plain idle directories under a root that is itself a link, and passes the self-check on", async () => {
    const base = path.join(tmp, "linkroot");
    const real = path.join(base, "bot", "workspace");
    fs.mkdirSync(real, { recursive: true });
    fs.mkdirSync(path.join(base, "view"));
    const linkRoot = path.join(base, "view", "workspace");
    fs.symlinkSync(real, linkRoot);
    fs.mkdirSync(path.join(real, "plain"));
    fs.writeFileSync(path.join(real, "plain", "note"), "x\n");
    const outside = path.join(base, "outside");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(real, "escape"));
    const check = path.join(base, "hardlink-check.json");
    fs.writeFileSync(
      check,
      JSON.stringify({ version: 1, ok: false, store: "/workspace/.pnpm-store", importMethod: "hardlink", roots: [{ root: "/scratch", ok: false, error: "Invalid cross-device link" }] }),
    );
    await new Promise((resolve) => setTimeout(resolve, 2200));
    const r = report([linkRoot], { MYRMIDON_CLONE_IDLE_TTL_SEC: "1", MYRMIDON_HARDLINK_CHECK_FILE: check });
    assert.ok(!fs.existsSync(path.join(real, "plain")), "plain idle directory under a linked root is removed");
    assert.ok(fs.existsSync(outside), "a link below the root is never followed");
    assert.ok(r.removed.includes(path.join(linkRoot, "plain")));
    const written = JSON.parse(fs.readFileSync(r.reportPath, "utf8"));
    assert.equal(written.hardlinkCheck.ok, false);
    assert.equal(written.hardlinkCheck.roots[0].root, "/scratch");
  });

  // myrmidon(1.6.5 BOT-DISK-G): the shared-git-objects self-check rides the report too.
  it("passes the shared-git-objects self-check on to the board", () => {
    const base = path.join(tmp, "gitref-pass");
    const volume = path.join(base, "workspace");
    fs.mkdirSync(volume, { recursive: true });
    const check = path.join(base, "git-objects-check.json");
    fs.writeFileSync(
      check,
      JSON.stringify({
        version: 1,
        ok: false,
        store: "/bot-scope/.git-objects",
        checks: [
          { check: "usr-local-shadow", ok: true, error: null },
          { check: "reference-clone", ok: false, error: "fatal: object not found" },
        ],
      }),
    );
    const r = report([volume], { MYRMIDON_GIT_OBJECTS_CHECK_FILE: check });
    const written = JSON.parse(fs.readFileSync(r.reportPath, "utf8"));
    assert.equal(written.gitRefCheck.ok, false);
    assert.equal(written.gitRefCheck.store, "/bot-scope/.git-objects");
    assert.equal(written.gitRefCheck.checks[1].check, "reference-clone");
    // No file: the report carries null and nothing breaks.
    const r2 = report([volume], { MYRMIDON_GIT_OBJECTS_CHECK_FILE: path.join(base, "absent.json") });
    assert.equal(JSON.parse(fs.readFileSync(r2.reportPath, "utf8")).gitRefCheck, null);
  });

  // myrmidon(1.6.5 BOT-DISK-G live check, OPE-5281 ч.B): the store's FACTS ride
  // the report as `gitStore`, so the live acceptance ("the store is not empty")
  // can be read over the API instead of exec-ing into the bot.
  it("carries the git-object store's facts in the report", () => {
    const base = path.join(tmp, "gitstore");
    const volume = path.join(base, "workspace");
    const store = path.join(base, "git-objects");
    for (const dir of [
      path.join(store, "itkadr-git", "myrmidon.git", "objects"),
      path.join(store, "itkadr-git", "half.git", "objects"),
    ]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(path.join(store, "itkadr-git", "myrmidon.git", "objects", "pack-a.pack"), "pack");
    fs.writeFileSync(path.join(store, "itkadr-git", "myrmidon.git", "HEAD"), "ref: refs/heads/main\n");
    const home = path.join(base, "hermes");

    const written = JSON.parse(fs.readFileSync(report([volume], { MYRMIDON_GIT_LOCAL_MIRROR: store, HERMES_HOME: home }).reportPath, "utf8"));
    assert.equal(written.gitStore.enabled, true);
    assert.equal(written.gitStore.path, store);
    assert.deepEqual(written.gitStore.repos, ["itkadr-git/myrmidon"], "only a mirror with objects/ and HEAD is listed");
    assert.equal(written.gitStore.mirrorCount, 1);
    assert.ok(written.gitStore.totalBytes > 0, `the store size is reported, got ${written.gitStore.totalBytes}`);

    // A store without a mirror is reported as empty: the gap the acceptance looks for.
    const empty = path.join(base, "no-store-yet");
    fs.mkdirSync(empty);
    const second = JSON.parse(fs.readFileSync(report([volume], { MYRMIDON_GIT_LOCAL_MIRROR: empty, HERMES_HOME: home }).reportPath, "utf8")).gitStore;
    assert.equal(second.enabled, true);
    assert.equal(second.mirrorCount, 0);
    assert.deepEqual(second.repos, []);

    // The documented disable.
    const off = JSON.parse(fs.readFileSync(report([volume], { MYRMIDON_GIT_LOCAL_MIRROR: "", HERMES_HOME: home }).reportPath, "utf8")).gitStore;
    assert.equal(off.enabled, false);
    assert.equal(off.path, "");
    assert.equal(off.mirrorCount, 0);
  });

  it("reads the store the profile wrote into .env when the environment carries none", () => {
    const base = path.join(tmp, "gitstore-envfile");
    const volume = path.join(base, "workspace");
    fs.mkdirSync(volume, { recursive: true });
    const store = path.join(base, "git-objects-from-env");
    fs.mkdirSync(path.join(store, "itkadr-git", "myrmidon.git", "objects"), { recursive: true });
    fs.writeFileSync(path.join(store, "itkadr-git", "myrmidon.git", "HEAD"), "ref: refs/heads/main\n");
    const home = path.join(base, "hermes");
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, ".env"), `MYRMIDON_GIT_LOCAL_MIRROR="${store}"\n`);

    const written = JSON.parse(fs.readFileSync(report([volume], { HERMES_HOME: home }).reportPath, "utf8"));
    assert.equal(written.gitStore.path, store);
    assert.deepEqual(written.gitStore.repos, ["itkadr-git/myrmidon"]);
  });
});

// myrmidon(1.6.5 BOT-DISK-H1b): the wrapper intercepts `git clone` of a GitHub
// repository into `myr-ws open` and strips credentials from remote URLs.
// Everything here runs against a fake myr-ws, a fake real git and a stand-in for
// clone-args.js (BOT-DISK-H1a; the same signature, the contract of the epic), so
// nothing needs the network or the neighbours' code. Fixtures come from the
// C2 contract directory.
describe("git wrapper: clone interception (BOT-DISK-H1b)", () => {
  const CONTRACT = path.join(ROOT, "docs/myrmidon/bot-disk-contract");
  const openFixture = JSON.parse(fs.readFileSync(path.join(CONTRACT, "myr-ws-open.json"), "utf8"));
  const errorFixture = JSON.parse(fs.readFileSync(path.join(CONTRACT, "myr-ws-error.json"), "utf8"));
  const TOKEN = "ghp_FAKETOKEN0123456789";

  // Same signature as clone-args.js: parseCloneArgs(argv) -> {kind, owner, repo, dir, ignoredFlags, hadUserinfo}.
  const FAKE_CLONE_ARGS = `"use strict";
const WITH_VALUE = new Set(["-b", "--branch", "--depth", "--filter", "-o", "--origin", "-c", "--config", "--reference"]);
const IGNORED = new Set(["--depth", "--filter", "--mirror", "--bare", "--single-branch", "--reference"]);
function parseCloneArgs(argv) {
  const r = { kind: "invalid", owner: null, repo: null, dir: null, ignoredFlags: [], hadUserinfo: false };
  const pos = [];
  let dashes = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "clone" && i === 0) continue;
    if (dashes || !a.startsWith("-")) { pos.push(a); continue; }
    if (a === "--") { dashes = true; continue; }
    const name = a.startsWith("--") && a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
    if (!a.includes("=") && WITH_VALUE.has(name)) i++;
    if (IGNORED.has(name) && !r.ignoredFlags.includes(name)) r.ignoredFlags.push(name);
  }
  if (pos.length === 0) return r;
  const m = /^(?:https?:\\/\\/(?:([^@/]+)@)?(?:www\\.)?github\\.com\\/|(?:ssh:\\/\\/)?git@github\\.com[:/])([^/]+)\\/([^/]+?)(?:\\.git)?\\/?$/.exec(pos[0]);
  if (!m) { r.kind = "foreign"; r.dir = pos[1] ?? null; return r; }
  return { ...r, kind: "github", owner: m[2], repo: m[3], dir: pos[1] ?? m[3], hadUserinfo: Boolean(m[1]) };
}
module.exports = { parseCloneArgs };
`;

  let dir; // wrapper copy + stand-in parser
  let fakeWs;
  let fakeGit;
  let logs;
  let wrapperPath;

  before(() => {
    dir = path.join(tmp, "h1b");
    logs = path.join(dir, "logs");
    fs.mkdirSync(logs, { recursive: true });
    wrapperPath = path.join(dir, "git.cjs");
    fs.copyFileSync(WRAPPER_SRC, wrapperPath);
    fs.writeFileSync(path.join(dir, "clone-args.js"), FAKE_CLONE_ARGS);
    // fake myr-ws: one argv element per line into $LOG_DIR/ws.log; prints the contract's path; exit/stderr from env
    fakeWs = path.join(dir, "fake-myr-ws");
    fs.writeFileSync(
      fakeWs,
      `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> "$LOG_DIR/ws.log"; done\nprintf '%s\\n' '--' >> "$LOG_DIR/ws.log"\n` +
        `if [ -n "$FAKE_WS_EXIT" ]; then printf '%s\\n' "$FAKE_WS_STDERR" >&2; exit "$FAKE_WS_EXIT"; fi\nprintf '%s\\n' "${openFixture.path}"\n`,
      { mode: 0o755 },
    );
    // fake real git: argv into $LOG_DIR/git.log, a marker on stdout/stderr, exit code from env
    fakeGit = path.join(dir, "fake-real-git");
    fs.writeFileSync(
      fakeGit,
      `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> "$LOG_DIR/git.log"; done\nprintf '%s\\n' '--' >> "$LOG_DIR/git.log"\n` +
        `echo real-git-out\necho real-git-err >&2\nexit "\${FAKE_GIT_EXIT:-0}"\n`,
      { mode: 0o755 },
    );
  });

  function run(args, extraEnv = {}) {
    for (const f of ["ws.log", "git.log"]) fs.rmSync(path.join(logs, f), { force: true });
    const env = {
      PATH: process.env.PATH,
      HOME: tmp,
      HERMES_HOME: path.join(dir, "hermes"),
      MYRMIDON_GIT_REAL: fakeGit,
      MYRMIDON_GIT_MIRROR_ROOT: path.join(dir, "no-board-mirrors"),
      MYRMIDON_GIT_LOCAL_MIRROR: "",
      MYRMIDON_WS_BIN: fakeWs,
      LOG_DIR: logs,
      ...extraEnv,
    };
    const r = spawnSync(process.execPath, [wrapperPath, ...args], { env, encoding: "utf8", cwd: dir });
    const read = (f) => {
      try {
        return fs.readFileSync(path.join(logs, f), "utf8");
      } catch {
        return "";
      }
    };
    const calls = (f) => read(f).split("--\n").filter(Boolean).map((c) => c.split("\n").filter(Boolean));
    return { ...r, ws: calls("ws.log"), realGit: calls("git.log") };
  }

  const TASK = { MYRMIDON_TASK_WORKSPACE: "/workspace/ABC-101" };
  const forms = [
    ["https url", ["clone", "https://github.com/acme/widgets"], []],
    ["https url with .git", ["clone", "https://github.com/acme/widgets.git"], []],
    ["https url with trailing slash", ["clone", "https://github.com/acme/widgets/"], []],
    ["www host", ["clone", "https://www.github.com/acme/widgets"], []],
    ["scp-like ssh", ["clone", "git@github.com:acme/widgets.git"], []],
    ["ssh:// url", ["clone", "ssh://git@github.com/acme/widgets"], []],
    ["token in the url", ["clone", `https://${TOKEN}@github.com/acme/widgets.git`], []],
    ["user:token in the url", ["clone", `https://x-access-token:${TOKEN}@github.com/acme/widgets`], []],
    ["explicit directory", ["clone", "https://github.com/acme/widgets", "my-dir"], []],
    ["--depth", ["clone", "--depth", "1", "https://github.com/acme/widgets"], ["--depth"]],
    ["--filter=blob:none", ["clone", "--filter=blob:none", "https://github.com/acme/widgets"], ["--filter"]],
    ["--mirror", ["clone", "--mirror", "https://github.com/acme/widgets"], ["--mirror"]],
    ["--bare", ["clone", "--bare", "https://github.com/acme/widgets", "w.git"], ["--bare"]],
    ["--branch and --", ["clone", "--branch", "main", "--", "https://github.com/acme/widgets"], []],
    ["global -c before clone, filter and depth", ["-c", "http.sslVerify=true", "clone", "--filter=tree:0", "--depth=1", "https://github.com/acme/widgets"], ["--filter", "--depth"]],
  ];

  for (const [name, argv, ignored] of forms) {
    it(`serves the clone through myr-ws open: ${name}`, () => {
      const r = run(argv, TASK);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(r.ws, [["open", "ABC-101", "acme/widgets"]]);
      assert.deepEqual(r.realGit, [], "the real git clone must not run");
      assert.equal(r.stdout, "", "git clone prints nothing on stdout");
      assert.ok(r.stderr.includes(`Cloning into '${openFixture.path}'...`), r.stderr);
      for (const flag of ignored) assert.ok(r.stderr.includes(flag), `${flag} announced as ignored: ${r.stderr}`);
      if (ignored.length === 0) assert.ok(!r.stderr.includes("ignored for this clone"), r.stderr);
      assert.ok(!r.stderr.includes(TOKEN) && !JSON.stringify(r.ws).includes(TOKEN), "the token goes nowhere");
    });
  }

  it("never lets the history/partial options reach git or myr-ws", () => {
    const r = run(["clone", "--filter=blob:none", "--depth", "1", "--mirror", "--bare", "https://github.com/acme/widgets"], TASK);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.realGit, []);
    assert.deepEqual(r.ws, [["open", "ABC-101", "acme/widgets"]]);
    assert.ok(!JSON.stringify(r.ws).includes("filter") && !JSON.stringify(r.ws).includes("depth"));
  });

  it("uses --scratch <dir name> without a task workspace, or with one that is no issue key", () => {
    const a = run(["clone", "https://github.com/acme/widgets", "/tmp/probe-1"]);
    assert.deepEqual(a.ws, [["open", "--scratch", "probe-1", "acme/widgets"]]);
    const b = run(["clone", "https://github.com/acme/widgets"], { MYRMIDON_TASK_WORKSPACE: "/somewhere/else" });
    assert.deepEqual(b.ws, [["open", "--scratch", "widgets", "acme/widgets"]]);
    const c = run(["clone", "https://github.com/acme/widgets", "../we ird"]);
    assert.deepEqual(c.ws, [["open", "--scratch", "we_ird", "acme/widgets"]]);
    for (const r of [a, b, c]) assert.deepEqual(r.realGit, []);
  });

  it("passes the exit code and stderr of myr-ws through (3 = quota) and runs no git", () => {
    const r = run(["clone", "https://github.com/acme/widgets"], { ...TASK, FAKE_WS_EXIT: String(errorFixture.exitCode), FAKE_WS_STDERR: errorFixture.error });
    assert.equal(r.status, 3);
    assert.equal(r.status, errorFixture.exitCode);
    assert.ok(r.stderr.includes("BOT_DISK_QUOTA_EXCEEDED:"), r.stderr);
    assert.deepEqual(r.realGit, []);
    assert.ok(!r.stderr.includes("Cloning into"), "a refused clone does not announce a clone");
  });

  it("passes any other myr-ws exit code through", () => {
    const r = run(["clone", "https://github.com/acme/widgets"], { ...TASK, FAKE_WS_EXIT: "5", FAKE_WS_STDERR: "myr-ws: network" });
    assert.equal(r.status, 5);
    assert.deepEqual(r.realGit, []);
  });

  it("leaves a non-GitHub clone to the real git: argv, stdio and exit code unchanged", () => {
    for (const argv of [
      ["clone", "https://gitlab.com/acme/widgets"],
      ["clone", "--depth", "1", "https://github.com.evil.example/acme/widgets", "d"],
      ["clone", "/local/path/repo"],
      ["clone"],
    ]) {
      const r = run(argv, { ...TASK, FAKE_GIT_EXIT: "7" });
      assert.deepEqual(r.ws, [], argv.join(" "));
      assert.deepEqual(r.realGit, [argv], argv.join(" "));
      assert.equal(r.status, 7);
      assert.equal(r.stdout, "real-git-out\n");
      assert.ok(r.stderr.includes("real-git-err"));
    }
  });

  it("leaves every other subcommand and a clone with a global -C alone", () => {
    for (const argv of [["status"], ["-C", "/x", "clone", "https://github.com/acme/widgets"], ["fetch", "origin"]]) {
      const r = run(argv, TASK);
      assert.deepEqual(r.ws, []);
      assert.deepEqual(r.realGit, [argv]);
    }
  });

  it("falls back to the plain path when myr-ws is missing, and with MYRMIDON_GIT_INTERCEPT=0", () => {
    const missing = run(["clone", "https://github.com/acme/widgets"], { ...TASK, MYRMIDON_WS_BIN: path.join(dir, "no-such-ws") });
    assert.deepEqual(missing.realGit, [["clone", "https://github.com/acme/widgets"]]);
    assert.ok(missing.stderr.includes("not found"), missing.stderr);
    const off = run(["clone", "https://github.com/acme/widgets"], { ...TASK, MYRMIDON_GIT_INTERCEPT: "0" });
    assert.deepEqual(off.ws, []);
    assert.deepEqual(off.realGit, [["clone", "https://github.com/acme/widgets"]]);
  });

  it("falls back to the plain path when clone-args.js is not beside the wrapper", () => {
    const alone = path.join(dir, "alone");
    fs.mkdirSync(alone, { recursive: true });
    const lone = path.join(alone, "git.cjs");
    fs.copyFileSync(WRAPPER_SRC, lone);
    const r = spawnSync(process.execPath, [lone, "clone", "https://github.com/acme/widgets"], {
      env: { PATH: process.env.PATH, HERMES_HOME: path.join(dir, "hermes"), MYRMIDON_GIT_REAL: fakeGit, MYRMIDON_GIT_LOCAL_MIRROR: "", MYRMIDON_WS_BIN: fakeWs, LOG_DIR: logs },
      encoding: "utf8",
    });
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes("real-git-out"));
  });

  it("the stand-in's output has the contract's open-result path (fixture sanity)", () => {
    assert.equal(openFixture.ok, true);
    assert.match(openFixture.path, /^\/workspace\//);
    assert.equal(errorFixture.exitCode, 3);
    assert.ok(errorFixture.error.startsWith("BOT_DISK_QUOTA_EXCEEDED:"));
  });

  it("the real clone-args.js, when it is in the tree, answers the same way for the 15 forms", () => {
    const real = path.join(ROOT, "docker/bot-runtime/git-reference/clone-args.js");
    if (!fs.existsSync(real)) return; // BOT-DISK-H1a has not landed in this tree yet
    const { parseCloneArgs } = createRequire(import.meta.url)(real);
    const fake = createRequire(import.meta.url)(path.join(dir, "clone-args.js"));
    for (const [name, argv] of forms) {
      const a = parseCloneArgs(argv);
      const b = fake.parseCloneArgs(argv);
      assert.equal(a.kind, b.kind, name);
      assert.equal(a.owner, b.owner, name);
      assert.equal(a.repo, b.repo, name);
    }
  });
});

describe("git wrapper: credentials in remote URLs (BOT-DISK-H1b)", { skip: !hasGit }, () => {
  const TOKEN = "ghp_FAKETOKEN0123456789";
  let repoDir;
  let env;

  before(() => {
    repoDir = path.join(tmp, "h1b-remote-repo");
    fs.mkdirSync(repoDir, { recursive: true });
    git(repoDir, "init", "-q");
    env = {
      PATH: process.env.PATH,
      HOME: tmp,
      GIT_CONFIG_NOSYSTEM: "1",
      MYRMIDON_GIT_REAL: spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim(),
    };
  });

  const wrapped = (...args) => spawnSync(process.execPath, [wrapper, ...args], { env, encoding: "utf8", cwd: repoDir });
  const config = (key) => spawnSync("git", ["config", "--get-all", key], { env, encoding: "utf8", cwd: repoDir }).stdout.trim();
  const raw = () => fs.readFileSync(path.join(repoDir, ".git", "config"), "utf8");

  it("stripUserinfo drops a token or user:password from http(s), a password from ssh, and leaves the rest", () => {
    const lib2 = lib;
    assert.equal(lib2.stripUserinfo(`https://${TOKEN}@github.com/o/r.git`), "https://github.com/o/r.git");
    assert.equal(lib2.stripUserinfo(`https://x-access-token:${TOKEN}@github.com/o/r`), "https://github.com/o/r");
    assert.equal(lib2.stripUserinfo(`http://u:p@example.com:8080/a/b?x=1#f`), "http://example.com:8080/a/b?x=1#f");
    assert.equal(lib2.stripUserinfo(`ssh://deploy:${TOKEN}@host.example/o/r`), "ssh://deploy@host.example/o/r");
    assert.equal(lib2.stripUserinfo("ssh://git@github.com/o/r"), "ssh://git@github.com/o/r");
    assert.equal(lib2.stripUserinfo("https://github.com/o/r"), "https://github.com/o/r");
    assert.equal(lib2.stripUserinfo("git@github.com:o/r.git"), "git@github.com:o/r.git");
  });

  it("sanitizeRemoteArgs touches only remote add/set-url and config remote.*.url|pushurl", () => {
    const u = `https://${TOKEN}@github.com/o/r.git`;
    const c = "https://github.com/o/r.git";
    assert.deepEqual(lib.sanitizeRemoteArgs(["remote", "add", "origin", u]), { argv: ["remote", "add", "origin", c], changed: true });
    assert.deepEqual(lib.sanitizeRemoteArgs(["remote", "set-url", "--push", "origin", u]).argv, ["remote", "set-url", "--push", "origin", c]);
    assert.deepEqual(lib.sanitizeRemoteArgs(["config", "remote.origin.url", u]).argv, ["config", "remote.origin.url", c]);
    assert.deepEqual(lib.sanitizeRemoteArgs(["config", "--add", "remote.up.pushurl", u]).argv, ["config", "--add", "remote.up.pushurl", c]);
    assert.deepEqual(lib.sanitizeRemoteArgs(["-c", "a=b", "remote", "add", "x", u]).argv, ["-c", "a=b", "remote", "add", "x", c]);
    for (const argv of [["config", "user.name", u], ["remote", "-v"], ["remote", "rename", "a", "b"], ["fetch", u], ["remote", "add", "origin", c]]) {
      assert.deepEqual(lib.sanitizeRemoteArgs(argv), { argv, changed: false });
    }
  });

  it("remote add with a token stores the URL without userinfo", () => {
    const r = wrapped("remote", "add", "tok", `https://${TOKEN}@github.com/acme/widgets.git`);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(config("remote.tok.url"), "https://github.com/acme/widgets.git");
    assert.ok(!raw().includes(TOKEN));
    assert.ok(!r.stderr.includes(TOKEN) && !r.stdout.includes(TOKEN));
    assert.ok(r.stderr.includes("credential in the remote URL was removed"), r.stderr);
  });

  it("remote set-url with user:token stores the URL without userinfo", () => {
    assert.equal(wrapped("remote", "add", "upstream", "https://github.com/acme/widgets.git").status, 0);
    const r = wrapped("remote", "set-url", "upstream", `https://x-access-token:${TOKEN}@github.com/acme/widgets.git`);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(config("remote.upstream.url"), "https://github.com/acme/widgets.git");
    assert.ok(!raw().includes(TOKEN));
  });

  it("config remote.<n>.url and pushurl with a token store the URL without userinfo", () => {
    assert.equal(wrapped("config", "remote.tok.url", `https://${TOKEN}@github.com/acme/other.git`).status, 0);
    assert.equal(wrapped("config", "remote.tok.pushurl", `https://u:${TOKEN}@github.com/acme/other.git`).status, 0);
    assert.equal(config("remote.tok.url"), "https://github.com/acme/other.git");
    assert.equal(config("remote.tok.pushurl"), "https://github.com/acme/other.git");
    assert.ok(!raw().includes(TOKEN));
  });

  it("a clean remote URL goes through untouched and silently", () => {
    const r = wrapped("remote", "add", "clean", "https://github.com/acme/clean.git");
    assert.equal(r.status, 0);
    assert.equal(r.stderr, "");
    assert.equal(config("remote.clean.url"), "https://github.com/acme/clean.git");
  });
});
