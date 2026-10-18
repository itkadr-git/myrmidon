import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// myrmidon(1.6.5 BOT-DISK-H2e): docker/bot-runtime/myr-ws/lib/restore.js —
// the `restore` verb of myr-ws (acceptance: criterion 8 of the epic design —
// a fixture archive (bundle+patch+untracked) restores branch and diff
// byte-for-byte (git diff against the source state is empty), a repeated
// restore is idempotent, a broken bundle fails with exit code 6 and leaves
// every working copy untouched).
//
// The archive set is discovered by the contract C1 layout
// (`archive/<KEY>-<ts>.{bundle,patch,untracked.tar}`) — there is no
// manifest.json in the contract; the repo an archive belongs to comes from
// the open-copy registry ws-registry.json (C1/C4). The worktree is created
// through the `open` interface (lib/open.js, H2b); here `open` is the
// H2b-shaped fake below (same deps contract as myr-ws-open.test.mjs uses for
// ensureBase), so the test never touches the network.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(import.meta.url);
const ws = require(path.join(ROOT, "docker/bot-runtime/myr-ws/lib/restore.js"));
const FIXTURES = path.join(ROOT, "docs/myrmidon/bot-disk-contract");

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
const KEY = "ABC-101";
const BRANCH = `bot/${KEY}`;

let tmp;
let n = 0;
let ctx; // per-test: home, archiveRoot, workspaceRoot, open(fake), calls

function git(cwd, ...args) {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: tmp,
      GIT_CONFIG_NOSYSTEM: "1",
      // fork/thread-limited test host (vm-exec): keep pack/index single-threaded
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "pack.threads",
      GIT_CONFIG_VALUE_0: "1",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** The recorded state of a removed copy, ready to be archived. */
function buildSourceCopy(root) {
  const base = path.join(root, "base.git");
  const seed = path.join(root, "seed");
  fs.mkdirSync(seed, { recursive: true });
  git(seed, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(seed, "README.md"), "# widgets\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "init");
  // clone --bare forks far less than init+remote+fetch (host is fork-limited)
  git(root, "clone", "-q", "--bare", `file://${seed}`, base);
  git(base, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
  git(base, "fetch", "-q", "origin");

  const copy = path.join(root, "copy-src");
  git(base, "worktree", "add", "-q", "--detach", copy, "refs/remotes/origin/main");
  git(copy, "checkout", "-q", "-b", BRANCH);

  // the "unpushed work" the archive preserves
  git(copy, "commit", "-q", "--allow-empty", "-m", "wip on the branch");
  fs.writeFileSync(path.join(copy, "app.js"), "console.log('v2');\n");
  fs.writeFileSync(path.join(copy, "README.md"), "# widgets\n\nchanged in the worktree\n");
  fs.mkdirSync(path.join(copy, "scratchpad"));
  fs.writeFileSync(path.join(copy, "scratchpad", "notes.txt"), "untracked\n");

  return { base, copy };
}

/** Snapshot for byte-for-byte comparison: tracked diff + untracked payloads. */
function snapshot(copy) {
  const status = spawnSync("git", ["status", "--porcelain=v1"], { cwd: copy, encoding: "utf8" }).stdout;
  const tracked = spawnSync("git", ["diff", "HEAD"], { cwd: copy, encoding: "utf8" }).stdout;
  const untracked = {};
  for (const line of status.split("\n")) {
    const m = line.match(/^\?\? (.+)$/);
    if (!m) continue;
    const rel = m[1];
    const p = path.join(copy, rel);
    if (fs.statSync(p).isDirectory()) {
      for (const f of fs.readdirSync(p)) untracked[path.join(rel, f)] = fs.readFileSync(path.join(p, f));
    } else {
      untracked[rel] = fs.readFileSync(p);
    }
  }
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: copy, encoding: "utf8" }).stdout.trim();
  return { head, tracked, untracked };
}

/**
 * Archives the copy the way botd (H3) is contracted to (C1): bundle + patch +
 * untracked.tar named `<KEY>-<ts>.*` under <home>/archive, and the registry
 * keeps the key -> repo entry (C1/C4: the registry is where restore learns
 * the repository from).
 */
function archiveCopy(root, src, ts) {
  const home = path.join(root, "myrmidon");
  const archiveRoot = path.join(home, "archive");
  fs.mkdirSync(archiveRoot, { recursive: true });
  const stem = path.join(archiveRoot, `${KEY}-${ts}`);
  git(src.copy, "bundle", "create", `${stem}.bundle`, BRANCH);
  fs.writeFileSync(`${stem}.patch`, spawnSync("git", ["diff", "HEAD"], { cwd: src.copy, encoding: "utf8" }).stdout);
  const tar = spawnSync("tar", ["-cf", `${stem}.untracked.tar`, "app.js", "scratchpad"], { cwd: src.copy, encoding: "utf8" });
  assert.equal(tar.status, 0, tar.stderr);
  writeRegistry(home, [{ key: KEY, repo: REPO, path: path.join(root, "workspace", KEY), class: "E", branch: BRANCH, openedAt: "2026-10-06T15:00:00Z" }]);
  return { bundle: `${stem}.bundle`, patch: `${stem}.patch`, untrackedTar: `${stem}.untracked.tar` };
}

function writeRegistry(home, entries) {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "ws-registry.json"), `${JSON.stringify({ version: 1, entries }, null, 2)}\n`);
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "myr-ws-restore-test-"));
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
    root,
    home,
    archiveRoot: path.join(home, "archive"),
    workspaceRoot: path.join(root, "workspace"),
    calls,
    // Fake of lib/open.js (H2b): a bare class-D base under
    // <home>/git-base/<owner>/<repo>.git with the standard refspec (so
    // refs/remotes/origin/* exist), a worktree of it, registry entry
    // written — the deps contract of the real open.
    async open(request) {
      calls.push(request);
      const base = path.join(home, "git-base", `${request.repo}.git`);
      if (!fs.existsSync(base)) {
        fs.mkdirSync(path.dirname(base), { recursive: true });
        git(path.dirname(base), "clone", "-q", "--bare", `file://${path.join(root, "seed")}`, base);
        git(base, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
        git(base, "fetch", "-q", "origin");
      }
      const dir = path.join(root, "workspace", request.key);
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      git(base, "worktree", "add", "-q", "--no-track", "-b", `bot/${request.key}`, dir, "refs/remotes/origin/main");
      writeRegistry(home, [{ key: request.key, repo: request.repo, path: dir, class: "E", branch: `bot/${request.key}`, openedAt: "2026-10-07T01:00:00Z" }]);
      return { ok: true, key: request.key, path: dir, class: "E", repo: request.repo, branch: `bot/${request.key}`, reused: false };
    },
  };
});

