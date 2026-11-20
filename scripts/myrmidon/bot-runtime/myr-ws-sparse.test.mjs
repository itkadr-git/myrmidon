import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// myrmidon(1.6.9, OPE-13410 item 5): a new task copy checks out only _journal.json and the
// latest snapshot of packages/db/src/migrations/meta; everything else is checked out in full.
// Fake base as in myr-ws-open.test.mjs: a bare repository fetched from a local "origin".

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(import.meta.url);
const ws = require(path.join(ROOT, "docker/bot-runtime/myr-ws/lib/open.js"));
const sparse = require(path.join(ROOT, "docker/bot-runtime/myr-ws/lib/sparse.js"));

const GIT = process.env.GIT_TEST_EXECUTABLE || "git";
const hasGit = spawnSync(GIT, ["--version"]).status === 0;
const META = "packages/db/src/migrations/meta";
const SNAPSHOTS = 5; // 0000..0004, journal names idx 4 as the last

let tmp;
let plainOrigin;
let dbOrigin;
let n = 0;
let ctx;

function env() {
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
  return spawnSync(GIT, args, { cwd, encoding: "utf8", env: env() });
}
function git(cwd, ...args) {
  const r = gitRaw(cwd, ...args);
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const snap = (i) => `${String(i).padStart(4, "0")}_snapshot.json`;
const journalText = (last) =>
  JSON.stringify({ version: "7", dialect: "postgresql", entries: Array.from({ length: last + 1 }, (_, i) => ({ idx: i, version: "7", tag: `${String(i).padStart(4, "0")}_m${i}` })) }, null, 2);

function makeOrigin(name, withMeta) {
  const seed = path.join(tmp, `seed-${name}`);
  fs.mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  write(path.join(seed, "README.md"), "# widgets\n");
  write(path.join(seed, "server/src/index.ts"), "export {};\n");
  write(path.join(seed, "packages/db/src/schema.ts"), "export {};\n");
  write(path.join(seed, "packages/db/src/migrations/0000_m0.sql"), "select 1;\n");
  if (withMeta) {
    for (let i = 0; i < SNAPSHOTS; i += 1) write(path.join(seed, META, snap(i)), JSON.stringify({ id: `id-${i}`, prevId: `id-${i - 1}`, pad: "x".repeat(2000) }));
    write(path.join(seed, META, "_journal.json"), journalText(SNAPSHOTS - 1));
    // A stray file with a higher number than the journal: the journal decides, not the file names.
    write(path.join(seed, META, snap(SNAPSHOTS + 3)), "{}");
  }
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "init");
  const bare = path.join(tmp, `origin-${name}.git`);
  git(tmp, "clone", "-q", "--bare", seed, bare);
  return bare;
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "myr-ws-sparse-test-"));
  if (!hasGit) return;
  dbOrigin = makeOrigin("db", true);
  plainOrigin = makeOrigin("plain", false);
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  const root = path.join(tmp, `case-${++n}`);
  const home = path.join(root, "myrmidon");
  fs.mkdirSync(home, { recursive: true });
  ctx = {
    env: { ...process.env, MYRMIDON_GIT_REAL: GIT, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "t", GIT_CONFIG_KEY_1: "user.email", GIT_CONFIG_VALUE_1: "t@example.com" },
    root,
    home,
    workspaceRoot: path.join(root, "workspace"),
    scratchRoot: path.join(root, "scratch"),
    ensureBase(repo) {
      const base = path.join(home, "git-base", `${repo}.git`);
      if (!fs.existsSync(base)) {
        fs.mkdirSync(base, { recursive: true });
        git(base, "init", "-q", "--bare");
        git(base, "remote", "add", "origin", `file://${repo.startsWith("acme/plain") ? plainOrigin : dbOrigin}`);
        git(base, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
        git(base, "fetch", "-q", "origin");
      }
      git(base, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
      return base;
    },
  };
});

const opened = async (argv) => {
  const r = await ws.runOpen([...argv, "--json"], ctx);
  assert.equal(r.exitCode, 0, r.stderr || r.stdout);
  return JSON.parse(r.stdout);
};
const metaFiles = (dir) => fs.readdirSync(path.join(dir, META)).sort();

