import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// myrmidon(1.6.5 BOT-DISK-H3d): docker/bot-runtime/botd/lib/classify.js — the
// class E/G/X classifier of botd. Fixtures are built on disk in a temp dir;
// the "token" is a made-up marker string that must never appear in any output.
// Nothing here touches the network.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CONTRACT_DIR = path.join(ROOT, "docs/myrmidon/bot-disk-contract");
const hasGit = spawnSync("git", ["--version"]).status === 0;

const {
  classifyAll,
  classifyDir,
  measureTree,
  parseGitConfig,
  stripUserinfo,
  toInventory,
  toReportParts,
  urlHasUserinfo,
} = await import(path.join(ROOT, "docker/bot-runtime/botd/lib/classify.js"));

// The contract schemas are TypeScript and need zod. Where zod is not installed
// (this test runs without a package install) the contract checks are skipped.
let contract = null;
try {
  contract = await import(path.join(ROOT, "packages/shared/src/myrmidon-bot-workspace.ts"));
} catch {
  contract = null;
}
const noContract = contract === null && "contract schemas unavailable (zod not installed)";

const SECRET = "zz-fixture-secret-0f3a9c";
const HOUR = 3600;

let tmp;
let ws;
let scratch;
let base;

function mkRepo(dir, configExtra) {
  for (const sub of ["objects", "refs"]) fs.mkdirSync(path.join(dir, ".git", sub), { recursive: true });
  fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(dir, ".git", "config"), `[core]\n\trepositoryformatversion = 0\n${configExtra}`);
  fs.writeFileSync(path.join(dir, "file.txt"), "hello\n");
}

