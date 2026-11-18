import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// myrmidon(1.6.5 BOT-DISK-H2b): docker/bot-runtime/myr-ws/lib/open.js — the
// `open` verb of myr-ws. The class-D base comes from ensureBase (H2a), which is
// faked here with a bare repository fetched from a local "origin"; nothing
// touches the network. Result shapes are checked against the contract schemas
// (packages/shared/src/myrmidon-bot-workspace.ts) and its fixtures.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(import.meta.url);
const ws = require(path.join(ROOT, "docker/bot-runtime/myr-ws/lib/open.js"));
const FIXTURES = path.join(ROOT, "docs/myrmidon/bot-disk-contract");

const GIT = process.env.GIT_TEST_EXECUTABLE || "git";
const hasGit = spawnSync(GIT, ["--version"]).status === 0;

// The contract schemas are zod over TypeScript; Node strips the types itself.
// Without an installed workspace (no zod) the schema checks fall back to the
// structural checks below, and CI (pnpm install) runs the real ones.
let schemas = null;
try {
  schemas = await import(path.join(ROOT, "packages/shared/src/myrmidon-bot-workspace.ts"));
} catch {
  schemas = null;
}

const REPO = "acme/widgets";
let tmp;
let originDir;
let n = 0;
let ctx; // per-test: home, workspaceRoot, scratchRoot, ensureBase, calls

function git(cwd, ...args) {
  const r = spawnSync(GIT, ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd,
    encoding: "utf8",
    env: {
      PATH: "/usr/bin:/bin",
      HOME: tmp,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "user.name",
      GIT_CONFIG_VALUE_0: "t",
      GIT_CONFIG_KEY_1: "user.email",
      GIT_CONFIG_VALUE_1: "t@example.com",
    },
  });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "myr-ws-open-test-"));
  if (!hasGit) return;
  const seed = path.join(tmp, "seed");
  fs.mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(seed, "README.md"), "# widgets\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "init");
  git(seed, "branch", "release");
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
  const calls = [];
  ctx = {
    env: {
      ...process.env,
      PATH: process.env.PATH.split(":").filter((p) => !p.includes("paperclip-github-runtime")).join(":"),
      MYRMIDON_GIT_REAL: GIT,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_COUNT: "6",
      GIT_CONFIG_KEY_0: "user.name",
      GIT_CONFIG_VALUE_0: "t",
      GIT_CONFIG_KEY_1: "user.email",
      GIT_CONFIG_VALUE_1: "t@example.com",
      GIT_CONFIG_KEY_2: "user.useConfigOnly",
      GIT_CONFIG_VALUE_2: "false",
      GIT_CONFIG_KEY_3: "credential.helper",
      GIT_CONFIG_VALUE_3: "",
      GIT_CONFIG_KEY_4: "core.askPass",
      GIT_CONFIG_VALUE_4: "",
      GIT_CONFIG_KEY_5: "credential.interactive",
      GIT_CONFIG_VALUE_5: "never",
    },
    home,
    workspaceRoot: path.join(root, "workspace"),
    scratchRoot: path.join(root, "scratch"),
    calls,
    // Fake of lib/base.js ensureBase: a bare base whose origin is the local repo.
    ensureBase(repo) {
      calls.push(repo);
      const base = path.join(home, "git-base", `${repo}.git`);
      if (!fs.existsSync(base)) {
        fs.mkdirSync(base, { recursive: true });
        git(base, "init", "-q", "--bare");
        git(base, "remote", "add", "origin", `file://${originDir}`);
        git(base, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
        git(base, "fetch", "-q", "origin");
        git(base, "config", "remote.origin.url", `https://github.com/${repo}.git`);
      }
      git(base, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
      return base;
    },
  };
});

const run = (argv, extra = {}) => ws.runOpen(argv, { ...ctx, ...extra });
const copyOf = (r) => JSON.parse(r.stdout);

function checkOpenSchema(value) {
  if (schemas) return schemas.myrWsOpenResultSchema.parse(value);
  for (const f of ["ok", "key", "path", "class", "reused"]) assert.ok(f in value, `missing ${f}`);
  return value;
}

describe("myr-ws open — contract constants", () => {
  it("exit codes and the quota prefix match the contract", { skip: !schemas }, () => {
    assert.deepEqual(ws.EXIT, schemas.MYR_WS_EXIT);
    assert.equal(ws.QUOTA_PREFIX, schemas.MYR_WS_QUOTA_ERROR_PREFIX);
  });

  it("the open fixture passes the schema and has the keys open emits", { skip: !schemas }, () => {
    const fx = JSON.parse(fs.readFileSync(path.join(FIXTURES, "myr-ws-open.json"), "utf8"));
    schemas.myrWsOpenResultSchema.parse(fx);
  });
});