const run = (argv, extra = {}) => ws.runRestore(argv, { ...ctx, ...extra });
const copyOf = (r) => JSON.parse(r.stdout);

function checkRestoreSchema(value) {
  if (schemas) return schemas.myrWsRestoreResultSchema.parse(value);
  for (const f of ["ok", "key", "path", "branch", "restoredFrom"]) assert.ok(f in value, `missing ${f}`);
  return value;
}

function checkErrorSchema(value) {
  if (schemas) return schemas.myrWsErrorResultSchema.parse(value);
  for (const f of ["ok", "error", "exitCode"]) assert.ok(f in value, `missing ${f}`);
  return value;
}

describe("myr-ws restore — contract constants", () => {
  it("exit codes match the contract", { skip: !schemas }, () => {
    assert.deepEqual(ws.EXIT, schemas.MYR_WS_EXIT);
  });

  it("the restore fixture passes the schema and has the keys restore emits", { skip: !schemas }, () => {
    const fx = JSON.parse(fs.readFileSync(path.join(FIXTURES, "myr-ws-restore.json"), "utf8"));
    const parsed = schemas.myrWsRestoreResultSchema.parse(fx);
    for (const f of ["ok", "key", "path", "branch", "restoredFrom"]) assert.ok(f in parsed, `missing ${f}`);
  });
});

describe("myr-ws restore — usage", () => {
  it("no key -> exit 2", async () => {
    const r = await run([]);
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /usage: myr-ws restore/);
  });

  it("bad key -> exit 2", async () => {
    const r = await run(["lowercase-1"]);
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /invalid issue key/);
  });

  it("unknown option -> exit 2", async () => {
    const r = await run([KEY, "--nope"]);
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /unknown option --nope/);
  });

  it("--json error shape on usage failure", async () => {
    const r = await run(["--json"]);
    assert.equal(r.exitCode, 2);
    const e = copyOf(r);
    checkErrorSchema(e);
    assert.equal(e.ok, false);
    assert.equal(e.exitCode, 2);
  });
});