const REMOTE = '[remote "origin"]\n\turl = https://example.com/acme/widgets.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n';

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "botd-classify-"));
  ws = path.join(tmp, "workspace");
  scratch = path.join(tmp, "scratch");
  base = path.join(tmp, "git-base");
  for (const d of [ws, scratch, base]) fs.mkdirSync(d, { recursive: true });

  // promisor clone (partial clone) in the task root
  mkRepo(path.join(ws, "ABC-1"), `${REMOTE}\tpromisor = true\n\tpartialclonefilter = blob:none\n`);
  // clone with credentials in the URL
  mkRepo(
    path.join(ws, "ABC-2"),
    `[remote "origin"]\n\turl = https://x-access-token:${SECRET}@example.com/acme/widgets.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
  );
  // repository without a remote
  mkRepo(path.join(ws, "ABC-3"), "");
  // trash
  fs.mkdirSync(path.join(ws, ".trash-x"));
  fs.writeFileSync(path.join(ws, ".trash-x", "junk"), "x");
  // full clone outside the base
  mkRepo(path.join(ws, "ABC-4"), REMOTE);
  // class E: worktree of a base repository
  const baseRepo = path.join(base, "acme", "widgets.git");
  fs.mkdirSync(path.join(baseRepo, "worktrees", "ABC-5"), { recursive: true });
  fs.writeFileSync(path.join(baseRepo, "config"), `[core]\n\tbare = true\n${REMOTE}`);
  fs.writeFileSync(path.join(baseRepo, "worktrees", "ABC-5", "commondir"), "../..\n");
  fs.mkdirSync(path.join(ws, "ABC-5"));
  fs.writeFileSync(path.join(ws, "ABC-5", ".git"), `gitdir: ${path.join(baseRepo, "worktrees", "ABC-5")}\n`);
  // class E: registered copy that looks like a clone
  mkRepo(path.join(ws, "ABC-6"), REMOTE);
  // scratch: a fresh and an old clone with a remote, a plain directory
  mkRepo(path.join(scratch, "fresh"), REMOTE);
  mkRepo(path.join(scratch, "old"), REMOTE);
  fs.mkdirSync(path.join(scratch, "plain"));
  fs.writeFileSync(path.join(scratch, "plain", "a.log"), "log\n");
  // dot directories other than .trash-* are not ours
  fs.mkdirSync(path.join(scratch, ".pnpm-store"));
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const registry = () => [{ key: "ABC-6", path: path.join(ws, "ABC-6"), class: "E", openedAt: "2026-10-06T10:00:00Z" }];
const run = (extra = {}) =>
  classifyAll({ roots: [ws, scratch], workspaceRoot: ws, gitBaseDir: base, registry: registry(), ...extra });
const byName = (res) => Object.fromEntries(res.items.map((i) => [path.basename(i.path), i]));

describe("pure helpers", () => {
  it("detects userinfo only where it is a credential", () => {
    assert.equal(urlHasUserinfo("https://tok@github.com/a/b.git"), true);
    assert.equal(urlHasUserinfo("https://user:pw@github.com/a/b.git"), true);
    assert.equal(urlHasUserinfo("https://github.com/a/b.git"), false);
    assert.equal(urlHasUserinfo("git@github.com:a/b.git"), false);
    assert.equal(urlHasUserinfo("ssh://git@github.com/a/b.git"), false);
    assert.equal(urlHasUserinfo("/data/hermes/.myrmidon/git-base/a/b.git"), false);
  });
  it("strips userinfo and keeps the rest", () => {
    assert.equal(stripUserinfo("https://x:y@example.com:8443/a/b.git?q=1"), "https://example.com:8443/a/b.git?q=1");
    assert.equal(stripUserinfo("https://example.com/a/b.git"), "https://example.com/a/b.git");
  });
  it("parses sections, subsections, comments and quoted values", () => {
    const e = parseGitConfig('# c\n[Remote "origin"]\n\tURL = "u"\n\tpromisor\n[extensions]\n\tpartialClone = origin\n');
    assert.deepEqual(
      e.map((x) => [x.section, x.sub, x.key, x.value]),
      [
        ["remote", "origin", "url", "u"],
        ["remote", "origin", "promisor", "true"],
        ["extensions", null, "partialclone", "origin"],
      ],
    );
  });
});

describe("classification of fixtures", () => {
  it("assigns the class and the sign of each fixture", () => {
    const m = byName(run());
    assert.deepEqual([m["ABC-1"].class, m["ABC-1"].sign], ["X", "promisor"]);
    assert.deepEqual([m["ABC-2"].class, m["ABC-2"].sign], ["X", "token"]);
    assert.deepEqual([m["ABC-3"].class, m["ABC-3"].sign], ["X", "no-remote"]);
    assert.deepEqual([m[".trash-x"].class, m[".trash-x"].sign], ["X", "trash"]);
    assert.deepEqual([m["ABC-4"].class, m["ABC-4"].sign], ["X", "full-clone"]);
    assert.deepEqual([m["ABC-5"].class, m["ABC-5"].sign], ["E", null]);
    assert.deepEqual([m["ABC-6"].class, m["ABC-6"].sign], ["E", null]);
    assert.deepEqual([m.fresh.class, m.fresh.sign], ["G", null]);
    assert.deepEqual([m.plain.class, m.plain.sign], ["G", null]);
    assert.equal(m[".pnpm-store"], undefined);
    assert.equal(Object.keys(m).length, 10); // 7 task-root dirs + fresh, old, plain
  });

  it("returns size and age for every item", () => {
    const m = byName(run());
    assert.ok(m["ABC-4"].sizeBytes > 0);
    assert.ok(Number.isInteger(m["ABC-4"].ageSec) && m["ABC-4"].ageSec >= 0);
    assert.deepEqual(Object.keys(m["ABC-4"]).sort(), ["ageSec", "class", "inWorkspace", "isGit", "mtimeMs", "nestedGit", "path", "sign", "sizeBytes"]);
  });

  it("scratch: fresh stays, old goes by TTL; the age counts mtime/ctime", () => {
    const fresh = run({ now: Date.now() });
    const old = run({ now: Date.now() + 25 * HOUR * 1000 });
    const act = (res, n) => res.actions.find((a) => path.basename(a.path) === n);
    assert.equal(act(fresh, "fresh").action, "keep");
    assert.equal(act(old, "fresh").action, "remove");
    assert.equal(act(old, "fresh").archive, true); // a repository: unpushed work is looked for first
    assert.equal(act(old, "plain").action, "remove");
    assert.equal(act(old, "plain").archive, false);
    assert.ok(byName(old).fresh.ageSec >= 25 * HOUR);
    assert.ok(byName(fresh).fresh.ageSec < 60);
  });

  it("scratch TTL follows the board's grace and the pressure override", () => {
    const now = Date.now() + 2 * HOUR * 1000;
    const act = (res, n) => res.actions.find((a) => path.basename(a.path) === n);
    assert.equal(act(run({ now }), "fresh").action, "keep");
    assert.equal(act(run({ now, scratchTtlSec: HOUR }), "fresh").action, "remove");
    const desired = { grace: { closingMinutes: 30, scratchTtlHours: 1, orphanHours: 24 }, workspaces: [] };
    assert.equal(act(run({ now, desired }), "fresh").action, "remove");
  });
});

describe("age ignores .git (host fetch/status must not reset the TTL)", () => {
  it("a rewrite inside .git leaves the newest time unchanged; a change in the working tree moves it", async () => {
    const dir = path.join(scratch, "aged");
    mkRepo(dir, REMOTE);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const before = measureTree(dir).newestMs;
    await sleep(30);
    // what `git fetch` does: new files and a fresh FETCH_HEAD in .git
    fs.mkdirSync(path.join(dir, ".git", "objects", "pack"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".git", "objects", "pack", "tmp_pack_x"), "x");
    fs.writeFileSync(path.join(dir, ".git", "FETCH_HEAD"), "abc\n");
    fs.appendFileSync(path.join(dir, ".git", "config"), "# touched\n");
    const afterFetch = measureTree(dir);
    assert.equal(afterFetch.newestMs, before, "fetch in .git must not reset the age");
    assert.ok(afterFetch.sizeBytes > 0);
    await sleep(30);
    fs.writeFileSync(path.join(dir, "file.txt"), "edited\n");
    assert.ok(measureTree(dir).newestMs > before, "an edit of the working tree moves the age");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("foreign (X) and live tasks", () => {
  const now = Date.now() + 25 * HOUR * 1000;
  const act = (res, n) => res.actions.find((a) => path.basename(a.path) === n);

  it("raises the card at once and holds removal inside the grace", () => {
    const desired = { grace: { closingMinutes: 30, scratchTtlHours: 24, orphanHours: 48 }, workspaces: [] };
    const a = act(run({ now, desired }), "ABC-4");
    assert.deepEqual([a.action, a.card], ["keep", true]);
  });

  it("removes after the grace; archive only for a repository", () => {
    const desired = { grace: { closingMinutes: 30, scratchTtlHours: 24, orphanHours: 24 }, workspaces: [] };
    const res = run({ now, desired });
    assert.deepEqual([act(res, "ABC-4").action, act(res, "ABC-4").archive], ["remove", true]);
    assert.deepEqual([act(res, ".trash-x").action, act(res, ".trash-x").archive], ["remove", false]);
  });

  it("does not touch a foreign copy whose task with the same key is active", () => {
    const desired = {
      grace: { closingMinutes: 30, scratchTtlHours: 24, orphanHours: 24 },
      workspaces: [{ key: "ABC-4", state: "active", since: "2026-10-06T10:00:00Z", prState: "open" }],
    };
    const a = act(run({ now, desired }), "ABC-4");
    assert.deepEqual([a.action, a.card], ["hold", true]);
    // the same key once the task is closing: back to the grace rule
    desired.workspaces[0].state = "closing";
    assert.equal(act(run({ now, desired }), "ABC-4").action, "remove");
  });

  it("board unreachable: cards, but nothing is removed", () => {
    const a = act(run({ now, desired: null }), "ABC-4");
    assert.deepEqual([a.action, a.card], ["hold", true]);
  });
});

describe("the token never leaves", { skip: !hasGit && "git not available" }, () => {
  const configOf = (name) => fs.readFileSync(path.join(ws, name, ".git", "config"), "utf8");

  it("is absent from items, actions, report parts and the log", () => {
    const logs = [];
    const orig = { log: console.log, error: console.error, warn: console.warn };
    console.log = console.error = console.warn = (...a) => logs.push(a.join(" "));
    let res;
    try {
      res = run({ now: Date.now() + 25 * HOUR * 1000 });
    } finally {
      Object.assign(console, orig);
    }
    const blob = JSON.stringify([res, toReportParts(res.items, res.actions), logs]);
    assert.ok(!blob.includes(SECRET));
    assert.ok(configOf("ABC-2").includes(SECRET)); // not rewritten without the flag
  });

  it("set-url rewrites the URL without userinfo and counts it once", () => {
    const res = run({ fixTokenUrls: true });
    assert.equal(res.fixedUrls, 1);
    assert.equal(res.fixFailed, 0);
    const cfg = configOf("ABC-2");
    assert.ok(!cfg.includes(SECRET));
    assert.ok(cfg.includes("url = https://example.com/acme/widgets.git"));
    assert.ok(!JSON.stringify(res).includes(SECRET));
    // the first pass still reports what it found; the next one has nothing to fix
    assert.equal(byName(res)["ABC-2"].sign, "token");
    const again = run({ fixTokenUrls: true });
    assert.equal(again.fixedUrls, 0);
    assert.equal(byName(again)["ABC-2"].sign, "full-clone");
  });

  it("a failing git is counted and its output is not copied", () => {
    const d = path.join(ws, "ABC-7");
    mkRepo(d, `[remote "origin"]\n\turl = https://u:${SECRET}@example.com/a/b.git\n`);
    const res = run({ fixTokenUrls: true, gitBin: "/nonexistent/git" });
    assert.equal(res.fixedUrls, 0);
    assert.equal(res.fixFailed, 1);
    assert.ok(!JSON.stringify(res).includes(SECRET));
    fs.rmSync(d, { recursive: true });
  });
});

