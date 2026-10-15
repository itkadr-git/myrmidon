import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// myrmidon(1.6.5 BOT-DISK-H2c): `myr-ws list` + the shared inventory()
// library, against real fixture repositories built in a scratch dir — no
// network, no board. Acceptance (the issue's test criterion): a clean pushed
// copy lists clean+pushed; an unpushed commit flips pushed; a modified file
// flips clean; a registry entry whose directory the bot deleted is marked
// missing; `--json` passes the contract schema (myrWsListResultSchema from
// @paperclipai/shared — the H0 contract module). Everything runs under
// MYRMIDON_WS_HOME pointed at the fixture root, the contract's test override.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CLI = path.join(ROOT, "docker", "bot-runtime", "myr-ws", "myr-ws");
const INVENTORY_JS = path.join(ROOT, "docker", "bot-runtime", "myr-ws", "lib", "inventory.js");
const CONTRACT_LIST_FIXTURE = path.join(ROOT, "docs", "myrmidon", "bot-disk-contract", "myr-ws-list.json");

// The contract's zod schema, without a ts toolchain: the CLI's JSON output is
// validated field-by-field below against the same rules
// packages/shared/src/myrmidon-bot-workspace.ts encodes in
// myrWsListResultSchema. Keeping the two in sync is guarded by the shared
// package's own fixture test (myr-ws-list.json passes the zod schema there);
// here the same fixture passes this checker's rules.
function isIsoNoOffset(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(s);
}
function checkListResult(value) {
  const errors = [];
  if (!value || value.ok !== true || !Array.isArray(value.entries)) {
    return ["result must be {ok:true, entries:[...]}"];
  }
  value.entries.forEach((e, i) => {
    const at = `entries[${i}]`;
    if (typeof e.key !== "string" || e.key.length < 1) errors.push(`${at}.key`);
    if (typeof e.path !== "string" || e.path.length < 1) errors.push(`${at}.path`);
    if (!["E", "G"].includes(e.class)) errors.push(`${at}.class must be E|G, got ${e.class}`);
    if (e.repo !== undefined && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(e.repo)) errors.push(`${at}.repo`);
    if (e.branch !== undefined && (typeof e.branch !== "string" || e.branch.length < 1)) errors.push(`${at}.branch`);
    if (!isIsoNoOffset(e.openedAt)) errors.push(`${at}.openedAt`);
    if (e.clean !== null && typeof e.clean !== "boolean") errors.push(`${at}.clean`);
    if (e.pushed !== null && typeof e.pushed !== "boolean") errors.push(`${at}.pushed`);
  });
  return errors;
}

let inventory; // the imported inventory() function
let tmp;
let home; // MYRMIDON_WS_HOME
let workspaceRoot;
let scratchRoot;
let basePath;

// The copies the fixture set builds: one clean+pushed worktree (E), one
// worktree with an unpushed commit, one with a modified file, one registry
// entry whose directory is gone, one scratch copy (G).
const KEY_CLEAN = "ABC-101";
const KEY_UNPUSHED = "ABC-102";
const KEY_DIRTY = "ABC-103";
const KEY_MISSING = "ABC-104";
const KEY_SCRATCH = "probe-reflink";
const REPO = "acme/widgets";

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

/** A bare class-D base with one branch (main) carrying one commit. */
function makeBase() {
  basePath = path.join(home, "git-base", "acme", "widgets.git");
  fs.mkdirSync(basePath, { recursive: true });
  // `git init --bare <path>` (the path as an argument) registers no origin
  // remote; cloning the path and pushing from the clone does, which is what a
  // real class-D base has after `myr-ws migrate` (H2f).
  git(basePath, "init", "--bare");
  // Seed the base through a throwaway clone so the base owns real objects.
  const seed = path.join(tmp, "seed");
  git(tmp, "clone", basePath, "seed");
  git(seed, "config", "user.email", "test@example.com");
  git(seed, "config", "user.name", "Test");
  fs.writeFileSync(path.join(seed, "README.md"), "fixture\n");
  git(seed, "add", "README.md");
  git(seed, "commit", "-m", "initial");
  git(seed, "branch", "-M", "main");
  git(seed, "push", "origin", "main");
  // Class-D refspec: heads land under refs/remotes/origin/*, fetch.prune on.
  git(basePath, "config", "remote.origin.url", basePath);
  git(basePath, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
  git(basePath, "config", "fetch.prune", "true");
  git(basePath, "config", "gc.auto", "0");
  git(basePath, "config", "gc.pruneExpire", "never");
  git(basePath, "fetch", "origin", "--prune");
}

/** A class-E worktree of the base on branch bot/<KEY>. */
function makeWorktree(key) {
  const dir = path.join(workspaceRoot, key);
  git(basePath, "worktree", "add", "-b", `bot/${key}`, dir, "origin/main");
  return dir;
}

function writeRegistry(entries) {
  fs.writeFileSync(
    path.join(home, "ws-registry.json"),
    JSON.stringify({ version: 1, entries }, null, 2),
  );
}

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      MYRMIDON_WS_HOME: home,
      MYRMIDON_WS_WORKSPACE_ROOT: workspaceRoot,
      MYRMIDON_WS_SCRATCH_ROOT: scratchRoot,
      ...env,
    },
  });
}

