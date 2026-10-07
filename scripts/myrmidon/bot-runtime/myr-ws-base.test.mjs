import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// myrmidon(1.6.5 BOT-DISK-H2a): docker/bot-runtime/myr-ws — the class-D base
// (bare repository, fetch throttle, limit of 8) and the CLI frame. The origin
// is a local bare repository reached over file://; git is a counting fake that
// delegates to the real binary through MYRMIDON_GIT_REAL. Placeholder owners
// and repositories only; nothing touches the network.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const WS_DIR = path.join(ROOT, "docker/bot-runtime/myr-ws");
const ENTRY = path.join(WS_DIR, "myr-ws");
const CONTRACT_TS = path.join(ROOT, "packages/shared/src/myrmidon-bot-workspace.ts");
const require = createRequire(import.meta.url);
const base = require(path.join(WS_DIR, "lib/base.js"));
const layout = require(path.join(WS_DIR, "lib/layout.js"));
const cli = require(path.join(WS_DIR, "lib/cli.js"));

const hasGit = spawnSync("git", ["--version"]).status === 0;
const GIT_ENV = {
  PATH: process.env.PATH,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

let tmp;
let originRoot; // <originRoot>/<owner>/<repo>.git, served as file://
let fakeGit;
let callLog;

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...GIT_ENV, HOME: tmp } });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function makeOrigin(owner, repo) {
  const bare = path.join(originRoot, owner, `${repo}.git`);
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  git(tmp, "init", "--bare", "--quiet", "-b", "main", bare);
  const work = fs.mkdtempSync(path.join(tmp, "work-"));
  git(work, "init", "--quiet", "-b", "main");
  fs.writeFileSync(path.join(work, "README.md"), `${owner}/${repo}\n`);
  git(work, "add", ".");
  git(work, "commit", "--quiet", "-m", "init");
  git(work, "push", "--quiet", bare, "main");
  return bare;
}

function newHome() {
  return fs.mkdtempSync(path.join(tmp, "home-"));
}

function envFor(home, extra = {}) {
  return {
    ...GIT_ENV,
    HOME: tmp,
    MYRMIDON_WS_HOME: home,
    MYRMIDON_GIT_REAL: fakeGit,
    MYRMIDON_WS_REMOTE_BASE: `file://${originRoot}`,
    FAKE_GIT_LOG: callLog,
    ...extra,
  };
}

function fetchCalls() {
  if (!fs.existsSync(callLog)) return 0;
  return fs
    .readFileSync(callLog, "utf8")
    .split("\n")
    .filter((l) => l.startsWith("fetch ")).length;
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "myr-ws-base-test-"));
  originRoot = path.join(tmp, "origin");
  callLog = path.join(tmp, "git-calls.log");
  const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  fakeGit = path.join(tmp, "fake-git.sh");
  fs.writeFileSync(fakeGit, `#!/bin/sh\necho "$@" >> "$FAKE_GIT_LOG"\nexec ${realGit} "$@"\n`, { mode: 0o755 });
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("myr-ws base: contract parity", () => {
  it("mirrors the C1 constants of the shared contract", () => {
    const ts = fs.readFileSync(CONTRACT_TS, "utf8");
    const str = (name) => new RegExp(`export const ${name} = "([^"]+)"`).exec(ts)?.[1];
    const num = (name) => Number(new RegExp(`export const ${name} = (\\d+)`).exec(ts)?.[1]);
    assert.equal(layout.MYRMIDON_HOME_DIR, str("MYRMIDON_HOME_DIR"));
    assert.equal(layout.WS_GIT_BASE_REFSPEC, str("WS_GIT_BASE_REFSPEC"));
    assert.equal(layout.WS_GIT_BASE_LIMIT, num("WS_GIT_BASE_LIMIT"));
    assert.equal(layout.WS_GIT_BASE_FETCH_MIN_INTERVAL_SEC, num("WS_GIT_BASE_FETCH_MIN_INTERVAL_SEC"));
    assert.equal(layout.gitBaseRoot({}), `${str("MYRMIDON_HOME_DIR")}/git-base`);
  });

  it("uses the contract exit codes", () => {
    assert.deepEqual(base.EXIT, { ok: 0, usage: 2, quotaExceeded: 3, baseLimit: 4, network: 5, notFound: 6, unpushed: 7 });
    const ts = fs.readFileSync(CONTRACT_TS, "utf8");
    const block = /export const MYR_WS_EXIT = \{([^}]+)\}/.exec(ts)[1];
    for (const [name, code] of Object.entries(base.EXIT)) {
      assert.match(block, new RegExp(`${name}:\\s*${code}\\b`));
    }
  });
});

