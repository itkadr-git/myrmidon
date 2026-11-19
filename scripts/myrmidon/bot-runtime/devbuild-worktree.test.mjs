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
// myrmidon(1.6.9 DEVBUILD-CACHE-MODES): the shared /srv/devcache git caches
// must be synced with group read/write/traverse regardless of restrictive
// source modes, while the per-bot repo mirror keeps its isolation.
// myrmidon(1.6.9 DEVBUILD-CACHE-TIMES): the same syncs must omit directory
// times so a second user can re-sync the cache (file times stay, so the
// incremental quick-check keeps working).

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

    // myrmidon(1.6.9 DEVBUILD-CACHE-MODES): the shared git caches under
    // /srv/devcache are written by the transport user and used by the (different)
    // user that runs the remote command. A bot-volume base can be mode 0700;
    // rsync -a then copies that onto the shared cache and the remote command gets
    // Permission denied. The devcache syncs must add group rwx/traverse (and
    // setgid, so both users keep sharing new files) without touching the
    // per-bot repo mirror, which keeps its restrictive isolation.
    it("worktree: shared git-wt cache syncs add group rw/traverse even for 0700 sources", () => {
      fs.chmodSync(base, 0o700);
      try {
        const { r, calls } = run(wt);
        assert.equal(r.status, 0, r.stderr);
        const cacheSyncs = calls.split("\n").filter((l) => l.startsWith("RSYNC") && l.includes(":/srv/devcache/git-wt/"));
        assert.ok(cacheSyncs.length >= 2, `expected the base and admin-dir syncs, got:\n${calls}`);
        for (const line of cacheSyncs) {
          assert.ok(line.includes("--chmod=Dg+rwXs,Fg+rw"), `shared cache sync lacks the group chmod:\n${line}`);
        }
        // the per-bot repo mirror must NOT be widened
        const botSyncs = calls.split("\n").filter((l) => l.startsWith("RSYNC") && l.includes(":/srv/devbuild/bot1/ABC-1/"));
        assert.ok(botSyncs.length >= 1, `expected the per-bot sync, got:\n${calls}`);
        for (const line of botSyncs) assert.ok(!line.includes("--chmod"), `per-bot sync must stay unmodified:\n${line}`);
      } finally {
        fs.chmodSync(base, 0o755);
      }
    });

    it("borrowed-object mirror cache sync adds group rw/traverse too", () => {
      const mirror = path.join(tmp, "hermes/.myrmidon/git-objects/seed.git");
      fs.mkdirSync(path.join(mirror, "objects"), { recursive: true });
      fs.writeFileSync(path.join(clone, ".git/objects/info/alternates"), `${path.join(mirror, "objects")}\n`);
      try {
        const { r, calls } = run(clone);
        assert.equal(r.status, 0, r.stderr);
        const mirrorSyncs = calls.split("\n").filter((l) => l.startsWith("RSYNC") && l.includes(":/srv/devcache/git/"));
        assert.equal(mirrorSyncs.length, 1, `expected exactly one mirror sync, got:\n${calls}`);
        assert.ok(mirrorSyncs[0].includes("--chmod=Dg+rwXs,Fg+rw"), `mirror cache sync lacks the group chmod:\n${mirrorSyncs[0]}`);
      } finally {
        fs.rmSync(path.join(clone, ".git/objects/info/alternates"), { force: true });
      }
    });

    // myrmidon(1.6.9 DEVBUILD-CACHE-TIMES): the shared cache is created by one
    // user and re-synced by another (a build-user transport creates it, a
    // devbuild transport updates it). Setting directory mtimes requires
    // ownership, so the second user's rsync -a died with code 23 "failed to
    // set times ... Operation not permitted" (eng-25/OPE-15169). The devcache
    // syncs must omit directory times but KEEP file times — file mtimes are
    // what the incremental quick-check uses, so dropping all times would
    // re-send the whole cache on every run. The per-bot repo mirror is
    // single-user and must stay untouched.
    it("shared cache syncs omit dir times so a second user can re-sync; per-bot sync keeps times", () => {
      const { r, calls } = run(wt);
      assert.equal(r.status, 0, r.stderr);
      const cacheSyncs = calls.split("\n").filter((l) => l.startsWith("RSYNC") && l.includes(":/srv/devcache/"));
      assert.ok(cacheSyncs.length >= 2, `expected the git-wt base and admin-dir syncs, got:\n${calls}`);
      for (const line of cacheSyncs) {
        assert.ok(line.includes("--omit-dir-times"), `shared cache sync must omit dir times:\n${line}`);
        assert.ok(line.includes("--omit-link-times"), `shared cache sync must omit symlink times too:\n${line}`);
        assert.ok(!line.includes("--no-times"), `file times must be kept so incremental sync works:\n${line}`);
      }
      const botSyncs = calls.split("\n").filter((l) => l.startsWith("RSYNC") && l.includes(":/srv/devbuild/bot1/ABC-1/"));
      assert.ok(botSyncs.length >= 1, `expected the per-bot sync, got:\n${calls}`);
      for (const line of botSyncs) {
        assert.ok(!line.includes("--omit-dir-times"), `per-bot sync must keep dir times:\n${line}`);
      }
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


// myrmidon(1.6.9 DEVBUILD-CACHE-TIMES) BEHAVIORAL regression, not an argv
// check: the shared /srv/devcache caches are written by one transport user
// and re-synced by another (eng-25/OPE-15169: rsync code 23 "failed to set
// times ... Operation not permitted"). This suite creates two isolated
// throwaway uids of one shared group, a 0700 bot-volume base, and drives the
// REAL devbuild wrapper (real ssh to 127.0.0.1, real rsync) three times:
// uid1 creates the cache, uid2 re-syncs with diverged directory mtimes and
// mixed ownership, uid1 re-syncs again. Assertions: exit 0 on every pass,
// uid2 can read/write the cache, no world-writeable path appears, FILE
// mtimes stay identical to the source (incremental quick-check intact),
// directory mtimes are not synced (that is exactly what a non-owner cannot
// set), symlinks survive. Requires root (or passwordless sudo) to create
// the isolated users; where that is unavailable (CI runners) the suite
// SKIPS with a reason instead of stubbing the scenario away.
// Root is required: the wrapper resolves the worktree by reading through
// the (0700) base directory, which only its owner can do — in the fleet the
// owner is the bot user running the wrapper. A sudo-capable non-root user
// still cannot model that, so the suite skips unless euid is 0.
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

describe("two-uid shared git cache with real rsync (root-gated)", {
  skip: isRoot ? false : "requires root to create isolated test users; the 0700 source is only readable by its owner",
}, () => {
  const TAG = `dbt${process.pid}`;
  const USER_A = `${TAG}a`;
  const USER_B = `${TAG}b`;
  const GROUP = `${TAG}g`;
  // The cache bot name MUST be unique per test process: parallel root runs
  // on one build host share /srv/devcache/git-wt, and a shared name would let
  // one run's cleanup delete another run's cache. Derived from TAG (already
  // pid-based), so it stays inside the wrapper's [A-Za-z0-9._-] bot-name set.
  const BOT = `${TAG}bot`;
  let tmp;
  let fixture;
  let key;
  let kh;
  let base;      // bare base (the bot-volume source, mode 0700)
  let wt;        // worktree synced by the wrapper
  let hermes;    // HERMES_HOME containing .myrmidon/git-base
  let baseDest;  // DEVBUILD_BASE for the per-bot copy
  let cacheDir;  // /srv/devcache/git-wt/<BOT>/<key>.git (resolved by glob)
  let objectsMtimeBeforePass2;
  let uidB = -1;

  function priv(...args) {
    return spawnSync(args[0], args.slice(1), { encoding: "utf8" });
  }
  function privOk(...args) {
    const r = priv(...args);
    assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}`);
    return r;
  }
  function asUser(user, ...args) {
    return privOk("runuser", "-u", user, "--", ...args);
  }

  function wrapper(user, command) {
    return spawnSync("bash", [DEVBUILD, command], {
      encoding: "utf8",
      env: {
        ...process.env,
        DEVBUILD_HOST: "127.0.0.1",
        DEVBUILD_USER: user,
        DEVBUILD_BASE: baseDest,
        DEVBUILD_BOT_NAME: BOT,
        DEVBUILD_SSH_KEY: key,
        DEVBUILD_KNOWN_HOSTS: kh,
        DEVBUILD_WORKSPACE: wt,
        HERMES_HOME: hermes,
        DEVBUILD_NO_AUTO_INSTALL: "1",
      },
    });
  }

  function assertNoWorldWrite(rootDir) {
    const bad = [];
    const walk = (d) => {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, ent.name);
        const st = fs.lstatSync(p);
        // symlink mode bits are meaningless on Linux (always 0777, ignored by the kernel)
        if (!st.isSymbolicLink() && st.mode & 0o002) bad.push(`${(st.mode & 0o777).toString(8)} ${p}`);
        if (ent.isDirectory()) walk(p);
      }
    };
    walk(rootDir);
    assert.deepEqual(bad, [], `world-writeable paths under ${rootDir}`);
  }

  before(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "devbuild-2uid-")));
    fs.chmodSync(tmp, 0o755); // the transport uids must traverse into the fixture
    fixture = path.join(tmp, "fx");
    fs.mkdirSync(fixture, { recursive: true });
    fs.chmodSync(fixture, 0o755);
    key = path.join(fixture, "id_ed25519");
    kh = path.join(fixture, "known_hosts");
    baseDest = path.join(fixture, "devbase");
    hermes = path.join(fixture, "hermes");

    // two throwaway uids, one shared primary group, homes with a probe key
    privOk("groupadd", GROUP);
    for (const u of [USER_A, USER_B]) {
      // supplementary devcache mirrors the fleet: transport users write the shared caches
      privOk("useradd", "-M", "-d", `/home/${u}`, "-s", "/bin/bash", "-g", GROUP, "-G", "devcache", u);
      privOk("mkdir", "-p", `/home/${u}/.ssh`);
      privOk("chmod", "0750", `/home/${u}`);
      privOk("chown", `${u}:${GROUP}`, `/home/${u}`);
      privOk("chmod", "0700", `/home/${u}/.ssh`);
      privOk("chown", `${u}:${GROUP}`, `/home/${u}/.ssh`);
    }
    uidB = Number(privOk("id", "-u", USER_B).stdout.trim());
    const pub = path.join(fixture, "id_ed25519.pub");
    privOk("ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", key);
    // the wrapper runs as THIS user, not root: it must be able to read the key
    privOk("chown", `${typeof process.getuid === "function" ? process.getuid() : 0}:${typeof process.getgid === "function" ? process.getgid() : 0}`, key, pub);
    privOk("chmod", "0600", key);
    for (const u of [USER_A, USER_B]) {
      privOk("cp", pub, `/home/${u}/.ssh/authorized_keys`);
      privOk("chmod", "0600", `/home/${u}/.ssh/authorized_keys`);
      privOk("chown", `${u}:${GROUP}`, `/home/${u}/.ssh/authorized_keys`);
    }

    // git fixture: seed -> bare base (mode 0700, shared group) + worktree
    const seed = path.join(fixture, "seed");
    fs.mkdirSync(seed);
    git(seed, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(seed, "a.txt"), "a\n");
    git(seed, "add", ".");
    git(seed, "commit", "-q", "-m", "init");
    base = path.join(hermes, ".myrmidon/git-base/owner/repo.git");
    fs.mkdirSync(path.dirname(base), { recursive: true });
    git(fixture, "clone", "-q", "--bare", seed, base);
    wt = path.join(fixture, "ws/ABC-1");
    git(base, "worktree", "add", "-q", "-b", "bot/ABC-1", wt, "main");
    fs.symlinkSync("HEAD", path.join(base, "probe-link"));
    privOk("chown", "-R", `${USER_A}:${GROUP}`, hermes);
    privOk("chmod", "0700", base);
    privOk("mkdir", "-p", baseDest);
    privOk("chown", `root:${GROUP}`, baseDest);
    privOk("chmod", "0770", baseDest);
  });

  after(() => {
    // Always remove ONLY this run's cache root: runs in parallel have
    // different BOT names, and a failure before cacheDir was resolved must
    // not leak the cache dir either.
    priv("rm", "-rf", path.join("/srv/devcache/git-wt", BOT));
    for (const u of [USER_A, USER_B]) priv("userdel", u);
    priv("rm", "-rf", `/home/${USER_A}`, `/home/${USER_B}`);
    priv("groupdel", GROUP);
    // sudo-created entries inside the fixture are owned by other uids
    if (tmp) priv("rm", "-rf", tmp);
  });

  it("uid1 creates, uid2 re-syncs with diverged dir mtimes, uid1 again — all green", { timeout: 240000 }, function () {

    // pass 1: uid1 (the creator) — restrictive 0700 source must not survive
    const p1 = wrapper(USER_A, "git -c safe.directory=* log --oneline -1");
    assert.equal(p1.status, 0, `pass 1 (uid1) failed: ${p1.stderr}`);
    const cacheRoot = path.join("/srv/devcache/git-wt", BOT);
    const keys = fs.readdirSync(cacheRoot).filter((n) => n.endsWith(".git"));
    assert.equal(keys.length, 1, `expected one cache dir, got ${keys}`);
    cacheDir = path.join(cacheRoot, keys[0]);

    // the "remote command" of uid2 wrote into the shared cache: mixed
    // ownership, and directory mtimes now diverge from the source on both
    // sides — the exact conditions of the OPE-15169 failure
    asUser(USER_B, "touch", path.join(cacheDir, "objects/remote-write-probe"));
    // make the divergence second-granularity-obvious: with -a (no
    // --omit-dir-times) the receiver MUST try to set this mtime on uid1's
    // directory and fail with EPERM; --omit-dir-times must not even try
    privOk("touch", "-d", "2000-01-01 00:00:00", path.join(base, "objects"));
    objectsMtimeBeforePass2 = fs.statSync(path.join(cacheDir, "objects")).mtimeMs;
    // production invariant: a bot's per-bot copy is owned by ITS OWN
    // DEVBUILD_USER (bot names are unique per container); only the shared
    // cache crosses users — so hand the dest copy to uid2 like the fleet does
    privOk("chown", "-R", `${USER_B}:${GROUP}`, path.join(baseDest, BOT));

    // pass 2: uid2 re-syncs the cache owned by uid1 — the OPE-15169 case
    const p2 = wrapper(USER_B, "git -c safe.directory=* log --oneline -1");
    assert.equal(p2.status, 0, `pass 2 (uid2) failed: ${p2.stderr}`);

    // DIRECTORY mtimes are not synced: uid2 cannot set them on uid1's dirs
    // (that is what --omit-dir-times buys; plain -a died with code 23 here)
    const objectsMtimeAfterPass2 = fs.statSync(path.join(cacheDir, "objects")).mtimeMs;
    assert.ok(
      Math.abs(objectsMtimeAfterPass2 - objectsMtimeBeforePass2) < 1500,
      "dir mtime was modified by the re-sync — --omit-dir-times is not in effect",
    );

    // uid2 must be able to work inside the cache (after the dir-mtime
    // assertion — this probe itself bumps the directory mtime)
    asUser(USER_B, "sh", "-c", `touch '${cacheDir}/objects/.wprobe' && rm '${cacheDir}/objects/.wprobe'`);

    // no path may become world-writeable
    assertNoWorldWrite(cacheDir);

    // FILE mtimes are kept: the incremental quick-check must keep working
    for (const f of ["HEAD", "config"]) {
      const src = fs.statSync(path.join(base, f)).mtimeMs;
      const dst = fs.statSync(path.join(cacheDir, f)).mtimeMs;
      assert.ok(Math.abs(src - dst) < 1500, `file mtime of ${f} not preserved (src=${src} dst=${dst})`);
    }

    // symlinks survive the cross-user sync
    const lst = fs.lstatSync(path.join(cacheDir, "probe-link"));
    assert.ok(lst.isSymbolicLink(), "probe-link must stay a symlink");
    assert.equal(fs.readlinkSync(path.join(cacheDir, "probe-link")), "HEAD");

    // mixed ownership really is in place (uid2's file inside uid1's tree)
    assert.equal(fs.statSync(path.join(cacheDir, "objects/remote-write-probe")).uid, uidB);

    // pass 3: uid1 again over the now mixed-ownership CACHE. The per-bot
    // copy stays single-writer (that isolation is by design — a bot's dest
    // is owned by its own transport user), so hand it back to uid1 first
    privOk("chown", "-R", `${USER_A}:${GROUP}`, path.join(baseDest, BOT));
    const p3 = wrapper(USER_A, "git -c safe.directory=* log --oneline -1");
    assert.equal(p3.status, 0, `pass 3 (uid1 again) failed: ${p3.stderr}`);
    assertNoWorldWrite(cacheDir);
  });
});

// The shared-cache suite derives its bot name (and cache root) from the
// process id; two parallel root runs on one build host must never collide
// on /srv/devcache/git-wt/<bot>. Locks the naming scheme without a framework.
it("two-uid cache bot name is unique per process and path-safe", () => {
  const mk = (pid) => `dbt${pid}bot`;
  for (const pid of [2, 3, 12345, process.pid, process.pid + 1]) {
    assert.match(mk(pid), /^[A-Za-z0-9._-]+$/);
  }
  assert.notEqual(mk(process.pid), mk(process.pid + 1));
  assert.notEqual(mk(1000), mk(1001));
});
