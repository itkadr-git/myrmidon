import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// myrmidon(MYR-WS-RECOVER): `myr-ws open` must not hand on a copy that a run left
// half-way (merge/rebase/cherry-pick in progress, unresolved stages, detached head,
// another branch than the registry says), must take --branch / --repository, and
// `myr-ws repair` (botd) does the same for copies nobody is about to open. Nothing is
// lost: the state goes to refs/myr-ws/recovery/<KEY> first. Same fake base as
// myr-ws-open.test.mjs: a bare repository fetched from a local "origin", no network.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(import.meta.url);
const ws = require(path.join(ROOT, "docker/bot-runtime/myr-ws/lib/open.js"));
const wsRepair = require(path.join(ROOT, "docker/bot-runtime/myr-ws/lib/repair.js"));
const wsCli = require(path.join(ROOT, "docker/bot-runtime/myr-ws/lib/cli.js"));

const GIT = process.env.GIT_TEST_EXECUTABLE || "git";
const hasGit = spawnSync(GIT, ["--version"]).status === 0;
const REPO = "acme/widgets";
const OTHER_REPO = "acme/deploy";

let tmp;
let originDir;
let n = 0;
let ctx;

function gitEnv() {
  return {
    PATH: "/usr/bin:/bin",
    HOME: tmp,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "user.name",
    GIT_CONFIG_VALUE_0: "t",
    GIT_CONFIG_KEY_1: "user.email",
    GIT_CONFIG_VALUE_1: "t@example.com",
  };
}

function gitRaw(cwd, ...args) {
  return spawnSync(GIT, args, { cwd, encoding: "utf8", env: gitEnv() });
}

function git(cwd, ...args) {
  const r = gitRaw(cwd, ...args);
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "myr-ws-recover-test-"));
  if (!hasGit) return;
  const seed = path.join(tmp, "seed");
  fs.mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(seed, "README.md"), "# widgets\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "init");
  originDir = path.join(tmp, "origin.git");
  git(tmp, "clone", "-q", "--bare", seed, originDir);
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  const root = path.join(tmp, `case-${++n}`);
  const home = path.join(root, "myrmidon");
  fs.mkdirSync(home, { recursive: true });
  ctx = {
    env: {
      ...process.env,
      MYRMIDON_GIT_REAL: GIT,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_COUNT: "4",
      GIT_CONFIG_KEY_0: "user.name",
      GIT_CONFIG_VALUE_0: "t",
      GIT_CONFIG_KEY_1: "user.email",
      GIT_CONFIG_VALUE_1: "t@example.com",
      GIT_CONFIG_KEY_2: "credential.helper",
      GIT_CONFIG_VALUE_2: "",
      GIT_CONFIG_KEY_3: "core.askPass",
      GIT_CONFIG_VALUE_3: "",
    },
    root,
    home,
    workspaceRoot: path.join(root, "workspace"),
    scratchRoot: path.join(root, "scratch"),
    ensureBase(repo) {
      const base = path.join(home, "git-base", `${repo}.git`);
      if (!fs.existsSync(base)) {
        fs.mkdirSync(base, { recursive: true });
        git(base, "init", "-q", "--bare");
        git(base, "remote", "add", "origin", `file://${originDir}`);
        git(base, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
        git(base, "fetch", "-q", "origin");
      }
      git(base, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
      return base;
    },
  };
});

const baseOf = (repo = REPO) => path.join(ctx.home, "git-base", `${repo}.git`);
const run = (argv, extra = {}) => ws.runOpen(argv, { ...ctx, ...extra });
const opened = async (argv) => {
  const r = await run([...argv, "--json"]);
  assert.equal(r.exitCode, 0, r.stderr || r.stdout);
  return JSON.parse(r.stdout);
};
const registry = () => JSON.parse(fs.readFileSync(path.join(ctx.home, "ws-registry.json"), "utf8"));

