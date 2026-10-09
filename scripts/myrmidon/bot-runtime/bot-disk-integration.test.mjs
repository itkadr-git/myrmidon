import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// myrmidon(1.6.5 BOT-DISK-H, integration): the pieces of the bot-disk mechanism run
// TOGETHER on real git and a real disk — botd loop + rules (the real modules), the
// real archive module, the real `myr-ws` inventory/close/restore — against a local
// bare origin and a fake board (the desired-state answer and the C4 report route).
// What stays outside this file by design: docker, the real /workspace root, the
// partition quota and the pnpm store (those are the canary / stand steps of the
// runbook, docs/myrmidon/bot-disk-canary-runbook.md). Placeholder keys and
// repositories only; nothing touches the network.
//
// The wiring below mirrors docker/bot-runtime/botd/botd (the executor and the
// inventory mapping); a change in that wiring has to change this test too.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(import.meta.url);
const closeMod = require(path.join(ROOT, "docker/bot-runtime/myr-ws/lib/close.js"));
const restoreMod = require(path.join(ROOT, "docker/bot-runtime/myr-ws/lib/restore.js"));
const { inventory: wsInventory, toListEntry } = require(path.join(ROOT, "docker/bot-runtime/myr-ws/lib/inventory.js"));
const BOTD = path.join(ROOT, "docker/bot-runtime/botd/lib");
const { createLoop } = await import(path.join(BOTD, "loop.js"));
const rules = await import(path.join(BOTD, "rules.js"));
const archiveMod = await import(path.join(BOTD, "archive.js"));
const { buildReport, createReporter, validateReport } = await import(path.join(BOTD, "report.js"));

const hasGit = spawnSync("git", ["--version"]).status === 0;
const KEY_OPEN = "ABC-101";
const KEY_DONE = "ABC-102";
const KEY_WIP = "ABC-103";
const REPO = "acme/widgets";
const OPENED = "2026-10-06T14:00:00Z";
const CLOSED_SINCE = "2026-10-06T14:10:00Z";
const T_BEFORE_GRACE = new Date("2026-10-06T14:20:00Z"); // 10 min after `since` (grace 30)
const T_AFTER_GRACE = new Date("2026-10-06T14:50:00Z"); // 40 min after `since`

let tmp;
let n = 0;

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