describe("myr-ws open — task copy", { skip: !hasGit }, () => {
  it("creates its real git base under MYRMIDON_WS_HOME", async () => {
    const originRoot = path.join(tmp, `local-origin-${n}`);
    const repoOrigin = path.join(originRoot, "acme", "widgets.git");
    fs.mkdirSync(path.dirname(repoOrigin), { recursive: true });
    git(tmp, "clone", "-q", "--bare", originDir, repoOrigin);
    const env = {
      ...ctx.env,
      MYRMIDON_WS_HOME: ctx.home,
      MYRMIDON_WS_REMOTE_BASE: `file://${originRoot}`,
    };
    const result = await run(["ABC-100", REPO, "--json"], { env, ensureBase: null });
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    const out = copyOf(result);
    const base = path.join(ctx.home, "git-base", "acme", "widgets.git");
    assert.equal(git(base, "rev-parse", "--is-bare-repository"), "true");
    const common = git(out.path, "rev-parse", "--git-common-dir");
    assert.equal(fs.realpathSync(path.resolve(out.path, common)), fs.realpathSync(base));
    assert.equal(fs.readFileSync(path.join(out.path, "README.md"), "utf8"), "# widgets\n");
  });

  it("creates a worktree of the base on bot/<KEY> without an object store", async () => {
    const r = await run(["ABC-101", REPO, "--json"]);
    assert.equal(r.exitCode, 0, r.stderr);
    const out = checkOpenSchema(copyOf(r));
    assert.deepEqual(
      { key: out.key, class: out.class, repo: out.repo, branch: out.branch, base: out.base, reused: out.reused },
      { key: "ABC-101", class: "E", repo: REPO, branch: "bot/ABC-101", base: "origin/main", reused: false },
    );
    assert.equal(out.path, path.join(ctx.workspaceRoot, "ABC-101"));
    assert.ok(fs.statSync(path.join(out.path, ".git")).isFile(), ".git must be a file (worktree), not a directory");
    assert.ok(!fs.existsSync(path.join(out.path, ".git", "objects")));
    assert.equal(fs.readFileSync(path.join(out.path, "README.md"), "utf8"), "# widgets\n");
    assert.equal(git(out.path, "rev-parse", "--abbrev-ref", "HEAD"), "bot/ABC-101");
    // objects live once, in the base
    const common = git(out.path, "rev-parse", "--git-common-dir");
    assert.equal(fs.realpathSync(path.resolve(out.path, common)), fs.realpathSync(path.join(ctx.home, "git-base", `${REPO}.git`)));
    assert.ok(git(path.join(ctx.home, "git-base", `${REPO}.git`), "worktree", "list", "--porcelain").includes(fs.realpathSync(out.path)));
  });

  it("records the copy in the registry in the C1 shape", async () => {
    await run(["ABC-101", REPO]);
    const reg = JSON.parse(fs.readFileSync(path.join(ctx.home, "ws-registry.json"), "utf8"));
    assert.equal(reg.version, 1);
    assert.equal(reg.entries.length, 1);
    const e = reg.entries[0];
    assert.deepEqual(
      { key: e.key, repo: e.repo, class: e.class, branch: e.branch, path: e.path },
      { key: "ABC-101", repo: REPO, class: "E", branch: "bot/ABC-101", path: path.join(ctx.workspaceRoot, "ABC-101") },
    );
    assert.match(e.openedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    if (schemas) schemas.wsRegistrySchema.parse(reg);
  });

  it("is idempotent: the second open returns the same path, code 0, nothing recreated", async () => {
    const first = copyOf(await run(["ABC-101", REPO, "--json"]));
    fs.writeFileSync(path.join(first.path, "work.txt"), "mine\n");
    const regBefore = fs.readFileSync(path.join(ctx.home, "ws-registry.json"), "utf8");
    const r = await run(["ABC-101", REPO, "--json"]);
    assert.equal(r.exitCode, 0, r.stderr);
    const second = checkOpenSchema(copyOf(r));
    assert.equal(second.path, first.path);
    assert.equal(second.reused, true);
    assert.equal(fs.readFileSync(path.join(first.path, "work.txt"), "utf8"), "mine\n");
    assert.equal(fs.readFileSync(path.join(ctx.home, "ws-registry.json"), "utf8"), regBefore);
    assert.equal(ctx.calls.length, 1, "the base is not asked for again");
    // without the repository argument the existing copy is still found
    const third = copyOf(await run(["ABC-101", "--json"]));
    assert.equal(third.path, first.path);
    assert.equal(third.reused, true);
  });

  it("refuses a nested standalone clone without changing its files", async () => {
    const first = copyOf(await run(["ABC-126", REPO, "--json"]));
    const nested = path.join(first.path, "deep", "repo");
    fs.mkdirSync(path.dirname(nested));
    git(tmp, "clone", "-q", originDir, nested);
    fs.writeFileSync(path.join(nested, "untracked.txt"), "keep me\n");
    const result = await run(["ABC-126", REPO, "--json"]);
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /nested.*clone/i);
    assert.ok(result.stderr.includes(nested));
    assert.equal(fs.readFileSync(path.join(nested, "untracked.txt"), "utf8"), "keep me\n");
  });

  it("finds a nested clone at depth 1 and ignores one under node_modules", async () => {
    const first = copyOf(await run(["ABC-128", REPO, "--json"]));
    const ignored = path.join(first.path, "node_modules", "pkg", "repo");
    fs.mkdirSync(path.dirname(ignored), { recursive: true });
    git(tmp, "clone", "-q", originDir, ignored);
    const ok = await run(["ABC-128", REPO, "--json"]);
    assert.equal(ok.exitCode, 0, ok.stderr);
    const nested = path.join(first.path, "repo");
    git(tmp, "clone", "-q", originDir, nested);
    const refused = await run(["ABC-128", REPO, "--json"]);
    assert.equal(refused.exitCode, 2);
    assert.ok(refused.stderr.includes(nested));
    assert.ok(fs.existsSync(path.join(ignored, ".git", "objects")));
  });

  it("allows nested linked worktrees and real submodules with gitfiles", async () => {
    const first = copyOf(await run(["ABC-127", REPO, "--json"]));
    const nested = path.join(first.path, "linked");
    git(first.path, "worktree", "add", "--detach", nested, "HEAD");
    git(first.path, "-c", "protocol.file.allow=always", "submodule", "add", "-q", originDir, "module");
    assert.ok(fs.statSync(path.join(first.path, "module", ".git")).isFile());
    fs.mkdirSync(path.join(first.path, "node_modules", "package"), { recursive: true });
    fs.writeFileSync(path.join(first.path, "node_modules", "package", "index.js"), "module.exports = 1;\n");
    const result = await run(["ABC-127", REPO, "--json"]);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(fs.readFileSync(path.join(first.path, "node_modules", "package", "index.js"), "utf8"), "module.exports = 1;\n");
  });

  it("prints just the path without --json", async () => {
    const r = await run(["ABC-102", REPO]);
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, `${path.join(ctx.workspaceRoot, "ABC-102")}\n`);
  });

  it("--base picks another branch of the base", async () => {
    const out = copyOf(await run(["ABC-103", REPO, "--base", "release", "--json"]));
    assert.equal(out.base, "origin/release");
    assert.equal(out.branch, "bot/ABC-103");
    const out2 = await run(["ABC-104", REPO, "--base", "nope", "--json"]);
    assert.equal(out2.exitCode, 2);
    assert.match(copyOf(out2).error, /origin\/nope/);
  });

  it("reattaches an existing bot/<KEY> branch instead of resetting it", async () => {
    const first = copyOf(await run(["ABC-105", REPO, "--json"]));
    fs.writeFileSync(path.join(first.path, "x.txt"), "x\n");
    git(first.path, "add", ".");
    git(first.path, "commit", "-q", "-m", "wip");
    const head = git(first.path, "rev-parse", "HEAD");
    // the directory is removed by hand (the bot's rm -rf) and the registry still lists it
    fs.rmSync(first.path, { recursive: true, force: true });
    const again = copyOf(await run(["ABC-105", REPO, "--json"]));
    assert.equal(again.reused, false);
    assert.equal(git(again.path, "rev-parse", "HEAD"), head);
  });

  it("adopts a clean legacy clone with its real origin and is idempotent", async () => {
    const dir = path.join(ctx.workspaceRoot, "ABC-119");
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    git(tmp, "clone", "-q", originDir, dir);
    git(dir, "remote", "set-url", "origin", `https://github.com/${REPO}.git`);
    const first = await run(["ABC-119", REPO, "--json"]);
    assert.equal(first.exitCode, 0, first.stderr);
    const out = copyOf(first);
    assert.equal(out.repo, REPO);
    assert.equal(out.branch, "bot/ABC-119");
    assert.equal(out.reused, false);
    assert.ok(out.recoveryPath.endsWith(".legacy-ABC-119"));
    assert.equal(git(out.path, "rev-parse", "--abbrev-ref", "HEAD"), "bot/ABC-119");
    assert.equal(fs.readFileSync(path.join(out.path, "README.md"), "utf8"), "# widgets\n");
    const again = copyOf(await run(["ABC-119", REPO, "--json"]));
    assert.equal(again.path, out.path);
    assert.equal(again.reused, true);
  });

  it("preserves staged, untracked, and local commits before legacy clone conversion", async () => {
    const dir = path.join(ctx.workspaceRoot, "ABC-120");
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    git(tmp, "clone", "-q", originDir, dir);
    git(dir, "remote", "set-url", "origin", `https://github.com/${REPO}.git`);
    fs.writeFileSync(path.join(dir, "staged.txt"), "staged\n");
    git(dir, "add", "staged.txt");
    fs.writeFileSync(path.join(dir, "commit.txt"), "local commit\n");
    git(dir, "add", "commit.txt");
    git(dir, "commit", "-q", "-m", "local-only");
    const localHead = git(dir, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(dir, "staged.txt"), "unstaged after staged\n");
    fs.writeFileSync(path.join(dir, "untracked.txt"), "untracked\n");
    const first = await run(["ABC-120", REPO, "--json"]);
    assert.equal(first.exitCode, 0, first.stderr);
    const out = copyOf(first);
    const old = out.recoveryPath;
    assert.ok(fs.existsSync(old));
    assert.equal(git(old, "rev-parse", "HEAD"), localHead);
    assert.equal(git(old, "rev-parse", "refs/myr-ws/recovery/ABC-120"), localHead);
    assert.equal(fs.readFileSync(path.join(out.path, "README.md"), "utf8"), "# widgets\n");
    assert.match(git(old, "stash", "list", "--format=%s"), /myr-ws recovery ABC-120/);
    assert.equal(git(path.join(ctx.home, "git-base", `${REPO}.git`), "rev-parse", "refs/heads/myr-ws/recovery/ABC-120"), localHead);
    const again = copyOf(await run(["ABC-120", REPO, "--json"]));
    assert.equal(again.reused, true);
    assert.equal(again.path, out.path);
  });

  it("refuses legacy clones whose remote only mentions github.com in a spoofed host or path", async () => {
    for (const [key, remote] of [
      ["ABC-122", "https://evil.example/github.com/acme/widgets.git"],
      ["ABC-123", "https://evil.example/acme/widgets.git"],
      ["ABC-124", "git@evil.example:acme/widgets.git"],
    ]) {
      const dir = path.join(ctx.workspaceRoot, key);
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      git(tmp, "clone", "-q", originDir, dir);
      git(dir, "remote", "set-url", "origin", remote);
      const result = await run([key, REPO, "--json"]);
      assert.equal(result.exitCode, 2, remote);
      assert.ok(fs.existsSync(path.join(dir, ".git")), remote);
      assert.ok(!fs.existsSync(path.join(ctx.home, "ws-registry.json")), remote);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still adopts an unregistered linked worktree after the registry is lost", async () => {
    const first = copyOf(await run(["ABC-125", REPO, "--json"]));
    fs.rmSync(path.join(ctx.home, "ws-registry.json"), { force: true });
    const again = await run(["ABC-125", REPO, "--json"]);
    assert.equal(again.exitCode, 0, again.stderr);
    const out = copyOf(again);
    assert.equal(out.path, first.path);
    assert.equal(out.reused, true);
    assert.ok(fs.existsSync(path.join(ctx.home, "ws-registry.json")));
  });

  it("refuses to adopt a legacy clone when the requested repo differs", async () => {
    const dir = path.join(ctx.workspaceRoot, "ABC-121");
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    git(tmp, "clone", "-q", originDir, dir);
    git(dir, "remote", "set-url", "origin", "https://github.com/other/widgets.git");
    const result = await run(["ABC-121", REPO, "--json"]);
    assert.equal(result.exitCode, 2);
    assert.ok(fs.existsSync(path.join(dir, ".git")));
    assert.ok(!fs.existsSync(path.join(ctx.home, "ws-registry.json")));
  });

  it("does not adopt a non-git legacy directory", async () => {
    const dir = path.join(ctx.workspaceRoot, "ABC-122");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "keep.txt"), "keep\n");
    const result = await run(["ABC-122", REPO, "--json"]);
    assert.equal(result.exitCode, 2);
    assert.equal(fs.readFileSync(path.join(dir, "keep.txt"), "utf8"), "keep\n");
  });

  it("without a repository and without an existing copy: code 2", async () => {
    const r = await run(["ABC-106", "--json"]);
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /owner\/repo/);
  });

  it("refuses a repository that is not owner/name", async () => {
    for (const bad of ["acme/../x", "../widgets", "acme/widgets/extra", "a b/c"]) {
      const r = await run(["ABC-107", bad]);
      assert.equal(r.exitCode, 2, bad);
    }
    assert.equal(ctx.calls.length, 0);
  });
});