/** Commits `content` to README.md of origin's `branch` (default main) and refreshes the base's remote refs. */
function advanceOrigin(content, branch = "main", file = "README.md") {
  const dir = path.join(ctx.root, `adv-${++n}`);
  git(tmp, "clone", "-q", originDir, dir);
  const exists = gitRaw(dir, "rev-parse", "--verify", "--quiet", `origin/${branch}`).status === 0;
  if (exists) git(dir, "checkout", "-q", "-B", branch, `origin/${branch}`);
  else git(dir, "checkout", "-q", "-b", branch);
  fs.writeFileSync(path.join(dir, file), content);
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", `advance ${branch}`);
  git(dir, "push", "-q", "origin", `HEAD:refs/heads/${branch}`);
  if (fs.existsSync(baseOf())) git(baseOf(), "fetch", "-q", `file://${originDir}`, "+refs/heads/*:refs/remotes/origin/*");
}

/** A copy with one local commit on README.md that conflicts with the advanced origin/main. */
async function conflictingCopy(key) {
  const first = await opened([key, REPO]);
  fs.writeFileSync(path.join(first.path, "README.md"), "copy side\n");
  git(first.path, "add", ".");
  git(first.path, "commit", "-q", "-m", "copy change");
  advanceOrigin(`main side ${key}\n`);
  return first;
}

const gitPath = (dir, name) => path.resolve(dir, git(dir, "rev-parse", "--git-path", name));
const assertClean = (dir) => {
  assert.equal(git(dir, "status", "--porcelain"), "");
  assert.equal(git(dir, "ls-files", "-u"), "");
  for (const m of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"]) {
    assert.equal(fs.existsSync(gitPath(dir, m)), false, `${m} is still there`);
  }
};