/** A bot: local origin, a class-D base, the workspace root, the archive root, the registry. */
function world() {
  const dir = fs.mkdtempSync(path.join(tmp, `w${++n}-`));
  const origin = path.join(dir, "origin.git");
  git(dir, "init", "--bare", "--quiet", "-b", "main", origin);
  const seed = path.join(dir, "seed");
  fs.mkdirSync(seed);
  git(seed, "init", "--quiet", "-b", "main");
  fs.writeFileSync(path.join(seed, "README.md"), "hello\n");
  git(seed, "add", ".");
  git(seed, "commit", "--quiet", "-m", "init");
  git(seed, "push", "--quiet", origin, "main");
  const home = path.join(dir, "home");
  const basePath = path.join(home, "git-base/acme/widgets.git");
  fs.mkdirSync(path.dirname(basePath), { recursive: true });
  git(dir, "init", "--bare", "--quiet", basePath);
  git(basePath, "remote", "add", "origin", origin);
  git(basePath, "config", "--replace-all", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
  git(basePath, "fetch", "--quiet", "origin");
  const w = {
    dir,
    origin,
    home,
    basePath,
    workspaceRoot: path.join(dir, "workspace"),
    scratchRoot: path.join(dir, "scratch"),
    archiveRoot: path.join(home, "archive"),
    entries: [],
  };
  fs.mkdirSync(w.workspaceRoot);
  fs.mkdirSync(w.scratchRoot);
  return w;
}

function writeRegistry(w) {
  fs.writeFileSync(path.join(w.home, "ws-registry.json"), `${JSON.stringify({ version: 1, entries: w.entries }, null, 2)}\n`);
}

const registryKeys = (w) => JSON.parse(fs.readFileSync(path.join(w.home, "ws-registry.json"), "utf8")).entries.map((e) => e.key);

/** What `myr-ws open` leaves behind: worktree + bot/<KEY> branch + registry entry. */
function openTask(w, key) {
  const copy = path.join(w.workspaceRoot, key);
  git(w.basePath, "worktree", "add", "--no-track", "-b", `bot/${key}`, copy, "refs/remotes/origin/main");
  w.entries.push({ key, repo: REPO, path: copy, class: "E", branch: `bot/${key}`, openedAt: OPENED });
  writeRegistry(w);
  return copy;
}

function desiredState(over = {}) {
  return {
    generatedAt: "2026-10-06T14:00:00Z",
    grace: { closingMinutes: 30, scratchTtlHours: 24, orphanHours: 24 },
    pressure: { quotaPercent: 10, partitionPercent: 40, level: "none" },
    workspaces: [
      { key: KEY_OPEN, repo: REPO, state: "active", since: OPENED, prState: "open", branch: `bot/${KEY_OPEN}` },
      { key: KEY_DONE, repo: REPO, state: "closing", since: CLOSED_SINCE, prState: "merged", branch: `bot/${KEY_DONE}` },
      { key: KEY_WIP, repo: REPO, state: "closing", since: CLOSED_SINCE, prState: "none", branch: `bot/${KEY_WIP}` },
    ],
    protectKeys: [KEY_OPEN],
    closedKeys: [],
    ...over,
  };
}

/** The pass: the real loop, rules, archive, close; a fake board; the clock is a parameter. */
function pass(w, { desired, at, calls = [] }) {
  const sent = [];
  const reporter = createReporter({
    env: { PAPERCLIP_API_URL: "http://board.test", PAPERCLIP_API_KEY: "test-key-never-logged" },
    fetchImpl: async (url, init) => {
      sent.push(JSON.parse(init.body));
      return { status: 200, text: async () => JSON.stringify({ ok: true, nextReportSec: 300 }) };
    },
    sleep: async () => {},
  });
  const env = { PATH: process.env.PATH, HOME: tmp, MYRMIDON_WS_HOME: w.home, GIT_CONFIG_NOSYSTEM: "1" };
  const closeDeps = {
    env,
    home: w.home,
    workspaceRoot: w.workspaceRoot,
    scratchRoot: w.scratchRoot,
    archive: async (copyPath, key, opts = {}) => {
      // like botd: the repository comes from what `close` hands over (the base here has a
      // local origin URL that the archive cannot turn into owner/repo by itself)
      const r = archiveMod.archive(copyPath, key, { archiveRoot: w.archiveRoot, now: at, ...opts });
      calls.push({ op: "archive", key, ok: r.ok });
      return r.ok ? { ok: true, archivePath: r.entry.bundle } : { ok: false, error: r.reason };
    },
  };
  const gather = async () => {
    const copies = wsInventory({ env, workspaceRoot: w.workspaceRoot, scratchRoot: w.scratchRoot, sizes: false }).copies.map(toListEntry);
    return {
      inventory: {
        worktrees: copies
          .filter((e) => e.class === "E")
          .map((e) => ({
            key: e.key,
            path: e.path,
            repo: e.repo,
            dirMissing: !fs.existsSync(e.path),
            clean: e.clean,
            pushed: e.pushed,
            openedAt: e.openedAt,
          })),
        scratch: [],
        bases: [],
        archives: [],
      },
      parts: { copies: [], foreign: [], bases: [], archives: [], selfChecks: { reflink: null, gitref: null, wsCli: true } },
    };
  };
  const executor = {
    remove: async (a) => {
      calls.push({ op: "remove", key: a.key });
      const r = await closeMod.closeCopy({ key: a.key, force: false }, closeDeps);
      return r.archived ? "archived" : "closed";
    },
    "archive-remove": async (a) => {
      calls.push({ op: "archive-remove", key: a.key });
      const r = await closeMod.closeCopy({ key: a.key, force: true }, closeDeps);
      return r.archived ? "archived" : "closed";
    },
    prune: async () => {
      calls.push({ op: "prune" });
      git(w.basePath, "worktree", "prune");
      return "worktree prune";
    },
  };
  const loop = createLoop({
    desired: { poll: async () => desired },
    gather,
    rules,
    executor,
    report: { build: buildReport, send: reporter.send },
    writeDiskState: async () => {},
    log: () => {},
    now: () => at,
    botKey: "bot-001",
    imageGeneration: "myr-v1.6.5-rc.7",
  });
  return loop.runOnce().then((out) => ({ out, sent, calls }));
}

const ok = (state) => ({ ok: true, state });
const branches = (w) => git(w.basePath, "for-each-ref", "--format=%(refname:short)", "refs/heads");

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bot-disk-integration-test-"));
});
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("bot disk: board closes the task, botd removes the copy (scenario 4)", { skip: !hasGit && "git missing" }, () => {
  it("inside the grace nothing goes; after it a clean pushed copy is closed, the active neighbour stays", async () => {
    const w = world();
    const active = openTask(w, KEY_OPEN);
    const done = openTask(w, KEY_DONE);

    const early = await pass(w, { desired: ok(desiredState()), at: T_BEFORE_GRACE });
    assert.deepEqual(early.calls, [], "inside the grace window: no removal");
    assert.equal(fs.existsSync(done), true);

    const late = await pass(w, { desired: ok(desiredState()), at: T_AFTER_GRACE });
    assert.deepEqual(late.calls, [{ op: "remove", key: KEY_DONE }]);
    assert.equal(fs.existsSync(done), false, "the closed copy is gone from the disk");
    assert.equal(fs.existsSync(active), true, "the copy of the active task is untouched");
    assert.deepEqual(registryKeys(w), [KEY_OPEN]);
    assert.doesNotMatch(branches(w), new RegExp(`bot/${KEY_DONE}`));
    assert.match(branches(w), new RegExp(`bot/${KEY_OPEN}`));
    // the report that went to the board passes the C4 validator and names the removal
    assert.equal(late.sent.length, 1);
    assert.deepEqual(validateReport(late.sent[0]), { ok: true });
    const row = late.sent[0].actions.find((a) => a.path === done);
    assert.ok(row, "the removal is in the report");
    assert.equal(row.result, "ok");
  });

  it("unpushed work: archived first, then removed; the archive holds the branch and the untracked file", async () => {
    const w = world();
    const wip = openTask(w, KEY_WIP);
    fs.writeFileSync(path.join(wip, "feature.txt"), "committed but unpushed\n");
    git(wip, "add", ".");
    git(wip, "commit", "--quiet", "-m", "wip");
    fs.writeFileSync(path.join(wip, "notes.txt"), "untracked\n");

    const r = await pass(w, { desired: ok(desiredState()), at: T_AFTER_GRACE });
    assert.deepEqual(
      r.calls.map((c) => c.op),
      ["archive-remove", "archive"],
      "the executor asked for the archive and the archive ran before the copy went",
    );
    assert.equal(r.calls[1].ok, true);
    assert.equal(fs.existsSync(wip), false);
    const names = fs.readdirSync(w.archiveRoot);
    assert.ok(names.some((f) => f.startsWith(`${KEY_WIP}-`) && f.endsWith(".bundle")), `bundle in ${names.join(",")}`);
    assert.ok(names.some((f) => f.endsWith(".untracked.tar")), "untracked files are archived too");
    const row = r.sent[0].actions.find((a) => a.path === wip);
    assert.equal(row.action, "archive");
    assert.equal(row.result, "ok");
  });

  it("restore after the removal brings the branch with its commit back (criterion 8)", async () => {
    const w = world();
    const wip = openTask(w, KEY_WIP);
    fs.writeFileSync(path.join(wip, "feature.txt"), "committed but unpushed\n");
    git(wip, "add", ".");
    git(wip, "commit", "--quiet", "-m", "wip");
    const tip = git(wip, "rev-parse", "HEAD");
    await pass(w, { desired: ok(desiredState()), at: T_AFTER_GRACE });
    assert.equal(fs.existsSync(wip), false);

    // `close` dropped the registry entry; restore has to work without a manual re-open
    assert.deepEqual(registryKeys(w), []);
    const r = await restoreMod.runRestore([KEY_WIP, "--json"], {
      home: w.home,
      archiveRoot: w.archiveRoot,
      workspaceRoot: w.workspaceRoot,
      env: { PATH: process.env.PATH, HOME: tmp, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" },
      open: async (request) => {
        git(w.basePath, "worktree", "add", "--no-track", "-b", `bot/${request.key}`, wip, "refs/remotes/origin/main");
        return { ok: true, key: request.key, path: wip, class: "E", repo: request.repo, branch: `bot/${request.key}`, reused: false };
      },
    });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(git(wip, "rev-parse", "HEAD"), tip, "the branch tip is the archived commit");
    assert.equal(fs.readFileSync(path.join(wip, "feature.txt"), "utf8"), "committed but unpushed\n");
  });
});

describe("bot disk: fail-safe and drift (scenarios 5 and 8)", { skip: !hasGit && "git missing" }, () => {
  it("the board is down: nothing is removed, the report says why, and the closed copy survives", async () => {
    const w = world();
    const done = openTask(w, KEY_DONE);
    const r = await pass(w, { desired: { ok: false, reason: "HTTP 503" }, at: T_AFTER_GRACE });
    assert.equal(r.out.desiredOk, false);
    assert.deepEqual(r.calls, []);
    assert.equal(fs.existsSync(done), true);
    assert.deepEqual(registryKeys(w), [KEY_DONE]);
    assert.equal(r.sent[0].actions[0].action, "skip");
  });

  it("a copy whose task the board forgot (orphan) waits the orphan grace, not the closing one", async () => {
    const w = world();
    const orphan = openTask(w, "ZZZ-900"); // not in the desired list
    const early = await pass(w, { desired: ok(desiredState()), at: T_AFTER_GRACE });
    assert.deepEqual(early.calls, [], "40 minutes is far inside the 24 h orphan grace");
    const late = await pass(w, { desired: ok(desiredState()), at: new Date("2026-10-07T15:00:00Z") });
    assert.deepEqual(late.calls, [{ op: "remove", key: "ZZZ-900" }]);
    assert.equal(fs.existsSync(orphan), false);
  });

  it("drift: an active copy deleted by hand is pruned, no removal, the base keeps working", async () => {
    const w = world();
    const active = openTask(w, KEY_OPEN);
    fs.rmSync(active, { recursive: true, force: true });
    assert.match(git(w.basePath, "worktree", "list", "--porcelain"), new RegExp(KEY_OPEN));
    const r = await pass(w, { desired: ok(desiredState()), at: T_BEFORE_GRACE });
    assert.deepEqual(r.calls, [{ op: "prune" }]);
    assert.doesNotMatch(git(w.basePath, "worktree", "list", "--porcelain"), new RegExp(KEY_OPEN), "the stale worktree record is gone");
    assert.equal(fs.existsSync(path.join(w.basePath, "HEAD")), true, "the base itself stays");
  });

  it("a dirty closed copy is archived, never removed raw (red side: the clean-pushed path would lose the file)", async () => {
    const w = world();
    const done = openTask(w, KEY_DONE);
    fs.writeFileSync(path.join(done, "unsaved.txt"), "do not lose me\n");
    const r = await pass(w, { desired: ok(desiredState()), at: T_AFTER_GRACE });
    assert.deepEqual(r.calls.map((c) => c.op), ["archive-remove", "archive"]);
    const tars = fs.readdirSync(w.archiveRoot).filter((f) => f.endsWith(".untracked.tar"));
    assert.equal(tars.length, 1, "the unsaved file is in the archive");
    const listing = spawnSync("tar", ["-tf", path.join(w.archiveRoot, tars[0])], { encoding: "utf8" }).stdout;
    assert.match(listing, /unsaved\.txt/);
  });

  it("the archive fails: the copy stays on the disk and in the registry", async () => {
    const w = world();
    const wip = openTask(w, KEY_WIP);
    fs.writeFileSync(path.join(wip, "keep.txt"), "x\n");
    // make the archive root unusable: a file where the directory has to be
    fs.mkdirSync(w.home, { recursive: true });
    fs.writeFileSync(w.archiveRoot, "not a directory");
    const r = await pass(w, { desired: ok(desiredState()), at: T_AFTER_GRACE });
    assert.equal(r.calls.find((c) => c.op === "archive")?.ok, false);
    assert.equal(fs.existsSync(path.join(wip, "keep.txt")), true, "no archive, no deletion");
    assert.deepEqual(registryKeys(w), [KEY_WIP]);
    assert.equal(r.sent[0].actions.find((a) => a.path === wip).result, "error");
  });
});

describe("bot disk: one archive root for close and restore", { skip: !hasGit && "git missing" }, () => {
  it("MYRMIDON_WS_HOME overridden: close writes under <home>/archive and restore finds it there (no archive dep, no archiveRoot dep)", async () => {
    const w = world();
    const wip = openTask(w, KEY_WIP);
    fs.writeFileSync(path.join(wip, "feature.txt"), "unpushed\n");
    git(wip, "add", ".");
    git(wip, "commit", "--quiet", "-m", "wip");
    const tip = git(wip, "rev-parse", "HEAD");
    const env = {
      PATH: process.env.PATH,
      HOME: tmp,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
      MYRMIDON_WS_HOME: w.home,
    };
    // the real botd archive module is used (the default of closeCopy): its own default root
    // is the production path, so the root has to come from close
    const closed = await closeMod.closeCopy({ key: KEY_WIP, force: true }, { env, workspaceRoot: w.workspaceRoot, scratchRoot: w.scratchRoot });
    assert.equal(closed.archived, true);
    assert.ok(closed.archivePath === undefined || closed.archivePath.startsWith(path.join(w.home, "archive")));
    assert.ok(fs.readdirSync(path.join(w.home, "archive")).some((f) => f.startsWith(`${KEY_WIP}-`) && f.endsWith(".bundle")));
    const r = await restoreMod.runRestore([KEY_WIP, "--json"], {
      env,
      workspaceRoot: w.workspaceRoot,
      open: async (request) => {
        git(w.basePath, "worktree", "add", "--no-track", "-b", `bot/${request.key}`, wip, "refs/remotes/origin/main");
        return { ok: true, key: request.key, path: wip, class: "E", repo: request.repo, branch: `bot/${request.key}`, reused: false };
      },
    });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(git(wip, "rev-parse", "HEAD"), tip);
  });
});