describe("myr-ws base: repository name validation", () => {
  it("accepts owner/repo, drops .git", () => {
    assert.equal(layout.parseRepo("acme/widgets").slug, "acme/widgets");
    assert.equal(layout.parseRepo("acme/widgets.git").slug, "acme/widgets");
    assert.equal(layout.parseRepo("acme/my.repo_1-x").slug, "acme/my.repo_1-x");
  });

  for (const bad of [
    "../etc",
    "acme/..",
    "acme/../x",
    "acme/a/b",
    "/acme/widgets",
    "acme//widgets",
    "acme",
    "",
    "acme/.hidden",
    "-acme/widgets",
    "acme/wid gets",
    "acme/widgets\n",
    "https://github.com/acme/widgets",
    "user:token@acme/widgets",
    "acme\\widgets",
  ]) {
    it(`rejects ${JSON.stringify(bad)} with exit 2 and creates nothing`, () => {
      const home = newHome();
      assert.throws(
        () => base.ensureBase(bad, { env: envFor(home) }),
        (e) => e.name === "MyrWsError" && e.exitCode === 2,
      );
      assert.equal(fs.existsSync(path.join(home, "git-base")), false);
    });
  }
});

describe("myr-ws base: ensureBase", { skip: !hasGit && "git missing" }, () => {
  it("creates a bare base with the standard refspec, no userinfo, gc off", () => {
    makeOrigin("acme", "widgets");
    const home = newHome();
    const r = base.ensureBase("acme/widgets", { env: envFor(home) });
    assert.equal(r.created, true);
    assert.equal(r.fetched, true);
    assert.equal(r.path, path.join(home, "git-base/acme/widgets.git"));
    const cfg = (k) => git(r.path, "config", "--get-all", k);
    assert.equal(git(r.path, "rev-parse", "--is-bare-repository"), "true");
    assert.equal(cfg("remote.origin.fetch"), "+refs/heads/*:refs/remotes/origin/*");
    assert.equal(cfg("fetch.prune"), "true");
    assert.equal(cfg("gc.auto"), "0");
    assert.equal(cfg("gc.pruneExpire"), "never");
    const url = cfg("remote.origin.url");
    assert.equal(url, `file://${originRoot}/acme/widgets.git`);
    assert.doesNotMatch(url, /@/);
    // The fetch landed under refs/remotes/origin/*, not refs/heads/*.
    assert.match(git(r.path, "for-each-ref", "--format=%(refname)", "refs/remotes/origin"), /refs\/remotes\/origin\/main/);
    assert.equal(git(r.path, "for-each-ref", "refs/heads"), "");
    // Raw config file: no credentials anywhere.
    assert.doesNotMatch(fs.readFileSync(path.join(r.path, "config"), "utf8"), /password|token|x-access/i);
  });

  it("the default origin is https://github.com/<owner>/<repo>.git", () => {
    assert.equal(layout.DEFAULT_REMOTE_BASE, "https://github.com");
  });

  it("does not fetch again within MYRMIDON_WS_REFRESH_SEC (900 s), fetches after", () => {
    makeOrigin("acme", "gadgets");
    const home = newHome();
    const env = envFor(home);
    const before1 = fetchCalls();
    const t0 = Date.now();
    base.ensureBase("acme/gadgets", { env, now: () => t0 });
    assert.equal(fetchCalls() - before1, 1);
    const again = base.ensureBase("acme/gadgets", { env, now: () => t0 + 1000 });
    assert.equal(again.created, false);
    assert.equal(again.fetched, false);
    assert.equal(fetchCalls() - before1, 1, "no fetch 1 s later");
    base.ensureBase("acme/gadgets", { env, now: () => t0 + 899_000 });
    assert.equal(fetchCalls() - before1, 1, "no fetch at 899 s");
    const later = base.ensureBase("acme/gadgets", { env, now: () => t0 + 901_000 });
    assert.equal(later.fetched, true);
    assert.equal(fetchCalls() - before1, 2, "fetch after 900 s");
  });

  it("honours MYRMIDON_WS_REFRESH_SEC", () => {
    makeOrigin("acme", "sprockets");
    const home = newHome();
    const env = envFor(home, { MYRMIDON_WS_REFRESH_SEC: "0" });
    const n = fetchCalls();
    base.ensureBase("acme/sprockets", { env });
    base.ensureBase("acme/sprockets", { env });
    assert.equal(fetchCalls() - n, 2);
  });

  it("fetch picks up new upstream branches and prunes deleted ones", () => {
    const bare = makeOrigin("acme", "prune-me");
    const home = newHome();
    const env = envFor(home, { MYRMIDON_WS_REFRESH_SEC: "0" });
    const b = base.ensureBase("acme/prune-me", { env }).path;
    git(bare, "branch", "feature", "main");
    base.ensureBase("acme/prune-me", { env });
    assert.match(git(b, "for-each-ref", "--format=%(refname)", "refs/remotes/origin"), /origin\/feature/);
    git(bare, "branch", "-D", "feature");
    base.ensureBase("acme/prune-me", { env });
    assert.doesNotMatch(git(b, "for-each-ref", "--format=%(refname)", "refs/remotes/origin"), /origin\/feature/);
  });

  it("refuses the 9th repository with exit 4 and keeps the 8 bases", () => {
    const home = newHome();
    const env = envFor(home);
    for (let i = 1; i <= 8; i++) {
      makeOrigin("limit", `r${i}`);
      base.ensureBase(`limit/r${i}`, { env });
    }
    assert.equal(base.listBases(env).length, 8);
    makeOrigin("limit", "r9");
    assert.throws(
      () => base.ensureBase("limit/r9", { env }),
      (e) => e.exitCode === 4 && /limit/.test(e.message),
    );
    assert.equal(base.listBases(env).length, 8);
    assert.equal(fs.existsSync(path.join(home, "git-base/limit/r9.git")), false);
    // An existing base is still served at the limit.
    assert.equal(base.ensureBase("limit/r3", { env }).created, false);
  });

  it("a failed first fetch exits 5 and leaves no base behind", () => {
    const home = newHome();
    const env = envFor(home);
    assert.throws(
      () => base.ensureBase("acme/not-there", { env }),
      (e) => e.exitCode === 5,
    );
    assert.equal(base.listBases(env).length, 0);
  });
});