describe("myr-ws open — a copy left half-way is repaired, not reused", { skip: !hasGit }, () => {
  it("aborts a merge in progress, keeps the state in refs/myr-ws/recovery/<KEY> and says so", async () => {
    const first = await conflictingCopy("ABC-301");
    const head = git(first.path, "rev-parse", "HEAD");
    assert.notEqual(gitRaw(first.path, "merge", "origin/main").status, 0);
    assert.ok(fs.existsSync(gitPath(first.path, "MERGE_HEAD")));
    assert.notEqual(git(first.path, "ls-files", "-u"), "");

    const r = await run(["ABC-301", REPO, "--json"]);
    assert.equal(r.exitCode, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.reused, true);
    assert.equal(out.path, first.path);
    assert.equal(out.recovered.length, 1);
    assert.equal(out.recovered[0].problem, "merge_in_progress");
    assert.equal(out.recovered[0].action, "aborted");
    assert.equal(out.recoveryRef, "refs/myr-ws/recovery/ABC-301");
    assert.match(r.stderr, /ABC-301: copy was not clean \(merge_in_progress -> aborted/);
    assertClean(first.path);
    assert.equal(git(first.path, "rev-parse", "HEAD"), head);

    // the conflicted state is kept: both parents, conflict markers in the stored file
    const ref = out.recoveryRef;
    assert.equal(git(first.path, "rev-list", "--parents", "-n", "1", ref).split(" ").length, 3);
    assert.match(git(first.path, "show", `${ref}:README.md`), /<<<<<<</);
    // and the next open is the plain idempotent one
    const again = await opened(["ABC-301", REPO]);
    assert.equal(again.recovered, undefined);
    assert.equal(again.reused, true);
  });

  it("saves untracked and unstaged work made during the merge, a second incident gets its own ref", async () => {
    const first = await conflictingCopy("ABC-302");
    assert.notEqual(gitRaw(first.path, "merge", "origin/main").status, 0);
    fs.writeFileSync(path.join(first.path, "notes.txt"), "my notes\n");
    const one = await opened(["ABC-302", REPO]);
    assert.equal(git(first.path, "show", `${one.recoveryRef}:notes.txt`), "my notes");

    advanceOrigin("main side again\n");
    assert.notEqual(gitRaw(first.path, "merge", "origin/main").status, 0);
    const two = await opened(["ABC-302", REPO]);
    assert.notEqual(two.recoveryRef, one.recoveryRef);
    assert.match(two.recoveryRef, /^refs\/myr-ws\/recovery\/ABC-302-\d+$/);
    assert.equal(git(first.path, "rev-parse", "--verify", one.recoveryRef).length, 40);
  });

  it("aborts a rebase in progress", async () => {
    const first = await conflictingCopy("ABC-303");
    const head = git(first.path, "rev-parse", "HEAD");
    assert.notEqual(gitRaw(first.path, "rebase", "origin/main").status, 0);
    assert.ok(fs.existsSync(gitPath(first.path, "rebase-merge")) || fs.existsSync(gitPath(first.path, "rebase-apply")));
    const out = await opened(["ABC-303", REPO]);
    assert.ok(out.recovered.some((r) => r.problem === "rebase_in_progress" && r.action === "aborted"), JSON.stringify(out.recovered));
    assertClean(first.path);
    assert.equal(git(first.path, "rev-parse", "--abbrev-ref", "HEAD"), "bot/ABC-303");
    assert.equal(git(first.path, "rev-parse", "HEAD"), head);
  });

  it("aborts a cherry-pick in progress", async () => {
    const first = await conflictingCopy("ABC-304");
    assert.notEqual(gitRaw(first.path, "cherry-pick", "origin/main").status, 0);
    assert.ok(fs.existsSync(gitPath(first.path, "CHERRY_PICK_HEAD")));
    const out = await opened(["ABC-304", REPO]);
    assert.ok(out.recovered.some((r) => r.problem === "cherry_pick_in_progress" && r.action === "aborted"), JSON.stringify(out.recovered));
    assertClean(first.path);
  });

  it("clears unresolved stages that no operation marker explains", async () => {
    const first = await conflictingCopy("ABC-305");
    assert.notEqual(gitRaw(first.path, "merge", "origin/main").status, 0);
    fs.rmSync(gitPath(first.path, "MERGE_HEAD"));
    assert.notEqual(git(first.path, "ls-files", "-u"), "");
    const out = await opened(["ABC-305", REPO]);
    assert.ok(out.recovered.some((r) => r.problem === "unmerged_paths"), JSON.stringify(out.recovered));
    assertClean(first.path);
    assert.match(git(first.path, "show", `${out.recoveryRef}:README.md`), /<<<<<<</);
  });

  it("recreates the worktree when the abort does not clean it, on the same branch, with the state saved", async () => {
    const first = await opened(["ABC-306", REPO]);
    fs.writeFileSync(path.join(first.path, "wip.txt"), "wip\n");
    const head = git(first.path, "rev-parse", "HEAD");
    // an interrupted rebase whose bookkeeping is unreadable: `rebase --abort` cannot succeed
    const dir = gitPath(first.path, "rebase-merge");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "head-name"), "refs/heads/does-not-exist\n");
    const out = await opened(["ABC-306", REPO]);
    assert.equal(out.reused, true);
    assert.ok(out.recovered.length >= 1);
    assert.equal(git(out.path, "ls-files", "-u"), "");
    for (const m of ["MERGE_HEAD", "rebase-merge", "rebase-apply"]) assert.equal(fs.existsSync(gitPath(out.path, m)), false, `${m} is still there`);
    assert.equal(git(out.path, "rev-parse", "--abbrev-ref", "HEAD"), "bot/ABC-306");
    assert.equal(git(out.path, "rev-parse", "HEAD"), head);
    assert.equal(git(out.path, "show", `${out.recoveryRef}:wip.txt`), "wip");
  });

  it("follows a branch the bot moved the copy to into the registry and reports it", async () => {
    const first = await opened(["ABC-307", REPO]);
    git(first.path, "switch", "-q", "-c", "my-own-branch");
    const out = await opened(["ABC-307", REPO]);
    assert.equal(out.branch, "my-own-branch");
    assert.equal(out.recovered[0].problem, "branch_mismatch");
    assert.equal(out.recovered[0].action, "registry_synced");
    assert.equal(git(first.path, "rev-parse", "--abbrev-ref", "HEAD"), "my-own-branch");
    assert.equal(registry().entries.find((e) => e.key === "ABC-307").branch, "my-own-branch");
    assert.equal((await opened(["ABC-307", REPO])).recovered, undefined);
  });

  it("returns a detached head to the task branch; the commit and local changes are kept", async () => {
    const first = await opened(["ABC-308", REPO]);
    git(first.path, "checkout", "-q", "--detach");
    fs.writeFileSync(path.join(first.path, "d.txt"), "detached work\n");
    git(first.path, "add", ".");
    git(first.path, "commit", "-q", "-m", "detached commit");
    const detachedHead = git(first.path, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(first.path, "loose.txt"), "loose\n");
    const out = await opened(["ABC-308", REPO]);
    assert.equal(out.recovered[0].problem, "detached_head");
    assert.equal(out.recovered[0].action, "switched_branch");
    assert.equal(git(first.path, "rev-parse", "--abbrev-ref", "HEAD"), "bot/ABC-308");
    assert.equal(git(first.path, "rev-parse", out.recoveryRef + "^"), detachedHead);
    assert.equal(git(first.path, "show", `${out.recoveryRef}:loose.txt`), "loose");
    assert.match(git(first.path, "stash", "list", "--format=%s"), /myr-ws recovery ABC-308/);
    assert.equal(git(first.path, "status", "--porcelain"), "");
  });

  it("moves a dead worktree (its git directory is gone) aside and creates a fresh copy", async () => {
    const first = await opened(["ABC-309", REPO]);
    const admin = fs.readFileSync(path.join(first.path, ".git"), "utf8").replace(/^gitdir:\s*/, "").trim();
    fs.rmSync(admin, { recursive: true, force: true });
    const out = await opened(["ABC-309", REPO]);
    assert.equal(out.reused, false);
    assert.equal(out.recovered[0].problem, "broken_git");
    assert.equal(out.recovered[0].action, "moved_aside");
    assert.equal(git(out.path, "rev-parse", "--abbrev-ref", "HEAD"), "bot/ABC-309");
    assert.ok(fs.readdirSync(ctx.workspaceRoot).some((f) => f.startsWith("ABC-309.broken-")));
  });

  it("leaves a clean copy alone: no recovery fields, no recovery ref", async () => {
    const first = await opened(["ABC-310", REPO]);
    const again = await opened(["ABC-310", REPO]);
    assert.equal(again.recovered, undefined);
    assert.equal(again.recoveryRef, undefined);
    assert.equal(gitRaw(first.path, "show-ref", "--verify", "--quiet", "refs/myr-ws/recovery/ABC-310").status, 1);
  });
});