describe("conforms to the contract", { skip: noContract }, () => {
  it("the report parts pass wsReportCopySchema / wsReportForeignSchema", () => {
    const res = run({ now: Date.now() + 25 * HOUR * 1000 });
    const { copies, foreign } = toReportParts(res.items, res.actions);
    for (const c of copies) contract.wsReportCopySchema.parse(c);
    for (const f of foreign) contract.wsReportForeignSchema.parse(f);
    assert.equal(foreign.length, copies.filter((c) => c.class === "X").length);
    // a whole report with them is valid
    const fixture = JSON.parse(fs.readFileSync(path.join(CONTRACT_DIR, "disk-report.json"), "utf8"));
    contract.wsDiskReportSchema.parse({ ...fixture, copies, foreign });
  });

  it("every sign is one the contract knows", () => {
    for (const it of run().items) {
      if (it.class === "X") assert.ok(contract.wsForeignSignSchema.options.includes(it.sign));
      else assert.equal(it.sign, null);
    }
  });

  it("the contract fixtures are valid inputs: registry and desired state", () => {
    const reg = contract.wsRegistrySchema.parse(JSON.parse(fs.readFileSync(path.join(CONTRACT_DIR, "ws-registry.json"), "utf8")));
    const des = contract.wsDesiredStateSchema.parse(JSON.parse(fs.readFileSync(path.join(CONTRACT_DIR, "desired-state.json"), "utf8")));
    const res = classifyAll({ roots: [ws, scratch], workspaceRoot: ws, gitBaseDir: base, registry: reg.entries, desired: des });
    assert.ok(res.items.length > 0);
  });

  it("classifyDir on a missing directory does not throw", () => {
    const c = classifyDir(path.join(tmp, "nope"), { workspaceRoot: ws, registry: [], gitBaseDir: base });
    assert.equal(c.class, "G");
  });
});