before(async () => {
  // realpath up front: os.tmpdir() may sit behind a symlink while `git
  // worktree list` reports realpaths — the registry and the roots must use
  // the same spelling or the fixture trips the path-dedupe both ways.
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "myr-ws-list-test-")));
  home = path.join(tmp, "home");
  workspaceRoot = path.join(tmp, "workspace");
  scratchRoot = path.join(tmp, "scratch");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(scratchRoot, { recursive: true });

  inventory = (await import(INVENTORY_JS)).inventory;

  makeBase();
  // E: clean + pushed.
  makeWorktree(KEY_CLEAN);
  // E: unpushed commit.
  const unpushed = makeWorktree(KEY_UNPUSHED);
  git(unpushed, "config", "user.email", "test@example.com");
  git(unpushed, "config", "user.name", "Test");
  fs.writeFileSync(path.join(unpushed, "wip.txt"), "work in progress\n");
  git(unpushed, "add", "wip.txt");
  git(unpushed, "commit", "-m", "unpushed work");
  // E: modified tracked file, committed state is pushed.
  const dirty = makeWorktree(KEY_DIRTY);
  fs.appendFileSync(path.join(dirty, "README.md"), "edited\n");
  // G: scratch copy (plain clone, not a worktree of the base).
  git(scratchRoot, "clone", basePath, KEY_SCRATCH);
  // E missing: registry entry only, the directory never existed.

  writeRegistry(fullRegistryEntries());
});

/** The canonical registry state the fixture before() installs; tests that
 * rewrite the registry (e.g. the unregistered-worktree case) restore this in
 * their finally block so later suites see the full fixture set. */
function fullRegistryEntries() {
  return [
    {
      key: KEY_CLEAN,
      repo: REPO,
      path: path.join(workspaceRoot, KEY_CLEAN),
      class: "E",
      branch: `bot/${KEY_CLEAN}`,
      openedAt: "2026-10-06T14:00:00Z",
    },
    {
      key: KEY_UNPUSHED,
      repo: REPO,
      path: path.join(workspaceRoot, KEY_UNPUSHED),
      class: "E",
      branch: `bot/${KEY_UNPUSHED}`,
      openedAt: "2026-10-06T14:05:00Z",
    },
    {
      key: KEY_DIRTY,
      repo: REPO,
      path: path.join(workspaceRoot, KEY_DIRTY),
      class: "E",
      branch: `bot/${KEY_DIRTY}`,
      openedAt: "2026-10-06T14:10:00Z",
    },
    {
      key: KEY_MISSING,
      repo: REPO,
      path: path.join(workspaceRoot, KEY_MISSING),
      class: "E",
      branch: `bot/${KEY_MISSING}`,
      openedAt: "2026-10-06T14:15:00Z",
    },
    {
      key: KEY_SCRATCH,
      path: path.join(scratchRoot, KEY_SCRATCH),
      class: "G",
      openedAt: "2026-10-06T13:30:00Z",
    },
  ];
}

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function inventoryEnv() {
  return {
    env: {
      ...process.env,
      MYRMIDON_WS_HOME: home,
      MYRMIDON_WS_WORKSPACE_ROOT: workspaceRoot,
      MYRMIDON_WS_SCRATCH_ROOT: scratchRoot,
    },
    workspaceRoot,
    scratchRoot,
  };
}

function copyByKey(inv, key) {
  const c = inv.copies.find((x) => x.key === key);
  assert.ok(c, `copy ${key} missing from inventory`);
  return c;
}

