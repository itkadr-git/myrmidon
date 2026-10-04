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
      ["clone", "--reference", "/x", "https://github.com/owner/repo"],
      ["clone", "--dissociate", "https://github.com/owner/repo"],
      ["clone", "--depth", "1", "https://github.com/owner/repo"],
      ["clone", "--depth=1", "https://github.com/owner/repo"],
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

  it("never builds a mirror path from an unsafe name", () => {
    const root = mirrors();
    for (const url of ["https://github.com/owner/..%2f..", "https://github.com/../repo", "https://github.com/owner/re po"]) {
      const argv = ["clone", url];
      assert.deepEqual(lib.rewriteArgs(argv, root), argv, url);
    }
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
    assert.equal(alternates, path.join(mirror, "objects"));
    assert.equal(fs.readFileSync(path.join(dest, "a.txt"), "utf8"), "a\n");
    // The clone's own object store holds no commit, tree or blob of the mirrored history.
    const own = git(dest, "count-objects", "-v");
    assert.match(own, /^count: 0$/m);
    assert.match(own, /^in-pack: 0$/m);

    assert.equal(run("rev-parse", "--is-inside-work-tree").status, 128); // not a repository: status passes through
    assert.equal(run("-C", dest, "rev-parse", "--is-inside-work-tree").stdout.trim(), "true");
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
});
