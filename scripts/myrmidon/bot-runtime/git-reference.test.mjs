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

/**
 * The real git. On the bot host /usr/local/bin/git is a symlink to the myrmidon
 * wrapper, so `command -v git` hands back the wrapper itself — passing that as
 * MYRMIDON_GIT_REAL makes the wrapper run itself, which never terminates. These
 * tests need the binary the wrapper normally answers with.
 */
const trueGit = () => {
  const isWrapper = (candidate) => {
    try {
      return fs.readFileSync(candidate).subarray(0, 200).includes("myrmidon");
    } catch {
      return false;
    }
  };
  return ["/usr/bin/git", "/bin/git", spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim()].find(
    (candidate) => candidate && fs.existsSync(candidate) && !isWrapper(candidate),
  );
};
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
      MYRMIDON_GIT_REAL: trueGit(),
      // BOT-DISK-H1b intercepts a GitHub clone only when the CLI is there; pin an
      // absent one so this test keeps proving the reference store.
      MYRMIDON_WS_BIN: path.join(tmp, "no-myr-ws"),
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
  const realGit = () => trueGit();

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
        MYRMIDON_WS_BIN: path.join(tmp, "no-myr-ws"),
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

// myrmidon(1.6.5 BOT-DISK-H1b): a GitHub clone is OPENED through the workspace
// CLI (`myr-ws open`, the contract of OPE-5306 C2) instead of being copied by
// git, and an http(s) remote URL never carries its credential into a config file
// or into the store trail. Both children are fake: no network, no real copy.
describe("git wrapper: clone interception (BOT-DISK-H1b)", () => {
  const DOC = path.join(ROOT, "docs/myrmidon/bot-disk-contract");
  const openFixture = JSON.parse(fs.readFileSync(path.join(DOC, "myr-ws-open.json"), "utf8"));
  const errorFixture = JSON.parse(fs.readFileSync(path.join(DOC, "myr-ws-error.json"), "utf8"));

  /** Every form of `git clone` the field carries: all of them must be opened. */
  const GITHUB_FORMS = [
    { name: "plain", argv: ["clone", "https://github.com/owner/repo", "dest"] },
    { name: "dot-git and no target", argv: ["clone", "https://github.com/owner/repo.git"] },
    { name: "www and a trailing slash", argv: ["--no-pager", "clone", "https://www.github.com/owner/repo/", "dest"] },
    { name: "token in the URL", argv: ["clone", "https://x-access-token:ghp_secret@github.com/owner/repo.git", "dest"] },
    { name: "scp-like ssh", argv: ["clone", "git@github.com:owner/repo.git", "dest"] },
    { name: "ssh:// URL", argv: ["clone", "ssh://git@github.com/owner/repo", "dest"] },
    { name: "another origin name", argv: ["clone", "-o", "upstream", "https://github.com/owner/repo", "dest"] },
    { name: "filter= (promisor)", argv: ["clone", "--filter=blob:none", "https://github.com/owner/repo", "dest"], ignored: ["--filter"] },
    { name: "filter with a value", argv: ["clone", "--filter", "blob:none", "https://github.com/owner/repo", "dest"], ignored: ["--filter"] },
    { name: "depth with a value", argv: ["clone", "--depth", "1", "https://github.com/owner/repo", "dest"], ignored: ["--depth"] },
    { name: "depth= and a ref limit", argv: ["clone", "--depth=50", "--no-single-branch", "https://github.com/owner/repo", "dest"], ignored: ["--depth"] },
    { name: "branch", argv: ["clone", "-b", "main", "https://github.com/owner/repo", "dest"], ignored: ["-b"] },
    { name: "branch=", argv: ["clone", "--branch=release", "https://github.com/owner/repo", "dest"], ignored: ["--branch"] },
    { name: "mirror", argv: ["clone", "--mirror", "https://github.com/owner/repo", "dest"], ignored: ["--mirror"] },
    { name: "bare", argv: ["clone", "--bare", "https://github.com/owner/repo", "dest"], ignored: ["--bare"] },
  ];

  const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  /** A tiny executable node script: the two children the wrapper may spawn. */
  function fakeChild(dir, file, lines) {
    const bin = path.join(dir, file);
    fs.writeFileSync(bin, ["#!/usr/bin/env node", ...lines, ""].join("\n"));
    fs.chmodSync(bin, 0o755);
    return bin;
  }

  /** A fake `myr-ws`: it records its argv and answers like the contract's fixture. */
  function fakeWs(dir, { status = 0, stderr = "", result = null } = {}) {
    const calls = path.join(dir, "ws-calls.json");
    const stdout = result === null ? null : `${JSON.stringify(result)}\n`;
    return {
      calls,
      bin: fakeChild(dir, "myr-ws.mjs", [
        'import fs from "node:fs";',
        `const calls = ${JSON.stringify(calls)};`,
        'const seen = fs.existsSync(calls) ? JSON.parse(fs.readFileSync(calls, "utf8")) : [];',
        "seen.push({ argv: process.argv.slice(2), cwd: process.cwd() });",
        'fs.writeFileSync(calls, JSON.stringify(seen, null, 2));',
        ...(stdout === null ? [] : [`process.stdout.write(${JSON.stringify(stdout)});`]),
        ...(stderr === "" ? [] : [`process.stderr.write(${JSON.stringify(stderr)});`]),
        `process.exit(${status});`,
      ]),
    };
  }

  /** A fake real git: it records its argv and exits with `status`. */
  function fakeGit(dir, status = 0) {
    const calls = path.join(dir, "git-calls.json");
    return {
      calls,
      bin: fakeChild(dir, "real-git.mjs", [
        'import fs from "node:fs";',
        `const calls = ${JSON.stringify(calls)};`,
        'const seen = fs.existsSync(calls) ? JSON.parse(fs.readFileSync(calls, "utf8")) : [];',
        "seen.push({ argv: process.argv.slice(2) });",
        'fs.writeFileSync(calls, JSON.stringify(seen, null, 2));',
        `process.exit(${status});`,
      ]),
    };
  }

  const readCalls = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : []);

  let caseSeq = 0;
  /** One isolated case directory for the children of a single wrapper run. */
  function caseDir(name) {
    caseSeq += 1;
    const dir = path.join(tmp, "h1b", `${caseSeq}-${name}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** The wrapper's own run: this argv, this env, this cwd. */
  function run(args, env, cwd = tmp) {
    return spawnSync(process.execPath, [wrapper, ...args], {
      encoding: "utf8",
      cwd,
      env: { PATH: process.env.PATH, HOME: tmp, GIT_CONFIG_NOSYSTEM: "1", ...env },
    });
  }

  it("opens each of the 15 clone forms through myr-ws with the key of the task", () => {
    assert.equal(GITHUB_FORMS.length, 15);
    for (const form of GITHUB_FORMS) {
      const dir = caseDir(form.name);
      const copy = path.join(dir, "copy");
      const ws = fakeWs(dir, { result: { ...openFixture, path: copy, key: "ABC-101", repo: "owner/repo" } });
      const git = fakeGit(dir, 0);
      const out = run(form.argv, {
        MYRMIDON_WS_BIN: ws.bin,
        MYRMIDON_GIT_REAL: git.bin,
        MYRMIDON_TASK_WORKSPACE: "/workspace/ABC-101",
        MYRMIDON_GIT_LOCAL_MIRROR: path.join(dir, "store"),
      });

      assert.equal(out.status, 0, `${form.name}: ${out.stderr}`);
      const called = readCalls(ws.calls);
      assert.equal(called.length, 1, `${form.name}: myr-ws must run exactly once`);
      assert.deepEqual(called[0].argv, ["open", "ABC-101", "owner/repo", "--json"], form.name);
      assert.deepEqual(readCalls(git.calls), [], `${form.name}: real git must not run`);
      assert.equal(JSON.parse(out.stdout).path, copy, `${form.name}: the open result stays on stdout`);
      assert.match(out.stderr, new RegExp(`Cloning into '${escapeRe(copy)}'`), form.name);
      for (const flag of form.ignored || []) {
        assert.match(out.stderr, new RegExp(`ignoring ${escapeRe(flag)}`), `${form.name}: ${flag} must be reported`);
      }
      if ((form.ignored || []).length === 0) assert.doesNotMatch(out.stderr, /ignoring/, form.name);
      for (const flag of ["--filter", "--depth", "--mirror", "--bare", "--branch", "blob:none"]) {
        assert.ok(!called[0].argv.includes(flag), `${form.name}: ${flag} must not reach myr-ws`);
      }
    }
  });

  it("opens a scratch copy when the run exported no task workspace", () => {
    for (const [args, name] of [
      [["clone", "https://github.com/owner/repo", "dest"], "dest"],
      [["clone", "https://github.com/owner/repo.git"], "repo"],
      [["clone", "https://github.com/owner/repo", "/tmp/deep/nested/"], "nested"],
      [["clone", "--reference-if-able", "/old", "--", "https://github.com/owner/repo", "dest"], "dest"],
    ]) {
      const dir = caseDir(`scratch-${name}`);
      const ws = fakeWs(dir, { result: { ...openFixture, path: path.join(dir, "copy") } });
      const git = fakeGit(dir, 0);
      const out = run(args, {
        MYRMIDON_WS_BIN: ws.bin,
        MYRMIDON_GIT_REAL: git.bin,
        MYRMIDON_TASK_WORKSPACE: "",
        MYRMIDON_GIT_LOCAL_MIRROR: path.join(dir, "store"),
      });
      assert.equal(out.status, 0, `${args.join(" ")}: ${out.stderr}`);
      assert.deepEqual(readCalls(ws.calls)[0].argv, ["open", name, "owner/repo", "--scratch", "--json"], args.join(" "));
      assert.deepEqual(readCalls(git.calls), [], args.join(" "));
    }
  });

  it("leaves a non-GitHub or unparsable command to real git, argv and status unchanged", () => {
    const CASES = [
      ["clone", "https://gitlab.com/owner/repo", "dest"],
      ["clone", "http://github.com/owner/repo", "dest"],
      ["clone", "https://github.com.evil.example/owner/repo", "dest"],
      ["clone", "/tmp/local-repo", "dest"],
      ["clone", "--depth", "1", "https://gitlab.com/owner/repo", "dest"],
      ["clone"],
      ["fetch", "--all", "origin"],
      ["status", "--short"],
      ["remote", "add", "origin", "git@github.com:owner/repo.git"],
    ];
    for (const argv of CASES) {
      const dir = caseDir("foreign");
      const ws = fakeWs(dir, { result: { ...openFixture, path: path.join(dir, "copy") } });
      const git = fakeGit(dir, 7);
      // No local store: the only call the wrapper may make here is the clone itself.
      const out = run(argv, {
        MYRMIDON_WS_BIN: ws.bin,
        MYRMIDON_GIT_REAL: git.bin,
        MYRMIDON_TASK_WORKSPACE: "/workspace/ABC-101",
        HERMES_HOME: path.join(dir, "home"),
      });
      const label = argv.join(" ");
      assert.equal(out.status, 7, `${label}: the real status must pass through`);
      assert.deepEqual(readCalls(git.calls)[0].argv, argv, `${label}: argv unchanged`);
      assert.equal(readCalls(git.calls).length, 1, `${label}: exactly one real git call`);
      assert.deepEqual(readCalls(ws.calls), [], `${label}: myr-ws must not run`);
    }

    // A GitHub URL this parse cannot follow keeps today's behaviour exactly: the
    // shared store may take a step of its own first, and then the clone itself
    // runs with the argv it was given — no myr-ws, no rewritten argv.
    const dir = caseDir("declined");
    const repoArgv = ["clone", "https://github.com/owner/repo", "dest", "third-argument"];
    const ws = fakeWs(dir, { result: { ...openFixture, path: path.join(dir, "copy") } });
    const git = fakeGit(dir, 7);
    const declined = run(repoArgv, {
      MYRMIDON_WS_BIN: ws.bin,
      MYRMIDON_GIT_REAL: git.bin,
      MYRMIDON_TASK_WORKSPACE: "/workspace/ABC-101",
      HERMES_HOME: path.join(dir, "home"),
    });
    assert.equal(declined.status, 7);
    const declinedCalls = readCalls(git.calls);
    assert.deepEqual(declinedCalls[declinedCalls.length - 1].argv, repoArgv, "the clone itself keeps its argv");
    assert.deepEqual(readCalls(ws.calls), [], "myr-ws must not run for a clone it cannot follow");
  });

  it("passes the CLI's exit code and stderr through (exit 3: the disk quota)", () => {
    const dir = caseDir("quota");
    const ws = fakeWs(dir, { status: errorFixture.exitCode, stderr: `${errorFixture.error}\n` });
    const git = fakeGit(dir, 0);
    const out = run(["clone", "https://github.com/owner/repo", "dest"], {
      MYRMIDON_WS_BIN: ws.bin,
      MYRMIDON_GIT_REAL: git.bin,
      MYRMIDON_TASK_WORKSPACE: "/workspace/ABC-101",
      MYRMIDON_GIT_LOCAL_MIRROR: path.join(dir, "store"),
    });

    assert.equal(out.status, errorFixture.exitCode);
    assert.match(out.stderr, new RegExp(escapeRe(errorFixture.error.slice(0, 40))));
    assert.doesNotMatch(out.stderr, /Cloning into/);
    assert.equal(out.stdout.trim(), "");
    assert.deepEqual(readCalls(git.calls), []);
  });

  it("writes a remote URL without its credential into the config", { skip: !hasGit }, () => {
    const dir = caseDir("remote");
    const repo = path.join(dir, "repo");
    fs.mkdirSync(repo, { recursive: true });
    const realGit = trueGit();
    const env = {
      PATH: process.env.PATH,
      HOME: dir,
      GIT_CONFIG_NOSYSTEM: "1",
      MYRMIDON_GIT_REAL: realGit,
      MYRMIDON_WS_BIN: path.join(dir, "no-myr-ws"),
      HERMES_HOME: path.join(dir, "home"),
    };
    const plain = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: "1" };
    const init = spawnSync(realGit, ["-C", repo, "init", "-q"], { encoding: "utf8", env: plain });
    assert.equal(init.status, 0, init.stderr);
    const value = (key) => spawnSync(realGit, ["-C", repo, "config", "--get", key], { encoding: "utf8", env: plain }).stdout.trim();
    const runWrapper = (...args) => {
      const out = run(args, env, repo);
      assert.equal(out.status, 0, `${args.join(" ")}: ${out.stderr}`);
      return out;
    };

    const added = runWrapper("remote", "add", "origin", "https://x-access-token:ghp_secret@github.com/owner/repo.git");
    assert.match(added.stderr, /carried credentials/);
    assert.equal(value("remote.origin.url"), "https://github.com/owner/repo.git");
    assert.doesNotMatch(fs.readFileSync(path.join(repo, ".git", "config"), "utf8"), /ghp_secret/);

    runWrapper("remote", "set-url", "origin", "https://oauth2:tok_two@gitlab.com/owner/repo.git");
    assert.equal(value("remote.origin.url"), "https://gitlab.com/owner/repo.git");

    runWrapper("config", "remote.origin.url", "https://tok_three@github.com/owner/repo.git");
    assert.equal(value("remote.origin.url"), "https://github.com/owner/repo.git");

    runWrapper("remote", "add", "ssh-pass", "git@github.com:owner/repo.git"); // a login, not a secret
    assert.equal(value("remote.ssh-pass.url"), "git@github.com:owner/repo.git");

    const read = runWrapper("remote", "-v");
    assert.doesNotMatch(read.stdout, /ghp_secret|tok_two|tok_three/);
  });

  it("keeps the credential out of the store trail", () => {
    const dir = caseDir("trail");
    const git = fakeGit(dir, 0);
    const home = path.join(dir, "home");
    const out = run(["clone", "https://x-access-token:ghp_secret@gitlab.com/owner/repo.git", "dest"], {
      MYRMIDON_GIT_REAL: git.bin,
      MYRMIDON_WS_BIN: path.join(dir, "no-myr-ws"),
      MYRMIDON_GIT_LOCAL_MIRROR: path.join(dir, "store"),
      HERMES_HOME: home,
    });

    assert.equal(out.status, 0, out.stderr);
    const trail = path.join(home, ".myrmidon", "git-objects-last-error.json");
    assert.ok(fs.existsSync(trail), "the bypass trail must be written");
    const text = fs.readFileSync(trail, "utf8");
    assert.doesNotMatch(text, /ghp_secret/);
    const record = JSON.parse(text);
    assert.equal(record.url, "https://gitlab.com/owner/repo.git");
    assert.equal(record.detail, "https://gitlab.com/owner/repo.git");
    assert.deepEqual(record.argv, ["clone", "https://gitlab.com/owner/repo.git", "dest"]);
    assert.doesNotMatch(out.stderr, /ghp_secret/);
  });

  it("reads the contract's fixtures and the parse shape of the fallback", () => {
    // The open fixture is what the wrapper must read from the CLI's stdout.
    assert.equal(openFixture.ok, true);
    assert.match(openFixture.key, /^[A-Z][A-Z0-9]*-[0-9]+$/);
    assert.match(openFixture.repo, /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/);
    assert.ok(["E", "G"].includes(openFixture.class));
    assert.equal(typeof openFixture.reused, "boolean");
    assert.equal(lib.readOpenResult(JSON.stringify(openFixture)).key, openFixture.key);
    assert.equal(lib.readOpenResult(JSON.stringify(errorFixture)), null); // ok:false is no copy
    assert.equal(lib.readOpenResult("not json"), null);
    assert.equal(lib.readOpenResult(""), null);

    // The fallback parse (the stand-in for clone-args.js of H1a).
    assert.equal(lib.loadCloneArgs(), null); // no clone-args.js beside the wrapper copy
    const parsed = lib.parseClone(["clone", "--depth", "1", "https://github.com/owner/repo.git", "dest"]);
    assert.deepEqual(
      { kind: parsed.kind, owner: parsed.owner, repo: parsed.repo, dir: parsed.dir, ignored: parsed.ignoredFlags },
      { kind: "github", owner: "owner", repo: "repo", dir: "dest", ignored: ["--depth"] },
    );
    assert.equal(lib.parseClone(["clone", "https://gitlab.com/owner/repo", "dest"]).kind, "foreign");
    assert.equal(lib.parseClone(["fetch", "origin"]), null);
    assert.equal(lib.parseClone(["clone"]), null);
    assert.equal(lib.parseClone(["clone", "https://github.com/owner/repo", "a", "b"]), null);
    assert.equal(
      lib.parseClone(["clone", "--filter", "blob:none", "https://x-access-token:ghp@github.com/owner/repo", "dest"]).hadUserinfo,
      true,
    );

    // The key, the scratch name, the plan and the two switches.
    assert.equal(lib.taskWorkspaceKey({ MYRMIDON_TASK_WORKSPACE: "/workspace/OPE-5347" }), "OPE-5347");
    assert.equal(lib.taskWorkspaceKey({ MYRMIDON_TASK_WORKSPACE: "/workspace/not-a-key/" }), null);
    assert.equal(lib.taskWorkspaceKey({}), null);
    assert.equal(lib.myrWsBin({ MYRMIDON_WS_BIN: "/opt/x/myr-ws" }), "/opt/x/myr-ws");
    assert.equal(lib.myrWsBin({}), "/usr/local/bin/myr-ws");
    assert.equal(lib.referenceMode({ MYRMIDON_GIT_REFERENCE_MODE: "1" }), true);
    assert.equal(lib.referenceMode({}), false);
    const keyPlan = lib.cloneInterceptPlan(["clone", "https://github.com/owner/repo"], {
      MYRMIDON_TASK_WORKSPACE: "/workspace/ABC-101",
      MYRMIDON_WS_BIN: "/opt/x/myr-ws",
    });
    assert.deepEqual(keyPlan.argv, ["open", "ABC-101", "owner/repo", "--json"]);
    assert.equal(keyPlan.bin, "/opt/x/myr-ws");
    assert.equal(keyPlan.target, "/workspace/ABC-101");
    const scratchPlan = lib.cloneInterceptPlan(["clone", "https://github.com/owner/repo", "my-copy"], {});
    assert.deepEqual(scratchPlan.argv, ["open", "my-copy", "owner/repo", "--scratch", "--json"]);
    assert.equal(scratchPlan.target, "/scratch/my-copy");

    // The remote sanitation: all three write forms, and every read left alone.
    assert.equal(lib.stripUserinfo("https://x-access-token:ghp_x@github.com/owner/repo.git"), "https://github.com/owner/repo.git");
    assert.equal(lib.stripUserinfo("ssh://git@github.com/owner/repo.git"), "ssh://git@github.com/owner/repo.git");
    assert.equal(lib.stripUserinfo("git@github.com:owner/repo.git"), "git@github.com:owner/repo.git");
    assert.equal(lib.sanitizeRemoteArgs(["remote", "add", "origin", "https://u:p@github.com/o/r.git"]).url, "https://github.com/o/r.git");
    assert.equal(lib.sanitizeRemoteArgs(["remote", "set-url", "--push", "origin", "https://u:p@github.com/o/r.git"]).changed, true);
    assert.equal(lib.sanitizeRemoteArgs(["config", "--local", "remote.origin.url", "https://u:p@github.com/o/r"]).changed, true);
    assert.equal(lib.sanitizeRemoteArgs(["config", "remote.origin.url"]).changed, false);
    assert.equal(lib.sanitizeRemoteArgs(["config", "--get", "remote.origin.url"]).changed, false);
    assert.equal(lib.sanitizeRemoteArgs(["remote", "-v"]).changed, false);
    assert.equal(lib.sanitizeRemoteArgs(["remote", "add", "o", "git@github.com:o/r.git"]).changed, false);
  });

  it("uses clone-args.js when the module is beside the wrapper", () => {
    const dir = caseDir("clone-args");
    const modulePath = path.join(dir, "clone-args.js");
    const first = path.join(dir, "git-wrapper-1.cjs");
    fs.copyFileSync(WRAPPER_SRC, first);
    fs.writeFileSync(modulePath, 'throw new Error("a broken H1a module");\n');
    const broken = createRequire(import.meta.url)(first);
    // A module that throws must never break a clone: the fallback answers.
    assert.equal(broken.loadCloneArgs(), null);
    assert.equal(broken.parseClone(["fetch", "origin"]), null);

    const second = path.join(dir, "git-wrapper-2.cjs");
    fs.copyFileSync(WRAPPER_SRC, second);
    fs.writeFileSync(
      modulePath,
      'module.exports = { parseCloneArgs: () => ({ kind: "github", owner: "h1a", repo: "module", dir: null, ignoredFlags: [], hadUserinfo: false, fromH1a: true }) };\n',
    );
    const viaModule = createRequire(import.meta.url)(second);
    const parsed = viaModule.parseClone(["clone", "https://github.com/owner/repo"]);
    assert.equal(parsed.fromH1a, true, "the module's parse must win when it is there");
    assert.deepEqual(viaModule.cloneInterceptPlan(["clone", "https://github.com/owner/repo"], {}).argv, [
      "open",
      "module",
      "h1a/module",
      "--scratch",
      "--json",
    ]);
  });
});