describe("myr-ws CLI frame", () => {
  const run = (args, env = {}) => spawnSync(process.execPath, [ENTRY, ...args], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });

  it("registers the five verbs and every one is a real handler (none is a stub)", () => {
    assert.deepEqual(Object.keys(cli.COMMANDS).sort(), ["close", "list", "migrate", "open", "restore"]);
    for (const [verb, fn] of Object.entries(cli.COMMANDS)) {
      assert.equal(typeof fn, "function", verb);
      assert.ok(typeof fn === "function", `${verb} is a notImplemented stub`);
    }
  });

  it("--json prints the contract error shape", () => {
    const r = run(["bogus", "--json"]);
    assert.equal(r.status, 2);
    const body = JSON.parse(r.stdout);
    assert.equal(body.ok, false);
    assert.equal(body.exitCode, 2);
    assert.equal(typeof body.error, "string");
    assert.deepEqual(Object.keys(body).sort(), ["error", "exitCode", "ok"]);
  });

  it("unknown command, no command and unknown option exit 2", () => {
    assert.equal(run(["bogus"]).status, 2);
    assert.equal(run([]).status, 2);
    assert.equal(run(["list", "--nope"]).status, 2);
    assert.equal(run(["open", "K-1", "--base"]).status, 2);
  });

  it("a handler result prints as ok JSON, any error with exitCode maps to it", async () => {
    const commands = {
      list: () => ({ entries: [] }),
      open: async () => {
        throw new base.MyrWsError(4, "base limit");
      },
      restore: async () => {
        throw Object.assign(new Error("own error"), { exitCode: 7 });
      },
    };
    const ok = await cli.run(["list", "--json"], { commands });
    assert.equal(ok.exitCode, 0);
    assert.deepEqual(JSON.parse(ok.stdout), { ok: true, entries: [] });
    const bad = await cli.run(["open", "--json"], { commands });
    assert.equal(bad.exitCode, 4);
    assert.deepEqual(JSON.parse(bad.stdout), { ok: false, error: "base limit", exitCode: 4 });
    assert.equal((await cli.run(["open"], { commands })).stderr, "myr-ws: base limit\n");
    assert.equal((await cli.run(["restore"], { commands })).exitCode, 7);
    assert.equal(base.MyrWsError, require(path.join(WS_DIR, "lib/errors.js")).MyrWsError);
  });

  it("parses --base, --scratch, --force", () => {
    const p = cli.parseArgs(["open", "ABC-1", "acme/widgets", "--base", "main", "--scratch", "--force", "--json"]);
    assert.equal(p.command, "open");
    assert.deepEqual(p.positionals, ["ABC-1", "acme/widgets"]);
    assert.deepEqual(p.flags, { json: true, scratch: true, force: true, base: "main" });
  });
});