describe("myr-ws open --branch / --repository", { skip: !hasGit }, () => {
  it("opens a new copy on the PR branch from its remote state", async () => {
    advanceOrigin("pr work\n", "feature/pr-1", "pr.txt");
    const remoteHead = git(originDir, "rev-parse", "refs/heads/feature/pr-1");
    const out = await opened(["ABC-311", REPO, "--branch", "feature/pr-1"]);
    assert.equal(out.branch, "feature/pr-1");
    assert.equal(git(out.path, "rev-parse", "--abbrev-ref", "HEAD"), "feature/pr-1");
    assert.equal(git(out.path, "rev-parse", "HEAD"), remoteHead);
    assert.equal(registry().entries.find((e) => e.key === "ABC-311").branch, "feature/pr-1");
  });

  it("fetches a PR branch the base has not seen yet", async () => {
    await opened(["ABC-312", REPO]); // creates the base
    const dir = path.join(ctx.root, "late");
    git(tmp, "clone", "-q", originDir, dir);
    git(dir, "checkout", "-q", "-b", "feature/late");
    fs.writeFileSync(path.join(dir, "late.txt"), "late\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "late");
    git(dir, "push", "-q", "origin", "HEAD:refs/heads/feature/late");
    // the base's origin url is a file:// url in this fake, so the targeted fetch works as on github
    const out = await opened(["ABC-313", REPO, "--branch=feature/late"]);
    assert.equal(git(out.path, "show", "HEAD:late.txt"), "late");
  });

  it("moves an existing copy from bot/<KEY> to the PR branch, stashing local changes", async () => {
    advanceOrigin("pr work 2\n", "feature/pr-2", "pr2.txt");
    const first = await opened(["ABC-314", REPO]);
    assert.equal(first.branch, "bot/ABC-314");
    fs.writeFileSync(path.join(first.path, "scratch.txt"), "local\n");
    const out = await opened(["ABC-314", REPO, "--branch", "feature/pr-2"]);
    assert.equal(out.reused, true);
    assert.equal(out.branch, "feature/pr-2");
    assert.equal(out.recovered[0].action, "switched_branch");
    assert.equal(git(first.path, "rev-parse", "--abbrev-ref", "HEAD"), "feature/pr-2");
    assert.match(git(first.path, "stash", "list", "--format=%s"), /myr-ws recovery ABC-314/);
    assert.equal(git(first.path, "show", `${out.recoveryRef}:scratch.txt`), "local");
    assert.equal(registry().entries.find((e) => e.key === "ABC-314").branch, "feature/pr-2");
    // asking for the same branch again changes nothing
    assert.equal((await opened(["ABC-314", REPO, "--branch", "feature/pr-2"])).recovered, undefined);
  });

  it("--repository is the same as the positional repository; a contradiction is a usage error", async () => {
    const out = await opened(["ABC-315", "--repository", REPO]);
    assert.equal(out.repo, REPO);
    const bad = await run(["ABC-316", OTHER_REPO, "--repository", REPO, "--json"]);
    assert.equal(bad.exitCode, ws.EXIT.usage);
    const same = await run(["ABC-317", REPO, `--repository=${REPO}`, "--json"]);
    assert.equal(same.exitCode, 0);
  });

  it("rejects branch names that could be options, traversal or the recovery namespace", async () => {
    for (const b of ["-x", "a..b", "myr-ws/recovery/ABC-1", "HEAD", "a b", "x.lock", "a//b", "a@{b"]) {
      const r = await run(["ABC-318", REPO, `--branch=${b}`, "--json"]);
      assert.equal(r.exitCode, ws.EXIT.usage, `${b}: ${r.stdout}`);
    }
    const scratch = await run(["--scratch", "tmp1", "--branch", "x", "--json"]);
    assert.equal(scratch.exitCode, ws.EXIT.usage);
    const missing = await run(["ABC-318", REPO, "--branch"]);
    assert.equal(missing.exitCode, ws.EXIT.usage);
  });

  it("two repositories of one task, each on its own branch", async () => {
    const a = await opened(["ABC-319", REPO]);
    const b = await opened(["ABC-319", OTHER_REPO, "--branch", "fix/deploy"]);
    assert.notEqual(a.path, b.path);
    assert.equal(b.branch, "fix/deploy");
    assert.equal(git(b.path, "rev-parse", "--abbrev-ref", "HEAD"), "fix/deploy");
    assert.equal(git(a.path, "rev-parse", "--abbrev-ref", "HEAD"), "bot/ABC-319");
  });

  it("the CLI frame passes --branch and --repository through", () => {
    const parsed = wsCli.parseArgs(["open", "ABC-1", "--repository", REPO, "--branch", "fix/x", "--json"]);
    assert.equal(parsed.flags.branch, "fix/x");
    assert.equal(parsed.flags.repository, REPO);
    assert.throws(() => wsCli.parseArgs(["open", "ABC-1", "--branch"]), /needs a value/);
    assert.match(wsCli.USAGE, /--branch/);
    assert.match(wsCli.USAGE, /repair/);
  });
});

describe("myr-ws repair (botd) — copies nobody is about to open", { skip: !hasGit }, () => {
  /** A fake /proc: one process per entry, its cwd a symlink. */
  function fakeProc(cwds) {
    const proc = path.join(ctx.root, "proc");
    fs.rmSync(proc, { recursive: true, force: true });
    fs.mkdirSync(proc, { recursive: true });
    cwds.forEach((cwd, i) => {
      fs.mkdirSync(path.join(proc, String(1000 + i)), { recursive: true });
      fs.symlinkSync(cwd, path.join(proc, String(1000 + i), "cwd"));
    });
    return proc;
  }
  const repair = (args, extra) => wsRepair.repair({ positionals: args, env: ctx.env }, { ...ctx, ...extra });

  it("aborts the merge an interrupted run left, saving the state first", async () => {
    const first = await conflictingCopy("ABC-321");
    assert.notEqual(gitRaw(first.path, "merge", "origin/main").status, 0);
    const res = await repair([], { procRoot: fakeProc([os.tmpdir()]) });
    assert.equal(res.errors.length, 0, JSON.stringify(res.errors));
    assert.equal(res.repaired.length, 1);
    assert.equal(res.repaired[0].key, "ABC-321");
    assert.equal(res.repaired[0].recovered[0].action, "aborted");
    assert.match(git(first.path, "show", `${res.repaired[0].recoveryRef}:README.md`), /<<<<<<</);
    assertClean(first.path);
    assert.match(res.human, /ABC-321/);
    const again = await repair([], { procRoot: fakeProc([os.tmpdir()]) });
    assert.equal(again.repaired.length, 0);
    assert.match(again.human, /nothing to repair/);
  });

  it("does not touch a copy a process works in, nor when it cannot tell", async () => {
    const first = await conflictingCopy("ABC-322");
    assert.notEqual(gitRaw(first.path, "merge", "origin/main").status, 0);
    const busy = await repair([], { procRoot: fakeProc([path.join(first.path, "sub")]) });
    assert.equal(busy.repaired.length, 0);
    assert.match(busy.skipped[0].reason, /process is running/);
    const blind = await repair([], { procRoot: path.join(ctx.root, "no-proc") });
    assert.equal(blind.repaired.length, 0);
    assert.match(blind.skipped[0].reason, /cannot tell/);
    assert.ok(fs.existsSync(gitPath(first.path, "MERGE_HEAD")));
  });

  it("repairs only the named key and leaves branch policy to open", async () => {
    const a = await conflictingCopy("ABC-323");
    assert.notEqual(gitRaw(a.path, "merge", "origin/main").status, 0);
    const b = await opened(["ABC-324", REPO]);
    git(b.path, "switch", "-q", "-c", "elsewhere");
    const proc = fakeProc([os.tmpdir()]);
    const other = await repair(["ABC-324"], { procRoot: proc });
    assert.equal(other.repaired.length, 0);
    assert.ok(fs.existsSync(gitPath(a.path, "MERGE_HEAD")));
    const named = await repair(["ABC-323"], { procRoot: proc });
    assert.equal(named.repaired.length, 1);
    assert.equal(git(b.path, "rev-parse", "--abbrev-ref", "HEAD"), "elsewhere");
    assert.equal(registry().entries.find((e) => e.key === "ABC-324").branch, "bot/ABC-324");
  });

  it("is reachable as a verb of the CLI frame", async () => {
    assert.ok(Object.hasOwn(wsCli.COMMANDS, "repair"));
    const r = await wsCli.run(["repair", "--json"], { env: { ...ctx.env, MYRMIDON_WS_HOME: ctx.home }, commands: { repair: async () => ({ repaired: [], skipped: [], errors: [] }) } });
    assert.equal(r.exitCode, 0);
    assert.equal(JSON.parse(r.stdout).ok, true);
  });
});