describe("classifyAll without workspaceRoot", () => {
  it("does not throw (default root /workspace)", () => {
    const res = classifyAll({ roots: [scratch], gitBaseDir: base });
    assert.ok(res.items.length > 0);
    assert.ok(res.items.every((i) => i.class === "G")); // nothing of scratch is directly under /workspace
  });
  it("works with no options at all", () => {
    const res = classifyAll();
    assert.ok(Array.isArray(res.items) && Array.isArray(res.actions));
  });
});

describe("toInventory: the shape of the rules inventory", () => {
  const now = Date.now() + 25 * HOUR * 1000;
  const inv = toInventory(run({ now }).items, { now });
  const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

  it("has the four lists; bases and archives are empty", () => {
    assert.deepEqual(Object.keys(inv).sort(), ["archives", "bases", "scratch", "worktrees"]);
    assert.deepEqual([inv.bases, inv.archives], [[], []]);
  });
  it("class E goes to worktrees, the rest to scratch", () => {
    assert.deepEqual(inv.worktrees.map((w) => w.key).sort(), ["ABC-5", "ABC-6"]);
    assert.equal(inv.scratch.length, 8);
    for (const w of inv.worktrees) {
      assert.deepEqual(Object.keys(w).sort(), ["clean", "dirMissing", "key", "openedAt", "path", "pushed"]);
      assert.ok(ISO.test(w.openedAt));
    }
  });
  it("clean/pushed are null (never guessed), mtime is ISO", () => {
    for (const s of inv.scratch) {
      assert.deepEqual(Object.keys(s).sort(), ["clean", "isGit", "mtime", "name", "nestedGit", "path", "pushed", "sizeBytes"]);
      assert.equal(s.clean, null);
      assert.equal(s.pushed, null);
      assert.ok(ISO.test(s.mtime));
    }
  });
  it("a directory of the task root without .git is archived too (isGit true); plain scratch is not", () => {
    const by = Object.fromEntries(inv.scratch.map((s) => [s.name, s]));
    assert.equal(by["ABC-4"].isGit, true);
    assert.equal(by[".trash-x"].isGit, true); // in the task root: safe side
    assert.equal(by.plain.isGit, false);
    assert.equal(by.old.isGit, true);
  });
});
