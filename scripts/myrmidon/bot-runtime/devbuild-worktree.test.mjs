import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// myrmidon(1.6.5 BOT-DISK-H2g): devbuild understands a git worktree whose
// `.git` is a FILE (`gitdir: <base>/worktrees/<name>`). Fixture repositories
// are built with the real git; ssh and rsync are stubs that record their
// arguments, so nothing touches the network.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DEVBUILD = path.join(ROOT, "docker/bot-runtime/devbuild/devbuild");
const hasGit = spawnSync("git", ["--version"]).status === 0;
const hasBash = spawnSync("bash", ["--version"]).status === 0;

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

function resolve(p) {
  const r = spawnSync(
    "bash",
    ["-c", 'source "$1"; resolve_git_dir "$2"', "bash", DEVBUILD, p],
    { encoding: "utf8" },
  );
  return { status: r.status, lines: r.stdout.split("\n").slice(0, 4) };
}

describe("devbuild worktree support", { skip: !hasGit || !hasBash }, () => {
  let tmp;
  let clone;
  let base;
  let wt;
  let wtRel;

  before(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "devbuild-wt-")));
    const seed = path.join(tmp, "seed");
    fs.mkdirSync(seed);
    git(seed, "init", "-q", "-b", "main");
    fs.mkdirSync(path.join(seed, "src"));
    fs.writeFileSync(path.join(seed, "src/a.txt"), "a\n");
    fs.writeFileSync(path.join(seed, "b.txt"), "b\n");
    git(seed, "add", ".");
    git(seed, "commit", "-q", "-m", "init");
    // plain clone: .git is a directory
    clone = path.join(tmp, "clone");
    git(tmp, "clone", "-q", seed, clone);
    // bare base + worktree: .git is a file
    base = path.join(tmp, "hermes/.myrmidon/git-base/owner/repo.git");
    fs.mkdirSync(path.dirname(base), { recursive: true });
    git(tmp, "clone", "-q", "--bare", seed, base);
    wt = path.join(tmp, "ws/ABC-1");
    git(base, "worktree", "add", "-q", "-b", "bot/ABC-1", wt, "main");
    wtRel = path.join(tmp, "ws/ABC-2");
    git(base, "worktree", "add", "-q", "-b", "bot/ABC-2", wtRel, "main");
    // git >= 2.48 can write relative paths itself; older git is simulated by hand
    fs.writeFileSync(
      path.join(wtRel, ".git"),
      `gitdir: ${path.relative(wtRel, path.join(base, "worktrees/ABC-2"))}\n`,
    );
  });

  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("a plain clone resolves as before: .git directory, no base", () => {
    const r = resolve(clone);
    assert.equal(r.status, 0);
    assert.deepEqual(r.lines, ["clone", clone, path.join(clone, ".git"), path.join(clone, ".git")]);
  });

  it("a worktree resolves to its admin dir and the bare base", () => {
    const r = resolve(wt);
    assert.equal(r.status, 0);
    assert.equal(fs.statSync(path.join(wt, ".git")).isFile(), true);
    assert.deepEqual(r.lines, ["worktree", wt, path.join(base, "worktrees/ABC-1"), base]);
  });

  it("a subdirectory resolves to the worktree root; tracked files come from git", () => {
    const r = resolve(path.join(wt, "src"));
    assert.equal(r.lines[0], "worktree");
    assert.equal(r.lines[1], wt);
    const files = git(wt, "ls-files").trim().split("\n").sort();
    assert.deepEqual(files, ["b.txt", "src/a.txt"]);
  });

  it("a relative gitdir (newer git writes them) resolves too", () => {
    const r = resolve(wtRel);
    assert.equal(r.status, 0);
    assert.deepEqual(r.lines, ["worktree", wtRel, path.join(base, "worktrees/ABC-2"), base]);
  });

  it("a malformed .git file or no git at all fails with kind none", () => {
    const bad = path.join(tmp, "bad");
    fs.mkdirSync(bad);
    fs.writeFileSync(path.join(bad, ".git"), "garbage\n");
    assert.equal(resolve(bad).status, 1);
    assert.equal(resolve(bad).lines[0], "none");
    const dangling = path.join(tmp, "dangling");
    fs.mkdirSync(dangling);
    fs.writeFileSync(path.join(dangling, ".git"), `gitdir: ${tmp}/nowhere\n`);
    assert.equal(resolve(dangling).status, 1);
  });

  describe("sync with stub ssh/rsync", () => {
    function run(workspace, extraEnv = {}) {
      const bin = path.join(tmp, "bin-" + Math.random().toString(36).slice(2));
      fs.mkdirSync(bin);
      const log = path.join(bin, "calls.log");
      fs.writeFileSync(
        path.join(bin, "ssh"),
        `#!/usr/bin/env bash\necho "SSH $*" >> "${log}"\nif [[ "$*" == *"bash -s"* ]]; then sed 's/^/STDIN /' >> "${log}"; fi\n`,
        { mode: 0o755 },
      );
      fs.writeFileSync(path.join(bin, "rsync"), `#!/usr/bin/env bash\necho "RSYNC $*" >> "${log}"\n`, { mode: 0o755 });
      const key = path.join(bin, "key");
      fs.writeFileSync(key, "x", { mode: 0o600 });
      const r = spawnSync("bash", [DEVBUILD, "true"], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          DEVBUILD_HOST: "build.example.invalid",
          DEVBUILD_USER: "builder",
          DEVBUILD_BASE: "/srv/devbuild",
          DEVBUILD_BOT_NAME: "bot1",
          DEVBUILD_SSH_KEY: key,
          DEVBUILD_KNOWN_HOSTS: path.join(bin, "kh"),
          DEVBUILD_WORKSPACE: workspace,
          HERMES_HOME: path.join(tmp, "hermes"),
          ...extraEnv,
        },
      });
      return { r, calls: fs.readFileSync(log, "utf8") };
    }

    it("worktree: ships base and admin dir, rewrites .git and gitdir on the VPS", () => {
      const { r, calls } = run(wt);
      assert.equal(r.status, 0, r.stderr);
      assert.match(calls, new RegExp(`RSYNC .*--exclude worktrees/ .*${base}/ builder@build\\.example\\.invalid:/srv/devcache/git-wt/bot1/[0-9a-f]{16}\\.git/`));
      assert.match(calls, new RegExp(`RSYNC .*--delete .*${base}/worktrees/ABC-1/ .*:/srv/devcache/git-wt/bot1/[0-9a-f]{16}\\.git/worktrees/ABC-1/`));
      assert.match(calls, /STDIN printf 'gitdir: %s\/worktrees\/%s\\n'/);
      assert.match(calls, /SSH .* bash -s -- \/srv\/devbuild\/bot1\/ABC-1 \/srv\/devcache\/git-wt\/bot1\/[0-9a-f]{16}\.git ABC-1/);
      // nothing treats the worktree's .git as a directory
      assert.doesNotMatch(calls, /ABC-1\/\.git\/objects/);
    });

    it("plain clone: no base shipped, no worktree rewrite", () => {
      const { r, calls } = run(clone);
      assert.equal(r.status, 0, r.stderr);
      assert.doesNotMatch(calls, /git-wt/);
      assert.doesNotMatch(calls, /bash -s/);
    });

    it("worktree whose base is outside the git-base root is refused", () => {
      const { r } = run(wt, { MYRMIDON_GIT_BASE_DIR: path.join(tmp, "elsewhere") });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /outside/);
    });
  });
});