describe("myr-ws sparse task copy", { skip: !hasGit }, () => {
  it("latestSnapshotFromJournal takes the highest idx, not a file name", () => {
    assert.equal(sparse.latestSnapshotFromJournal(journalText(4)), "0004_snapshot.json");
    assert.equal(sparse.latestSnapshotFromJournal(journalText(487)), "0487_snapshot.json");
    assert.equal(sparse.latestSnapshotFromJournal("not json"), null);
    assert.equal(sparse.latestSnapshotFromJournal('{"entries":[]}'), null);
  });

  it("checks out only the journal and the latest snapshot, the rest of the tree in full, status clean", async () => {
    const out = await opened(["ABC-1", "acme/widgets"]);
    assert.deepEqual(metaFiles(out.path), ["0004_snapshot.json", "_journal.json"]);
    for (const f of ["README.md", "server/src/index.ts", "packages/db/src/schema.ts", "packages/db/src/migrations/0000_m0.sql"]) {
      assert.ok(fs.existsSync(path.join(out.path, f)), f);
    }
    assert.equal(git(out.path, "status", "--porcelain", "--untracked-files=all"), "");
    assert.equal(git(out.path, "rev-parse", "--abbrev-ref", "HEAD"), "bot/ABC-1");
    // the setting is per worktree: the base and a scratch copy are not sparse
    const scratch = await opened(["--scratch", "s1", "acme/widgets"]);
    assert.equal(metaFiles(scratch.path).length, SNAPSHOTS + 2);
    assert.notEqual(gitRaw(ctx.home, "-C", path.join(ctx.home, "git-base/acme/widgets.git"), "config", "--local", "--get", "core.sparseCheckout").stdout.trim(), "true");
  });

  it("commits and pushes a file outside meta, and a new migration (snapshot + journal)", async () => {
    const out = await opened(["ABC-2", "acme/widgets"]);
    write(path.join(out.path, "server/src/feature.ts"), "export const a = 1;\n");
    git(out.path, "add", "server/src/feature.ts");
    git(out.path, "commit", "-q", "-m", "feature");
    // what drizzle-kit generate does: a new snapshot and a longer journal
    write(path.join(out.path, META, snap(SNAPSHOTS)), JSON.stringify({ id: "id-new", prevId: `id-${SNAPSHOTS - 1}` }));
    write(path.join(out.path, META, "_journal.json"), journalText(SNAPSHOTS));
    write(path.join(out.path, "packages/db/src/migrations/0005_new.sql"), "select 2;\n");
    // a plain `git add` refuses a path outside the sparse patterns and says so; --sparse is the way
    assert.notEqual(gitRaw(out.path, "add", "packages/db/src/migrations").status, 0);
    git(out.path, "add", "--sparse", "packages/db/src/migrations");
    git(out.path, "commit", "-q", "-m", "migration");
    assert.equal(git(out.path, "status", "--porcelain", "--untracked-files=all"), "");
    const files = git(out.path, "show", "--name-only", "--format=", "HEAD").split("\n").sort();
    assert.deepEqual(files, [`${META}/${snap(SNAPSHOTS)}`, `${META}/_journal.json`, "packages/db/src/migrations/0005_new.sql"].sort());
    git(out.path, "push", "-q", `file://${dbOrigin}`, "HEAD:refs/heads/bot/ABC-2");
    const pushed = git(dbOrigin, "ls-tree", "-r", "--name-only", "bot/ABC-2", "--", META).split("\n");
    assert.equal(pushed.length, SNAPSHOTS + 1 + 1 + 1); // old snapshots kept, stray file, new snapshot, journal
    assert.ok(pushed.includes(`${META}/${snap(0)}`));
  });

  it("git sparse-checkout disable brings the whole folder back", async () => {
    const out = await opened(["ABC-3", "acme/widgets"]);
    git(out.path, "sparse-checkout", "disable");
    assert.equal(metaFiles(out.path).length, SNAPSHOTS + 2);
    assert.equal(git(out.path, "status", "--porcelain"), "");
  });

  it("a repository without a drizzle journal gets a full checkout", async () => {
    const out = await opened(["ABC-4", "acme/plain"]);
    assert.ok(fs.existsSync(path.join(out.path, "README.md")));
    assert.ok(fs.existsSync(path.join(out.path, "packages/db/src/schema.ts")));
    assert.equal(git(out.path, "status", "--porcelain"), "");
  });

  it("a re-attached branch of an earlier copy is sparse too", async () => {
    const first = await opened(["ABC-5", "acme/widgets"]);
    git(first.path, "sparse-checkout", "disable");
    const r = await ws.runOpen(["close", "ABC-5"], ctx).catch(() => null);
    fs.rmSync(first.path, { recursive: true, force: true });
    git(path.join(ctx.home, "git-base/acme/widgets.git"), "worktree", "prune");
    fs.writeFileSync(path.join(ctx.home, "ws-registry.json"), JSON.stringify({ version: 1, entries: [] }));
    const again = await opened(["ABC-5", "acme/widgets"]);
    assert.deepEqual(metaFiles(again.path), ["0004_snapshot.json", "_journal.json"]);
    void r;
  });
});