describe("myr-ws restore — archive selection", () => {
  it("no archive directory -> exit 6, nothing created", async () => {
    const r = await run([KEY, "--json"]);
    assert.equal(r.exitCode, 6);
    const e = copyOf(r);
    checkErrorSchema(e);
    assert.match(e.error, /no archive of ABC-101/);
    assert.equal(ctx.calls.length, 0, "open must not be called");
    assert.equal(fs.existsSync(path.join(ctx.workspaceRoot, KEY)), false);
  });

  it("no bundle for the key -> exit 6", async () => {
    fs.mkdirSync(ctx.archiveRoot, { recursive: true });
    fs.writeFileSync(path.join(ctx.archiveRoot, "OTHER-7-20261006T150000Z.bundle"), "x");
    const r = await run([KEY, "--json"]);
    assert.equal(r.exitCode, 6);
    assert.match(copyOf(r).error, /no archive of ABC-101/);
    assert.equal(ctx.calls.length, 0);
  });

  it("no registry entry but a manifest entry with the repo -> restores (close dropped the entry)", async () => {
    const src = buildSourceCopy(ctx.root);
    const a = archiveCopy(ctx.root, src, "20261006T150000Z");
    fs.rmSync(path.join(ctx.home, "ws-registry.json"));
    fs.writeFileSync(
      path.join(ctx.archiveRoot, "manifest.json"),
      JSON.stringify({ version: 1, archives: [{ key: KEY, repo: REPO, bundle: a.bundle, patch: a.patch, createdAt: "2026-10-06T15:00:00Z", sizeBytes: 1, truncatedUntracked: false }] }),
    );
    const r = await run([KEY, "--json"]);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(copyOf(r).branch, BRANCH);
    assert.equal(ctx.calls[0].repo, REPO);
  });

  it("no registry entry for the key -> exit 6, nothing created", async () => {
    const src = buildSourceCopy(ctx.root);
    archiveCopy(ctx.root, src, "20261006T150000Z");
    fs.rmSync(path.join(ctx.home, "ws-registry.json"));
    const r = await run([KEY, "--json"]);
    assert.equal(r.exitCode, 6);
    assert.match(copyOf(r).error, /no registry entry for ABC-101/);
    assert.equal(ctx.calls.length, 0);
    assert.equal(fs.existsSync(path.join(ctx.workspaceRoot, KEY)), false);
  });

  it("the newest timestamp wins", async () => {
    const src = buildSourceCopy(ctx.root);
    const older = archiveCopy(ctx.root, src, "20261006T150000Z");
    // an older-looking bundle of the same key, corrupt — it must be ignored
    fs.writeFileSync(path.join(ctx.archiveRoot, `${KEY}-20261005T090000Z.bundle`), "garbage\n");
    fs.rmSync(src.copy, { recursive: true, force: true });
    git(src.base, "worktree", "prune");

    const r = await run([KEY, "--json"]);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(copyOf(r).restoredFrom, older.bundle);
  });
});