describe("inventory() over fixture copies (BOT-DISK-H2c)", () => {
  it("lists a clean pushed copy as clean+pushed", () => {
    const c = copyByKey(inventory(inventoryEnv()), KEY_CLEAN);
    assert.equal(c.clean, true);
    assert.equal(c.pushed, true);
    assert.equal(c.class, "E");
    assert.equal(c.repo, REPO);
    assert.equal(c.branch, `bot/${KEY_CLEAN}`);
    assert.equal(c.openedAt, "2026-10-06T14:00:00Z");
    assert.equal(c.missing, false);
    assert.ok(Number.isInteger(c.sizeBytes) && c.sizeBytes > 0);
    assert.ok(Number.isInteger(c.ageSec) && c.ageSec >= 0);
  });

  it("marks a copy with an unpushed commit pushed=false", () => {
    const c = copyByKey(inventory(inventoryEnv()), KEY_UNPUSHED);
    assert.equal(c.clean, true);
    assert.equal(c.pushed, false);
  });

  it("marks a copy with a modified file clean=false", () => {
    const c = copyByKey(inventory(inventoryEnv()), KEY_DIRTY);
    assert.equal(c.clean, false);
    assert.equal(c.pushed, true);
  });

  it("marks a registry entry whose directory is gone as missing", () => {
    const c = copyByKey(inventory(inventoryEnv()), KEY_MISSING);
    assert.equal(c.missing, true);
    assert.equal(c.clean, null);
    assert.equal(c.pushed, null);
    assert.equal(c.sizeBytes, null);
    assert.equal(c.class, "E");
    assert.equal(c.repo, REPO);
  });

  it("lists a scratch copy as class G", () => {
    const c = copyByKey(inventory(inventoryEnv()), KEY_SCRATCH);
    assert.equal(c.class, "G");
    assert.equal(c.clean, true);
  });

  it("inventories the class-D base with its fetch timestamp", () => {
    const { bases } = inventory(inventoryEnv());
    const base = bases.find((b) => b.repo === REPO);
    assert.ok(base, "base missing from inventory");
    assert.equal(base.path, basePath);
    assert.ok(Number.isInteger(base.sizeBytes) && base.sizeBytes > 0);
    assert.match(base.lastFetchAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it("discovers a worktree the registry does not know via git worktree list", () => {
    const extra = makeWorktree("ABC-199");
    writeRegistry([
      {
        key: KEY_CLEAN,
        repo: REPO,
        path: path.join(workspaceRoot, KEY_CLEAN),
        class: "E",
        branch: `bot/${KEY_CLEAN}`,
        openedAt: "2026-10-06T14:00:00Z",
      },
    ]);
    try {
      const inv = inventory(inventoryEnv());
      const c = inv.copies.find((x) => fs.realpathSync(x.path) === extra);
      assert.ok(c, "unregistered worktree missing from inventory");
      assert.equal(c.class, "E");
      assert.equal(c.repo, REPO);
      assert.equal(c.branch, "bot/ABC-199");
      assert.equal(c.clean, true);
    } finally {
      git(basePath, "worktree", "remove", "--force", extra);
      writeRegistry(fullRegistryEntries());
    }
  });

  it("survives an absent or malformed registry", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "myr-ws-list-empty-"));
    try {
      const inv = inventory({
        env: { ...process.env, MYRMIDON_WS_HOME: path.join(empty, "nope") },
        workspaceRoot: path.join(empty, "ws"),
        scratchRoot: path.join(empty, "sc"),
      });
      assert.deepEqual(inv.copies, []);
      fs.mkdirSync(path.join(empty, "h"), { recursive: true });
      fs.writeFileSync(path.join(empty, "h", "ws-registry.json"), "{ not json");
      const inv2 = inventory({
        env: { ...process.env, MYRMIDON_WS_HOME: path.join(empty, "h") },
        workspaceRoot: path.join(empty, "ws"),
        scratchRoot: path.join(empty, "sc"),
      });
      assert.deepEqual(inv2.copies, []);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("myr-ws list CLI (BOT-DISK-H2c)", () => {
  it("--json output passes the contract schema myrWsListResultSchema", () => {
    const r = runCli(["list", "--json"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    const errors = checkListResult(parsed);
    assert.deepEqual(errors, [], `schema mismatch: ${errors.join("; ")}`);
    const byKey = Object.fromEntries(parsed.entries.map((e) => [e.key, e]));
    assert.equal(byKey[KEY_CLEAN].clean, true);
    assert.equal(byKey[KEY_CLEAN].pushed, true);
    assert.equal(byKey[KEY_UNPUSHED].pushed, false);
    assert.equal(byKey[KEY_DIRTY].clean, false);
    assert.equal(byKey[KEY_MISSING].missing, true);
    assert.equal(byKey[KEY_MISSING].clean, null);
    assert.equal(byKey[KEY_SCRATCH].class, "G");
  });

  it("human output lists one line per copy", () => {
    const r = runCli(["list"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const lines = r.stdout.trim().split("\n");
    assert.equal(lines.length, 5);
    assert.ok(lines.some((l) => l.startsWith(`${KEY_CLEAN}\tE\t`) && l.includes("clean,pushed")));
    assert.ok(lines.some((l) => l.startsWith(`${KEY_MISSING}\tE\t`) && l.includes("missing")));
  });

  it("rejects an unknown argument with exit code 2 (MYR_WS_EXIT.usage)", () => {
    const r = runCli(["list", "--bogus", "--json"]);
    assert.equal(r.status, 2);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.exitCode, 2);
    assert.match(parsed.error, /unknown argument/);
  });

  it("rejects an unknown subcommand with exit code 2", () => {
    const r = runCli(["frobnicate"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown command/);
  });

  it("answers 0 for `myr-ws --help`", () => {
    const r = runCli(["--help"]);
    assert.equal(r.status, 0);
  });
});

describe("contract fixture (BOT-DISK-H0 guard for this task)", () => {
  it("docs/myrmidon/bot-disk-contract/myr-ws-list.json passes myrWsListResultSchema", () => {
    const fixture = JSON.parse(fs.readFileSync(CONTRACT_LIST_FIXTURE, "utf8"));
    const errors = checkListResult(fixture);
    assert.deepEqual(errors, [], `fixture fails its schema: ${errors.join("; ")}`);
  });
});
