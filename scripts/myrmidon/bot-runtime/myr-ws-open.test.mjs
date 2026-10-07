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

const hasGit = spawnSync("git", ["--version"]).status === 0;

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
    env: { ...process.env, MYRMIDON_GIT_REAL: "git" },
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
      }
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
    assert.ok(path.resolve(out.path, common).startsWith(path.join(ctx.home, "git-base")));
    assert.equal(git(path.join(ctx.home, "git-base", `${REPO}.git`), "worktree", "list", "--porcelain").includes(out.path), true);
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