describe("myr-ws restore — happy path and idempotence", () => {
  it("restores branch, diff and untracked files byte-for-byte; re-run is idempotent", async () => {
    const src = buildSourceCopy(ctx.root);
    const wanted = snapshot(src.copy);
    const archive = archiveCopy(ctx.root, src, "20261006T150000Z");
    fs.rmSync(src.copy, { recursive: true, force: true });
    git(src.base, "worktree", "prune");

    const r = await run([KEY, "--json"]);
    assert.equal(r.exitCode, 0, r.stderr);
    const res = copyOf(r);
    checkRestoreSchema(res);
    assert.equal(res.ok, true);
    assert.equal(res.key, KEY);
    assert.equal(res.branch, BRANCH);
    assert.equal(res.restoredFrom, archive.bundle);
    assert.equal(res.path, path.join(ctx.workspaceRoot, KEY));

    const got = snapshot(res.path);
    assert.equal(got.head, wanted.head, "branch tip");
    assert.equal(got.tracked, wanted.tracked, "tracked diff");
    assert.deepEqual(
      Object.fromEntries(Object.entries(got.untracked).map(([k, v]) => [k, v.toString()])),
      Object.fromEntries(Object.entries(wanted.untracked).map(([k, v]) => [k, v.toString()])),
      "untracked payloads",
    );
    const branchCheck = spawnSync("git", ["symbolic-ref", "HEAD"], { cwd: res.path, encoding: "utf8" });
    assert.equal(branchCheck.stdout.trim(), `refs/heads/${BRANCH}`);

    // re-run: the copy already holds the archived state -> reused, nothing re-applied
    const again = await run([KEY, "--json"]);
    assert.equal(again.exitCode, 0, again.stderr);
    const res2 = copyOf(again);
    assert.equal(res2.reused, true);
    assert.equal(res2.restoredFrom, archive.bundle);
    assert.equal(ctx.calls.length, 1, "open called exactly once");
  });

  it("an existing copy with different content is never overwritten (exit 6, untouched)", async () => {
    const src = buildSourceCopy(ctx.root);
    archiveCopy(ctx.root, src, "20261006T150000Z");

    const occupied = path.join(ctx.workspaceRoot, KEY);
    fs.mkdirSync(occupied, { recursive: true });
    fs.writeFileSync(path.join(occupied, "mine.txt"), "precious\n");

    const r = await run([KEY, "--json"]);
    assert.equal(r.exitCode, 6);
    assert.match(copyOf(r).error, /never overwrites/);
    assert.equal(fs.readFileSync(path.join(occupied, "mine.txt"), "utf8"), "precious\n");
    assert.equal(ctx.calls.length, 0, "open must not be called");
  });

  it("a bot/<KEY> branch in the base at a different commit is never clobbered (exit 6, nothing touched)", async () => {
    const src = buildSourceCopy(ctx.root);
    archiveCopy(ctx.root, src, "20261006T150000Z");
    // Simulate a branch left in the base by a copy closed without archiving:
    // the fake open's base gets bot/<KEY> at the origin tip (≠ archive head).
    const homeBase = path.join(ctx.home, "git-base", `${REPO}.git`);
    fs.mkdirSync(path.dirname(homeBase), { recursive: true });
    git(path.dirname(homeBase), "clone", "-q", "--bare", `file://${path.join(ctx.root, "seed")}`, homeBase);
    git(homeBase, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
    git(homeBase, "fetch", "-q", "origin");
    const originTip = git(homeBase, "rev-parse", "refs/remotes/origin/main");
    git(homeBase, "branch", BRANCH, originTip);
    fs.rmSync(src.copy, { recursive: true, force: true });
    git(src.base, "worktree", "prune");

    const r = await run([KEY, "--json"]);
    assert.equal(r.exitCode, 6);
    assert.match(copyOf(r).error, /already exists in the base/);
    assert.equal(ctx.calls.length, 0, "open must not be called");
    assert.equal(fs.existsSync(path.join(ctx.workspaceRoot, KEY)), false);
    assert.equal(git(homeBase, "rev-parse", `refs/heads/${BRANCH}`), originTip, "branch left untouched");
  });
});

describe("myr-ws restore — broken archive", () => {
  it("corrupt bundle -> exit 6, no copy created", async () => {
    const src = buildSourceCopy(ctx.root);
    const archive = archiveCopy(ctx.root, src, "20261006T150000Z");
    fs.writeFileSync(archive.bundle, "garbage, not a bundle\n");

    const r = await run([KEY, "--json"]);
    assert.equal(r.exitCode, 6);
    const e = copyOf(r);
    checkErrorSchema(e);
    assert.match(e.error, /broken/);
    assert.equal(fs.existsSync(path.join(ctx.workspaceRoot, KEY)), false, "no worktree left behind");
    assert.equal(ctx.calls.length, 0, "open must not be called on a broken bundle");
  });

  it("bundle without the task branch -> exit 6, no copy created", async () => {
    const src = buildSourceCopy(ctx.root);
    const archive = archiveCopy(ctx.root, src, "20261006T150000Z");
    // rebuild the bundle without bot/<KEY>
    git(src.copy, "branch", "other-branch");
    git(src.copy, "bundle", "create", archive.bundle, "other-branch");

    const r = await run([KEY, "--json"]);
    assert.equal(r.exitCode, 6);
    assert.match(copyOf(r).error, new RegExp(`does not contain refs/heads/${BRANCH.replace("/", "\\/")}`));
    assert.equal(fs.existsSync(path.join(ctx.workspaceRoot, KEY)), false);
    assert.equal(ctx.calls.length, 0);
  });

  it("a failure during apply removes the fresh copy and keeps old ones", async () => {
    const src = buildSourceCopy(ctx.root);
    const archive = archiveCopy(ctx.root, src, "20261006T150000Z");
    fs.writeFileSync(archive.patch, "definitely not a patch\n");

    const other = path.join(ctx.workspaceRoot, "ABC-999");
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, "keep.txt"), "untouched\n");

    const r = await run([KEY, "--json"]);
    assert.equal(r.exitCode, 5, `expected git/apply failure, got ${r.exitCode}: ${r.stdout}${r.stderr}`);
    assert.equal(fs.existsSync(path.join(ctx.workspaceRoot, KEY)), false, "fresh copy rolled back");
    assert.equal(fs.readFileSync(path.join(other, "keep.txt"), "utf8"), "untouched\n");
  });
});