describe("myr-ws open — bare base with extensions.worktreeConfig (OPE-14584)", { skip: !hasGit }, () => {
  // Live (myrmidon-omp-runner-eng10, git 2.34.1): a class-D base with
  // core.bare=true and extensions.worktreeConfig=true hands every linked
  // worktree the base's bareness — `git worktree add` never writes the admin
  // dir's config.worktree. The copy still answers rev-parse but is not a work
  // tree: finishCopy dies on `read-tree -m -u HEAD`
  // ("fatal: this operation must be run in a work tree"), leaving a
  // half-created copy that contains only its .git file (OPE-14584, OPE-12971).
  const BREPO = "acme/barewidgets";
  let bareOrigin;

  before(() => {
    if (!hasGit) return;
    const seed = path.join(tmp, "seed-barewidgets");
    fs.mkdirSync(path.join(seed, "packages/db/src/migrations/meta"), { recursive: true });
    git(seed, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(seed, "README.md"), "# barewidgets\n");
    fs.writeFileSync(
      path.join(seed, "packages/db/src/migrations/meta/_journal.json"),
      JSON.stringify({
        version: "7",
        dialect: "postgresql",
        entries: [
          { idx: 0, version: "7", when: 1, tag: "0000_init", breakpoints: true },
          { idx: 1, version: "7", when: 2, tag: "0001_later", breakpoints: true },
        ],
      }),
    );
    fs.writeFileSync(path.join(seed, "packages/db/src/migrations/meta/0000_snapshot.json"), "{}\n");
    fs.writeFileSync(path.join(seed, "packages/db/src/migrations/meta/0001_snapshot.json"), "{}\n");
    git(seed, "add", ".");
    git(seed, "commit", "-q", "-m", "init");
    bareOrigin = path.join(tmp, "origin-barewidgets.git");
    git(tmp, "clone", "-q", "--bare", seed, bareOrigin);
    git(bareOrigin, "config", "extensions.worktreeConfig", "true");
  });

  // Fake of lib/base.js ensureBase: a bare base carrying extensions.worktreeConfig=true,
  // exactly like the live class-D base of OPE-14584.
  function bareEnsureBase(repo) {
    const base = path.join(ctx.home, "git-base", `${repo}.git`);
    if (!fs.existsSync(base)) {
      fs.mkdirSync(base, { recursive: true });
      git(base, "init", "-q", "--bare");
      git(base, "remote", "add", "origin", `file://${bareOrigin}`);
      git(base, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
      git(base, "fetch", "-q", "origin");
      git(base, "config", "extensions.worktreeConfig", "true");
      git(base, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    }
    return base;
  }
  const openArgs = { ensureBase: bareEnsureBase };
  const baseOf = () => path.join(ctx.home, "git-base", `${BREPO}.git`);
  const adminDirOf = (copy) => fs.realpathSync(git(copy, "rev-parse", "--absolute-git-dir"));

  // The corpse a failed open leaves on such a base: `worktree add --no-checkout`
  // succeeded, finishCopy never ran (the copy is not a work tree).
  const halfCreatedCopy = (key) => {
    const dir = path.join(ctx.workspaceRoot, key);
    fs.mkdirSync(ctx.workspaceRoot, { recursive: true });
    git(baseOf(), "worktree", "add", "--no-checkout", "-b", `bot/${key}`, dir, "refs/remotes/origin/main");
    return dir;
  };
  const registerCopy = (key, dir) => {
    const regPath = path.join(ctx.home, "ws-registry.json");
    const reg = fs.existsSync(regPath) ? JSON.parse(fs.readFileSync(regPath, "utf8")) : { version: 1, entries: [] };
    reg.entries.push({ key, repo: BREPO, path: dir, class: "E", branch: `bot/${key}`, openedAt: "2026-11-18T00:00:00Z" });
    fs.writeFileSync(regPath, JSON.stringify(reg, null, 2));
  };

  it("creates a usable task copy: config.worktree gets core.bare=false, the base stays bare", async () => {
    const r = await run(["BWC-101", BREPO, "--json"], openArgs);
    assert.equal(r.exitCode, 0, r.stderr);
    const out = checkOpenSchema(copyOf(r));
    assert.equal(out.branch, "bot/BWC-101");
    assert.equal(out.reused, false);
    // the copy is a real work tree now
    assert.equal(git(out.path, "rev-parse", "--is-bare-repository"), "false");
    assert.equal(git(out.path, "status", "--porcelain"), "");
    assert.equal(fs.readFileSync(path.join(out.path, "README.md"), "utf8"), "# barewidgets\n");
    // the sparse task checkout ran: the journal and the latest snapshot only
    assert.deepEqual(
      fs.readdirSync(path.join(out.path, "packages/db/src/migrations/meta")).sort(),
      ["0001_snapshot.json", "_journal.json"],
    );
    // the fix lives in the admin dir's config.worktree, not in the common config
    assert.match(fs.readFileSync(path.join(adminDirOf(out.path), "config.worktree"), "utf8"), /bare\s*=\s*false/);
    assert.equal(git(baseOf(), "rev-parse", "--is-bare-repository"), "true");
    assert.equal(git(baseOf(), "config", "core.bare"), "true");
    assert.ok(!fs.existsSync(path.join(baseOf(), "config.worktree")), "the common config must not gain a worktree file");
  });

  it("heals a registered half-created copy on reuse: no deletion, no reset, HEAD and branch kept", async () => {
    bareEnsureBase(BREPO);
    const dir = halfCreatedCopy("BWC-102");
    const head = git(dir, "rev-parse", "HEAD");
    registerCopy("BWC-102", dir);
    const r = await run(["BWC-102", BREPO, "--json"], openArgs);
    assert.equal(r.exitCode, 0, r.stderr);
    const out = copyOf(r);
    assert.equal(out.reused, true);
    assert.match(r.stderr, /bare_worktree -> worktree_config_fixed/);
    assert.equal(git(out.path, "rev-parse", "HEAD"), head, "HEAD is not moved");
    assert.equal(git(out.path, "rev-parse", "--abbrev-ref", "HEAD"), "bot/BWC-102");
    assert.equal(git(out.path, "rev-parse", "--is-bare-repository"), "false");
    assert.equal(git(out.path, "status", "--porcelain"), "");
    assert.equal(fs.readFileSync(path.join(out.path, "README.md"), "utf8"), "# barewidgets\n");
    assert.deepEqual(
      fs.readdirSync(path.join(out.path, "packages/db/src/migrations/meta")).sort(),
      ["0001_snapshot.json", "_journal.json"],
    );
    assert.equal(git(baseOf(), "config", "core.bare"), "true", "the base stays bare");
  });

  it("adopts and heals an unregistered half-created copy", async () => {
    bareEnsureBase(BREPO);
    const dir = halfCreatedCopy("BWC-103");
    const head = git(dir, "rev-parse", "HEAD");
    const r = await run(["BWC-103", BREPO, "--json"], openArgs);
    assert.equal(r.exitCode, 0, r.stderr);
    const out = copyOf(r);
    assert.equal(out.reused, true);
    assert.equal(out.path, dir);
    assert.equal(out.branch, "bot/BWC-103");
    assert.equal(git(out.path, "rev-parse", "HEAD"), head);
    assert.equal(fs.readFileSync(path.join(out.path, "README.md"), "utf8"), "# barewidgets\n");
    const reg = JSON.parse(fs.readFileSync(path.join(ctx.home, "ws-registry.json"), "utf8"));
    assert.equal(reg.entries.length, 1);
    assert.equal(git(baseOf(), "config", "core.bare"), "true");
  });

  it("a scratch worktree of such a base is a usable work tree", async () => {
    const out = copyOf(await run(["--scratch", "bare-probe", BREPO, "--json"], openArgs));
    assert.equal(git(out.path, "rev-parse", "--is-bare-repository"), "false");
    assert.equal(git(out.path, "status", "--porcelain"), "");
    assert.equal(fs.readFileSync(path.join(out.path, "README.md"), "utf8"), "# barewidgets\n");
    assert.equal(git(baseOf(), "config", "core.bare"), "true");
  });

  it("a review copy of such a base stays file-less but usable", async () => {
    const r = await run(["BWC-104", BREPO, "--review", "--branch", "no-such-branch", "--json"], openArgs);
    assert.equal(r.exitCode, 0, r.stderr);
    const out = copyOf(r);
    assert.deepEqual(fs.readdirSync(out.path), [".git"]);
    assert.equal(git(out.path, "status", "--porcelain"), "");
    assert.equal(git(out.path, "rev-parse", "--is-bare-repository"), "false");
    assert.equal(git(out.path, "show", "HEAD:README.md"), "# barewidgets");
    assert.equal(git(baseOf(), "config", "core.bare"), "true");
  });
});

describe("myr-ws open — invalid keys", { skip: !hasGit }, () => {
  for (const key of ["../ABC-1", "ABC-1/x", "a/b", "..", "ABC-1/..", "abc-1", "ABC", "/etc", "ABC-1;rm", "-ABC-1"]) {
    it(`rejects ${JSON.stringify(key)} with code 2 and creates nothing`, async () => {
      const r = await run([key, REPO, "--json"]);
      assert.equal(r.exitCode, 2, r.stderr);
      const err = JSON.parse(r.stdout);
      assert.equal(err.ok, false);
      assert.equal(err.exitCode, 2);
      if (schemas) schemas.myrWsErrorResultSchema.parse(err);
      assert.ok(!fs.existsSync(ctx.workspaceRoot));
      assert.equal(ctx.calls.length, 0);
    });
  }

  it("rejects scratch names with '/' or '..'", async () => {
    for (const name of ["a/b", "..", "../x", ".hidden/..", "x y"]) {
      const r = await run(["--scratch", name]);
      assert.equal(r.exitCode, 2, name);
    }
    assert.ok(!fs.existsSync(ctx.scratchRoot));
  });

  it("rejects unknown options", async () => {
    assert.equal((await run(["ABC-1", REPO, "--wat"])).exitCode, 2);
  });
});

describe("myr-ws open — physical volume budget", { skip: !hasGit }, () => {
  it("refuses a new copy at 4.9% free and permits it after recovery to 5%", async () => {
    let free = 49;
    const statfs = () => ({ blocks: 1000, bavail: free });
    const refused = await run(["ABC-901", REPO, "--json"], { statfs });
    assert.equal(refused.exitCode, 3);
    assert.match(copyOf(refused).error, /^BOT_DISK_QUOTA_EXCEEDED:.*disk_budget/);
    assert.equal(ctx.calls.length, 0);
    assert.equal(fs.existsSync(path.join(ctx.workspaceRoot, "ABC-901")), false);

    free = 50;
    const recovered = await run(["ABC-901", REPO, "--json"], { statfs });
    assert.equal(recovered.exitCode, 0, recovered.stderr);
    assert.equal(copyOf(recovered).reused, false);
  });

  it("reuses an existing copy even when the volume falls below the threshold", async () => {
    const opened = await run(["ABC-902", REPO, "--json"], { statfs: () => ({ blocks: 1000, bavail: 50 }) });
    assert.equal(opened.exitCode, 0, opened.stderr);
    const reused = await run(["ABC-902", REPO, "--json"], { statfs: () => ({ blocks: 1000, bavail: 49 }) });
    assert.equal(reused.exitCode, 0, reused.stderr);
    assert.equal(copyOf(reused).reused, true);
  });

  it("warns and preserves existing admission when the filesystem measurement fails", async () => {
    const warnings = [];
    const result = await run(["ABC-903", REPO, "--json"], {
      statfs: () => { throw new Error("statfs unavailable"); },
      warn: (message) => warnings.push(message),
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(warnings.join("\n"), /physical disk budget measurement failed: statfs unavailable/);
  });
});

describe("myr-ws open — disk pressure", { skip: !hasGit }, () => {
  const writeState = (pressure, ageSec = 0) =>
    fs.writeFileSync(
      path.join(ctx.home, "disk-state.json"),
      JSON.stringify({
        version: 1,
        quotaPercent: 100,
        partitionPercent: 91.5,
        pressure,
        updatedAt: new Date(Date.now() - ageSec * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
      }),
    );

  it("pressure=hard: code 3, BOT_DISK_QUOTA_EXCEEDED: on stderr, nothing created", async () => {
    writeState("hard");
    const r = await run(["ABC-201", REPO, "--json"]);
    assert.equal(r.exitCode, 3);
    assert.ok(r.stderr.includes("BOT_DISK_QUOTA_EXCEEDED:"), r.stderr);
    const err = JSON.parse(r.stdout);
    assert.ok(err.error.startsWith("BOT_DISK_QUOTA_EXCEEDED:"));
    assert.equal(err.exitCode, 3);
    if (schemas) schemas.myrWsErrorResultSchema.parse(err);
    assert.ok(!fs.existsSync(path.join(ctx.workspaceRoot, "ABC-201")));
    assert.equal(ctx.calls.length, 0, "no base is fetched under hard pressure");
  });

  it("the refusal names the five largest copies from the registry", async () => {
    const entries = [];
    for (let i = 1; i <= 7; i++) {
      const p = path.join(ctx.workspaceRoot, `OLD-${i}`);
      fs.mkdirSync(p, { recursive: true });
      entries.push({ key: `OLD-${i}`, repo: REPO, path: p, class: "E", branch: `bot/OLD-${i}`, openedAt: "2026-10-01T10:00:00Z" });
    }
    fs.writeFileSync(path.join(ctx.home, "ws-registry.json"), JSON.stringify({ version: 1, entries }));
    writeState("hard");
    const sizes = { 1: 10, 2: 700, 3: 30, 4: 9000, 5: 50, 6: 6, 7: 80 };
    const r = await run(["ABC-202", REPO], { sizeOf: (p) => sizes[p.split("-").pop()] });
    assert.equal(r.exitCode, 3);
    const listed = [...r.stderr.matchAll(/OLD-(\d)/g)].map((m) => Number(m[1]));
    assert.deepEqual([...new Set(listed)], [4, 2, 7, 5, 3]);
    assert.ok(!/OLD-1|OLD-6/.test(r.stderr));
    assert.match(r.stderr, /myr-ws close/);
  });

  it("applies to scratch as well", async () => {
    writeState("hard");
    assert.equal((await run(["--scratch", "probe"])).exitCode, 3);
  });

  it("reusing an existing copy is not refused: it consumes nothing", async () => {
    const first = copyOf(await run(["ABC-203", REPO, "--json"]));
    writeState("hard");
    const r = await run(["ABC-203", REPO, "--json"]);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(copyOf(r).path, first.path);
  });

  it("soft pressure, none, a stale file and a broken file do not refuse", async () => {
    writeState("soft");
    assert.equal((await run(["ABC-204", REPO])).exitCode, 0);
    writeState("none");
    assert.equal((await run(["ABC-205", REPO])).exitCode, 0);
    writeState("hard", 3600); // botd is silent: older than two ticks means none
    assert.equal((await run(["ABC-206", REPO])).exitCode, 0);
    fs.writeFileSync(path.join(ctx.home, "disk-state.json"), "{not json");
    assert.equal((await run(["ABC-207", REPO])).exitCode, 0);
  });

  it("the disk-state fixture is readable by readDiskState", { skip: !schemas }, () => {
    const fx = JSON.parse(fs.readFileSync(path.join(FIXTURES, "disk-state.json"), "utf8"));
    schemas.wsDiskStateSchema.parse(fx);
    fs.writeFileSync(path.join(ctx.home, "disk-state.json"), JSON.stringify({ ...fx, pressure: "hard" }));
    const state = ws.readDiskState({ home: ctx.home, now: () => Date.parse(fx.updatedAt) + 30000, diskStateStaleSec: 120 });
    assert.equal(state.pressure, "hard");
  });
});

describe("myr-ws open — scratch", { skip: !hasGit }, () => {
  it("without a repository: an empty directory in /scratch, class G", async () => {
    const r = await run(["--scratch", "probe-reflink", "--json"]);
    assert.equal(r.exitCode, 0, r.stderr);
    const out = copyOf(r);
    assert.equal(out.path, path.join(ctx.scratchRoot, "probe-reflink"));
    assert.equal(out.class, "G");
    assert.equal(out.reused, false);
    assert.deepEqual(fs.readdirSync(out.path), []);
    assert.equal(ctx.calls.length, 0);
    const reg = JSON.parse(fs.readFileSync(path.join(ctx.home, "ws-registry.json"), "utf8"));
    assert.equal(reg.entries[0].class, "G");
    assert.equal(reg.entries[0].branch, undefined);
    if (schemas) schemas.wsRegistrySchema.parse(reg);
    const again = copyOf(await run(["--scratch", "probe-reflink", "--json"]));
    assert.equal(again.reused, true);
  });

  it("with a repository: a detached worktree of the base, no branch", async () => {
    const out = copyOf(await run(["--scratch", "try-it", REPO, "--json"]));
    assert.equal(out.class, "G");
    assert.equal(out.branch, undefined);
    assert.equal(out.base, "origin/main");
    assert.ok(fs.statSync(path.join(out.path, ".git")).isFile());
    assert.equal(git(out.path, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD");
  });

  it("accepts --scratch=<name> and `--scratch <name>` in front of the repository", async () => {
    assert.equal(copyOf(await run(["--scratch=a1", "--json"])).path, path.join(ctx.scratchRoot, "a1"));
    assert.equal(copyOf(await run(["open-x", "--scratch", REPO, "--json"])).path, path.join(ctx.scratchRoot, "open-x"));
  });
});

describe("myr-ws open — errors from ensureBase pass through with their code", { skip: !hasGit }, () => {
  it("base limit (4) and network (5)", async () => {
    for (const code of [4, 5]) {
      const r = await run(["ABC-301", REPO, "--json"], {
        ensureBase() {
          throw new ws.MyrWsError(code, `base failure ${code}`);
        },
      });
      assert.equal(r.exitCode, code);
      assert.equal(JSON.parse(r.stdout).exitCode, code);
      assert.ok(!fs.existsSync(path.join(ctx.workspaceRoot, "ABC-301")));
    }
  });
});

describe("myr-ws open — two repositories for one task (OPE-8946)", { skip: !hasGit }, () => {
  const OTHER = "acme/vault";

  it("opens a second copy next to the first instead of failing", async () => {
    const first = copyOf(await run(["ABC-401", REPO, "--json"]));
    const r = await run(["ABC-401", OTHER, "--json"]);
    assert.equal(r.exitCode, 0, r.stderr);
    const second = checkOpenSchema(copyOf(r));
    assert.equal(first.path, path.join(ctx.workspaceRoot, "ABC-401"));
    assert.equal(second.path, path.join(ctx.workspaceRoot, "ABC-401.vault"));
    assert.equal(second.repo, OTHER);
    assert.equal(second.branch, "bot/ABC-401");
    assert.equal(second.reused, false);
    assert.ok(fs.statSync(path.join(second.path, ".git")).isFile());
    assert.ok(fs.existsSync(first.path), "the first copy stays");
    const reg = JSON.parse(fs.readFileSync(path.join(ctx.home, "ws-registry.json"), "utf8"));
    assert.deepEqual(
      reg.entries.filter((e) => e.key === "ABC-401").map((e) => [e.repo, e.path]),
      [[REPO, first.path], [OTHER, second.path]],
    );
  });

  it("is idempotent per repository", async () => {
    const first = copyOf(await run(["ABC-402", REPO, "--json"]));
    const second = copyOf(await run(["ABC-402", OTHER, "--json"]));
    const again1 = copyOf(await run(["ABC-402", REPO, "--json"]));
    const again2 = copyOf(await run(["ABC-402", OTHER, "--json"]));
    assert.equal(again1.path, first.path);
    assert.equal(again1.reused, true);
    assert.equal(again2.path, second.path);
    assert.equal(again2.reused, true);
  });

  it("the order does not matter: the second repository opened first keeps the primary path", async () => {
    const a = copyOf(await run(["ABC-403", OTHER, "--json"]));
    const b = copyOf(await run(["ABC-403", REPO, "--json"]));
    assert.equal(a.path, path.join(ctx.workspaceRoot, "ABC-403"));
    assert.equal(b.path, path.join(ctx.workspaceRoot, "ABC-403.widgets"));
  });

  it("without a repository the first copy is returned", async () => {
    const first = copyOf(await run(["ABC-404", REPO, "--json"]));
    await run(["ABC-404", OTHER, "--json"]);
    const r = copyOf(await run(["ABC-404", "--json"]));
    assert.equal(r.path, first.path);
    assert.equal(r.reused, true);
  });

  it("a stale registry entry of another repository does not push the new copy aside", async () => {
    const first = copyOf(await run(["ABC-405", REPO, "--json"]));
    fs.rmSync(first.path, { recursive: true, force: true });
    const second = copyOf(await run(["ABC-405", OTHER, "--json"]));
    assert.equal(second.path, first.path);
    assert.equal(second.repo, OTHER);
  });

  describe("--review (OPE-13111)", () => {
    // The fake base points at github.com after its first fetch; a review open fetches, so aim it at the local origin.
    function base() {
      const b = ctx.ensureBase(REPO);
      git(b, "config", "remote.origin.url", `file://${originDir}`);
      return b;
    }
    // Pushes branch <name> with file change.txt = <text> to the local origin.
    function pushBranch(name, text) {
      const seed = path.join(tmp, `seed-${name.replace(/\W/g, "-")}-${++n}`);
      git(tmp, "clone", "-q", originDir, seed);
      const exists = spawnSync(GIT, ["rev-parse", "--verify", "--quiet", `origin/${name}`], { cwd: seed }).status === 0;
      git(seed, "checkout", "-q", "-B", name, exists ? `origin/${name}` : "origin/main");
      fs.writeFileSync(path.join(seed, "change.txt"), text);
      git(seed, "add", ".");
      git(seed, "commit", "-q", "-m", `change ${text}`);
      git(seed, "push", "-q", "origin", name);
    }
    // A hook of the base and a pnpm stub on PATH, each writing its own marker.
    function markers(name) {
      const b = base();
      const marker = path.join(tmp, `${name}-hook-marker`);
      const pnpmMarker = path.join(tmp, `${name}-pnpm-marker`);
      fs.mkdirSync(path.join(b, "hooks"), { recursive: true });
      fs.writeFileSync(path.join(b, "hooks", "post-checkout"), `#!/bin/sh\necho ran > "${marker}"\n`, { mode: 0o755 });
      const bin = path.join(tmp, `${name}-bin`);
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(path.join(bin, "pnpm"), `#!/bin/sh\necho "$@" > "${pnpmMarker}"\n`, { mode: 0o755 });
      return { marker, pnpmMarker, env: { ...ctx.env, PATH: `${bin}:${ctx.env.PATH}` } };
    }

    it("has no working files, no pnpm call, no hooks; refs diff and git show work", async () => {
      const t = markers("review");
      pushBranch("bot/ABC-501", "pr\n");
      const r = copyOf(await run(["ABC-501", REPO, "--review", "--json"], { env: t.env }));
      assert.equal(r.branch, "bot/ABC-501");
      assert.deepEqual(fs.readdirSync(r.path), [".git"]);
      assert.equal(git(r.path, "rev-parse", "--abbrev-ref", "HEAD"), "bot/ABC-501");
      assert.equal(git(r.path, "status", "--porcelain"), "", "a review copy must not look dirty (myr-ws close, recover)");
      assert.match(git(r.path, "diff", "--stat", "origin/main...HEAD"), /change\.txt/);
      assert.equal(git(r.path, "show", "HEAD:change.txt"), "pr");
      assert.equal(git(r.path, "show", "HEAD:README.md"), "# widgets");
      assert.equal(fs.existsSync(t.pnpmMarker), false);
      assert.equal(fs.existsSync(t.marker), false, "post-checkout hook must not run in review mode");
    });

    it("refreshes a stale local branch from the remote", async () => {
      base();
      pushBranch("bot/ABC-502", "v1\n");
      const first = copyOf(await run(["ABC-502", REPO, "--review", "--json"]));
      fs.rmSync(first.path, { recursive: true, force: true });
      git(ctx.ensureBase(REPO), "worktree", "prune");
      pushBranch("bot/ABC-502", "v2\n"); // the pushed branch moves on: local branch is now behind
      const second = copyOf(await run(["ABC-502", REPO, "--review", "--json"]));
      assert.equal(git(second.path, "show", "HEAD:change.txt"), "v2");
    });

    it("fails with a clear message when the PR branch is not on the remote", async () => {
      base();
      const r = await run(["ABC-503", REPO, "--review", "--json"]);
      assert.equal(r.exitCode, 6);
      assert.match(JSON.parse(r.stdout).error, /--branch/);
      assert.equal(fs.existsSync(path.join(ctx.workspaceRoot, "ABC-503")), false);
    });

    it("--branch names the PR branch of the review copy", async () => {
      base();
      pushBranch("feature/x", "fx\n");
      const r = copyOf(await run(["ABC-504", REPO, "--review", "--branch", "feature/x", "--json"]));
      assert.equal(r.branch, "feature/x");
      assert.equal(git(r.path, "show", "HEAD:change.txt"), "fx");
    });

    it("warns when the copy is already open and --review is asked", async () => {
      base();
      pushBranch("bot/ABC-505", "x\n");
      await run(["ABC-505", REPO, "--review", "--json"]);
      const warnings = [];
      const r = copyOf(await run(["ABC-505", REPO, "--review", "--json"], { warn: (m) => warnings.push(m) }));
      assert.equal(r.reused, true);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /already open/);
    });

    it("the plain open is unchanged: working files, hooks run, no install by myr-ws", async () => {
      const t = markers("plain");
      const r = copyOf(await run(["ABC-506", REPO, "--json"], { env: t.env }));
      assert.equal(r.branch, "bot/ABC-506");
      assert.equal(fs.existsSync(path.join(r.path, "README.md")), true);
      assert.equal(fs.existsSync(t.marker), true, "post-checkout hook runs in the plain open");
      assert.equal(fs.existsSync(t.pnpmMarker), false);
    });

    it("rejects --review with --scratch", async () => {
      const r = await run(["rv", "--scratch", "--review"]);
      assert.equal(r.exitCode, 2);
    });
  });
});
