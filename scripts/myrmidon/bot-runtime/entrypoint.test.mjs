import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// docker/bot-runtime/entrypoint.sh fails fast (before ever reaching `exec
// hermes`, which is not installed in this test environment) when required
// environment is missing or unusable. We only exercise the failure paths:
// the success path execs a real hermes binary this sandbox does not have.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ENTRYPOINT = path.join(ROOT, "docker/bot-runtime/entrypoint.sh");

function run(env) {
  return spawnSync("bash", [ENTRYPOINT], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    encoding: "utf8",
    timeout: 10_000,
  });
}

/** A fresh HERMES_HOME dir, optionally with a .env carrying API_SERVER_KEY. */
function hermesHome(envLine) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myrmidon-bot-runtime-test-"));
  if (envLine !== undefined) {
    fs.writeFileSync(path.join(dir, ".env"), envLine, "utf8");
  }
  return dir;
}

describe("docker/bot-runtime/entrypoint.sh", () => {
  it("fails when HERMES_HOME is unset, before even looking at API_SERVER_KEY", () => {
    const result = run({});
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /HERMES_HOME/);
  });

  it("fails when API_SERVER_KEY is not set anywhere (not in env, no ${HERMES_HOME}/.env)", () => {
    const dir = hermesHome();
    const result = run({ HERMES_HOME: dir });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /API_SERVER_KEY/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("fails when ${HERMES_HOME}/.env exists but has no API_SERVER_KEY line", () => {
    const dir = hermesHome("SOME_OTHER_VAR=1\n");
    const result = run({ HERMES_HOME: dir });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /API_SERVER_KEY/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("fails when the key from ${HERMES_HOME}/.env is shorter than hermes' own 16-char floor", () => {
    const dir = hermesHome('API_SERVER_KEY="short"\n');
    const result = run({ HERMES_HOME: dir });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /at least 16/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("fails when a directly-set API_SERVER_KEY is shorter than hermes' own 16-char floor", () => {
    const dir = hermesHome();
    const result = run({ HERMES_HOME: dir, API_SERVER_KEY: "short" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /at least 16/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("gets past both checks with a valid key read from ${HERMES_HOME}/.env alone (the bot-runtime contract path — no API_SERVER_KEY in the container's own env)", () => {
    const dir = hermesHome(`API_SERVER_KEY="${"a".repeat(32)}"\n`);
    const result = run({ HERMES_HOME: dir });
    // hermes is not on PATH in this test environment — the script must have
    // gotten past its own validation (which logs "FATAL: ..." and exits
    // before the final `exec`) to fail this way instead.
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stderr, /FATAL/);
    assert.match(result.stderr, /hermes/i);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("accepts a .env value with single quotes or no quotes at all, not just double quotes", () => {
    for (const line of [`API_SERVER_KEY='${"b".repeat(32)}'\n`, `API_SERVER_KEY=${"b".repeat(32)}\n`]) {
      const dir = hermesHome(line);
      const result = run({ HERMES_HOME: dir });
      assert.notEqual(result.status, 0);
      assert.doesNotMatch(result.stderr, /FATAL/);
      assert.match(result.stderr, /hermes/i);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gets past both checks with a valid key set directly in the environment (manual/local run, not the fleet driver)", () => {
    const dir = hermesHome();
    const result = run({
      API_SERVER_KEY: "a".repeat(32),
      HERMES_HOME: dir,
    });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stderr, /FATAL/);
    assert.match(result.stderr, /hermes/i);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("prefers a key already in the environment over ${HERMES_HOME}/.env, without touching the file", () => {
    const dir = hermesHome('API_SERVER_KEY="short"\n'); // would fail the length check if read
    const result = run({ HERMES_HOME: dir, API_SERVER_KEY: "c".repeat(32) });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stderr, /FATAL/);
    assert.match(result.stderr, /hermes/i);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// myrmidon(BOT-ROOT-TRAVERSE): an unreachable /bot root must name itself. A host
// directory the bot's uid cannot enter (rc.1: root-owned 0710) makes every path
// under /bot resolve to EACCES; the entrypoint had to fail with a clear traversal
// line, not with the misleading "API_SERVER_KEY is required" from further down.
describe("docker/bot-runtime/entrypoint.sh bot root traversal (BOT-ROOT-TRAVERSE)", () => {
  it("fails with a clear traversal error when the bot root is not executable, not with the API_SERVER_KEY one", () => {
    const tree = fs.mkdtempSync(path.join(os.tmpdir(), "myrmidon-unreach-root-"));
    const bot = path.join(tree, "bot");
    fs.mkdirSync(path.join(bot, "hermes"), { recursive: true });
    fs.writeFileSync(path.join(bot, "hermes", ".env"), `API_SERVER_KEY="${"a".repeat(32)}"\n`);
    const data = path.join(tree, "data");
    fs.mkdirSync(data);
    fs.chmodSync(bot, 0o400); // readable, NOT traversable: the rc.1 shape for uid 10001
    try {
      const result = run({
        HERMES_HOME: path.join(bot, "hermes"),
        MYRMIDON_BOT_ROOT: bot,
        MYRMIDON_DATA_DIR: data,
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /FATAL: no traversal into/);
      assert.match(result.stderr, /recreate the bot/);
      assert.doesNotMatch(result.stderr, /API_SERVER_KEY is required/);
    } finally {
      fs.chmodSync(bot, 0o755);
      fs.rmSync(tree, { recursive: true, force: true });
    }
  });

  it("does not fire the traversal error for a missing root (the old message path stays) nor for a shared member", () => {
    const tree = fs.mkdtempSync(path.join(os.tmpdir(), "myrmidon-missing-root-"));
    try {
      // No /bot at all and no API key: the API_SERVER_KEY error, not the traversal one.
      const result = run({ HERMES_HOME: path.join(tree, "home"), MYRMIDON_BOT_ROOT: path.join(tree, "bot"), MYRMIDON_DATA_DIR: tree });
      assert.notEqual(result.status, 0);
      assert.doesNotMatch(result.stderr, /no traversal into/);
      // A shared member has no /bot: its own checks run instead.
      const shared = run({
        HERMES_HOME: path.join(tree, "home"),
        MYRMIDON_BOT_SCOPE_SUBDIR: "bot-a",
        MYRMIDON_BOT_ROOT: path.join(tree, "bot"),
        MYRMIDON_DATA_DIR: tree,
        API_SERVER_KEY: "k".repeat(32),
      });
      assert.notEqual(shared.status, 0);
      assert.doesNotMatch(shared.stderr, /no traversal into/);
      assert.match(shared.stderr, /does not exist/);
    } finally {
      fs.rmSync(tree, { recursive: true, force: true });
    }
  });
});

// myrmidon(BOT-DISK-D / BOT-DISK-H8b): the bot's tree is ONE mount; the entrypoint links
// /data/<x> into it when the image has not, and proves at every start that a reflink
// (cp --reflink=always) from the pnpm store works into each clone root. The success
// path execs hermes (absent here), so the tests look at what was written before the
// exec, with a stub hermes on PATH.
function stubHermes() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myrmidon-stub-bin-"));
  fs.writeFileSync(path.join(dir, "hermes"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return dir;
}

function runWithStub(env) {
  const bin = stubHermes();
  try {
    return spawnSync("bash", [ENTRYPOINT], {
      env: { PATH: `${env.MYRMIDON_TEST_STUB_BIN ? `${env.MYRMIDON_TEST_STUB_BIN}:` : ""}${bin}:${process.env.PATH}`, HOME: process.env.HOME, ...env },
      encoding: "utf8",
      timeout: 20_000,
      cwd: env.MYRMIDON_TEST_CWD,
    });
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
  }
}

/**
 * A `cp` stub that ACCEPTS --reflink=always (it copies): the success path of the
 * self-check must be provable on runners whose temporary directory has no
 * reflinks (tmpfs, ext4). The real FICLONE is proven by pnpm-reflink.test.mjs
 * and the image build check, which skip with a reason where it cannot run.
 */
function acceptingCpStub() {
  const stub = fs.mkdtempSync(path.join(os.tmpdir(), "myrmidon-cp-ok-"));
  fs.writeFileSync(path.join(stub, "cp"), `#!/bin/sh
for a in "$@"; do shift; [ "$a" = "--reflink=always" ] || set -- "$@" "$a"; done
exec /bin/cp "$@"
`, { mode: 0o755 });
  return stub;
}

/** A /bot-like tree (one directory) with the three clone roots, plus a /data of links. */
function botLayout() {
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), "myrmidon-bot-layout-"));
  const bot = path.join(tree, "bot");
  const data = path.join(tree, "data");
  for (const name of ["hermes", "workspace", "scratch"]) fs.mkdirSync(path.join(bot, name), { recursive: true });
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(bot, "hermes", ".env"), `API_SERVER_KEY="${"k".repeat(32)}"\n`);
  return { tree, bot, data };
}

describe("docker/bot-runtime/entrypoint.sh bot tree layout and reflink self-check", () => {
  it("links /data/<x> into the single mount when they are missing, and leaves existing entries alone", () => {
    const { tree, bot, data } = botLayout();
    try {
      fs.mkdirSync(path.join(data, "scratch")); // an old-layout real directory stays
      const result = runWithStub({
        HERMES_HOME: path.join(bot, "hermes"),
        MYRMIDON_BOT_ROOT: bot,
        MYRMIDON_DATA_DIR: data,
        MYRMIDON_REFLINK_CHECK: "0",
        MYRMIDON_GIT_OBJECTS_CHECK: "0",
        MYRMIDON_TEST_CWD: path.join(bot, "workspace"),
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(fs.readlinkSync(path.join(data, "hermes")), path.join(bot, "hermes"));
      assert.equal(fs.readlinkSync(path.join(data, "workspace")), path.join(bot, "workspace"));
      assert.equal(fs.lstatSync(path.join(data, "scratch")).isDirectory(), true);
      assert.equal(fs.lstatSync(path.join(data, "scratch")).isSymbolicLink(), false);
    } finally {
      fs.rmSync(tree, { recursive: true, force: true });
    }
  });

  it("self-check passes when the store and every clone root share one mount, and reports it", () => {
    const { tree, bot, data } = botLayout();
    const stub = acceptingCpStub();
    try {
      const store = path.join(bot, "workspace", ".pnpm-store");
      const roots = ["hermes", "workspace", "scratch"].map((name) => path.join(bot, name));
      const result = runWithStub({
        MYRMIDON_TEST_STUB_BIN: stub,
        HERMES_HOME: path.join(bot, "hermes"),
        MYRMIDON_BOT_ROOT: bot,
        MYRMIDON_DATA_DIR: data,
        npm_config_store_dir: store,
        MYRMIDON_REFLINK_ROOTS: roots.join(" "),
        MYRMIDON_TEST_CWD: path.join(bot, "workspace"),
        MYRMIDON_GIT_OBJECTS_CHECK: "0",
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /reflink self-check ok/);
      assert.doesNotMatch(result.stderr, /ERROR: reflink/);
      const report = JSON.parse(fs.readFileSync(path.join(bot, "hermes", ".myrmidon", "reflink-check.json"), "utf8"));
      assert.equal(report.ok, true);
      assert.equal(report.method, "reflink");
      assert.equal(report.store, store);
      assert.equal(report.importMethod, "reflink");
      assert.deepEqual(report.roots.map((r) => r.root), roots);
      assert.ok(report.roots.every((r) => r.ok && r.error === null));
      // The probe files are gone.
      for (const dir of [store, ...roots]) {
        assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith(".myrmidon-reflink-probe")), []);
      }
    } finally {
      fs.rmSync(tree, { recursive: true, force: true });
    }
  });

  it("self-check with a fake `cp` that refuses the reflink logs ERROR and reports ok:false (EXDEV/EOPNOTSUPP)", () => {
    const { tree, bot, data } = botLayout();
    // A `cp` stub that fails exactly like `cp --reflink=always` across
    // superblocks (EXDEV) or without reflink support (EOPNOTSUPP) — it refuses
    // whenever --reflink=always is among its arguments.
    const stub = fs.mkdtempSync(path.join(os.tmpdir(), "myrmidon-cp-stub-"));
    fs.writeFileSync(path.join(stub, "cp"), `#!/bin/sh
for a in "$@"; do
  case "$a" in
    --reflink=always) echo "cp: failed to clone '$2': Operation not supported" >&2; exit 1 ;;
  esac
done
exec /bin/cp "$@"
`, { mode: 0o755 });
    try {
      const store = path.join(bot, "workspace", ".pnpm-store");
      const roots = ["hermes", "workspace", "scratch"].map((name) => path.join(bot, name));
      const result = runWithStub({
        HERMES_HOME: path.join(bot, "hermes"),
        MYRMIDON_BOT_ROOT: bot,
        MYRMIDON_DATA_DIR: data,
        npm_config_store_dir: store,
        MYRMIDON_REFLINK_ROOTS: roots.join(" "),
        MYRMIDON_TEST_CWD: path.join(bot, "workspace"),
        MYRMIDON_GIT_OBJECTS_CHECK: "0",
        MYRMIDON_TEST_STUB_BIN: stub,
      });
      assert.equal(result.status, 0, "a failed check never stops the gateway");
      for (const root of roots) {
        assert.match(result.stderr, new RegExp(`ERROR: reflink self-check: cannot reflink from the pnpm store .* into ${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      }
      const report = JSON.parse(fs.readFileSync(path.join(bot, "hermes", ".myrmidon", "reflink-check.json"), "utf8"));
      assert.equal(report.ok, false);
      assert.equal(report.method, "reflink");
      assert.ok(report.roots.every((r) => r.ok === false && /Operation not supported/.test(r.error)));
    } finally {
      fs.rmSync(tree, { recursive: true, force: true });
      fs.rmSync(stub, { recursive: true, force: true });
    }
  });

  it("self-check logs a clear error and reports the root when the store is on another superblock", { skip: false }, (t) => {
    const shm = "/dev/shm";
    let crossDevice = false;
    try {
      fs.accessSync(shm, fs.constants.W_OK);
      crossDevice = fs.statSync(shm).dev !== fs.statSync(os.tmpdir()).dev;
    } catch {
      crossDevice = false;
    }
    if (!crossDevice) {
      t.skip("one filesystem on this runner: no second superblock to provoke EXDEV");
      return;
    }
    const { tree, bot, data } = botLayout();
    const store = fs.mkdtempSync(path.join(shm, "myrmidon-store-"));
    try {
      const roots = ["hermes", "workspace", "scratch"].map((name) => path.join(bot, name));
      const result = runWithStub({
        HERMES_HOME: path.join(bot, "hermes"),
        MYRMIDON_BOT_ROOT: bot,
        MYRMIDON_DATA_DIR: data,
        npm_config_store_dir: store,
        MYRMIDON_REFLINK_ROOTS: roots.join(" "),
        MYRMIDON_TEST_CWD: path.join(bot, "workspace"),
        MYRMIDON_GIT_OBJECTS_CHECK: "0",
      });
      assert.equal(result.status, 0, "a failed check never stops the gateway");
      for (const root of roots) {
        assert.match(result.stderr, new RegExp(`ERROR: reflink self-check: cannot reflink from the pnpm store ${store.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} into ${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      }
      const report = JSON.parse(fs.readFileSync(path.join(bot, "hermes", ".myrmidon", "reflink-check.json"), "utf8"));
      assert.equal(report.ok, false);
      assert.ok(report.roots.every((r) => r.ok === false && /cross-device|Invalid cross-device|not supported/i.test(r.error)));
    } finally {
      fs.rmSync(tree, { recursive: true, force: true });
      fs.rmSync(store, { recursive: true, force: true });
    }
  });

  it("self-check reports an unusable store directory for every root", () => {
    const { tree, bot, data } = botLayout();
    try {
      const blocker = path.join(bot, "workspace", "not-a-dir");
      fs.writeFileSync(blocker, "x");
      const roots = ["hermes", "workspace"].map((name) => path.join(bot, name));
      const result = runWithStub({
        HERMES_HOME: path.join(bot, "hermes"),
        MYRMIDON_BOT_ROOT: bot,
        MYRMIDON_DATA_DIR: data,
        npm_config_store_dir: path.join(blocker, "store"),
        MYRMIDON_REFLINK_ROOTS: roots.join(" "),
        MYRMIDON_TEST_CWD: path.join(bot, "workspace"),
        MYRMIDON_GIT_OBJECTS_CHECK: "0",
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /ERROR: reflink self-check: cannot create a file in the pnpm store/);
      const report = JSON.parse(fs.readFileSync(path.join(bot, "hermes", ".myrmidon", "reflink-check.json"), "utf8"));
      assert.equal(report.ok, false);
      assert.equal(report.roots.length, 2);
    } finally {
      fs.rmSync(tree, { recursive: true, force: true });
    }
  });

  it("the store the check uses is the profile's .env value when it overrides the environment", () => {
    const { tree, bot, data } = botLayout();
    const stub = acceptingCpStub();
    try {
      const store = path.join(bot, "scratch", ".store-from-env-file");
      fs.appendFileSync(path.join(bot, "hermes", ".env"), `npm_config_store_dir="${store}"\nnpm_config_package_import_method=reflink\n`);
      const result = runWithStub({
        MYRMIDON_TEST_STUB_BIN: stub,
        HERMES_HOME: path.join(bot, "hermes"),
        MYRMIDON_BOT_ROOT: bot,
        MYRMIDON_DATA_DIR: data,
        npm_config_store_dir: "/nonexistent/should-not-be-used",
        MYRMIDON_REFLINK_ROOTS: path.join(bot, "workspace"),
        MYRMIDON_TEST_CWD: path.join(bot, "workspace"),
        MYRMIDON_GIT_OBJECTS_CHECK: "0",
      });
      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(fs.readFileSync(path.join(bot, "hermes", ".myrmidon", "reflink-check.json"), "utf8"));
      assert.equal(report.store, store);
      assert.equal(report.ok, true);
    } finally {
      fs.rmSync(tree, { recursive: true, force: true });
    }
  });
});

// myrmidon(1.6.5 BOT-DISK-G): the shared-git-objects self-check. The wrapper
// and its /usr/local/bin shadow are stubbed (the tests run outside the image),
// and the reference-clone round trip runs against the real git of the runner.
describe("docker/bot-runtime/entrypoint.sh shared-git-objects self-check", () => {
  const realGit = () => spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  /** A bin dir with a fake `git` wrapper that answers --version, and a shadow symlink. */
  function wrapperStub() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myrmidon-gitstub-"));
    const wrapper = path.join(dir, "opt-paperclip-git");
    fs.writeFileSync(wrapper, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'git version stub'; exit 0; fi\nexec git \"$@\"\n", { mode: 0o755 });
    const shadowDir = path.join(dir, "shadow");
    fs.mkdirSync(shadowDir);
    fs.symlinkSync(wrapper, path.join(shadowDir, "git"));
    return { dir, wrapper, shadow: path.join(shadowDir, "git") };
  }

  /**
   * The real shared-objects wrapper, as the image installs it as
   * /opt/paperclip/bin/git. The store checks must see the wrapper a bot
   * actually runs, not a pass-through stub. Copied out of the repository (so
   * node reads it as CJS, as the image's /opt/paperclip copy is) and reached
   * through a shim, so the test needs no /opt/node24.
   */
  function realWrapperStub() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myrmidon-gitreal-"));
    const copy = path.join(dir, "git-wrapper.cjs");
    fs.copyFileSync(path.join(ROOT, "docker/bot-runtime/git-reference/git"), copy);
    const wrapper = path.join(dir, "opt-paperclip-git");
    fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${copy}" "$@"\n`, { mode: 0o755 });
    const shadowDir = path.join(dir, "shadow");
    fs.mkdirSync(shadowDir);
    fs.symlinkSync(wrapper, path.join(shadowDir, "git"));
    return { dir, wrapper, shadow: path.join(shadowDir, "git") };
  }

  /** Mirrors currently in the bot's store, as the check counts them. */
  function findMirrors(bot) {
    const store = path.join(bot, "hermes", ".myrmidon", "git-objects");
    if (!fs.existsSync(store)) return [];
    return fs.readdirSync(store, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .flatMap((owner) => fs.readdirSync(path.join(store, owner.name))
        .filter((name) => name.endsWith(".git"))
        .map((name) => `${owner.name}/${name}`));
  }

  /** A task clone of a GitHub repository, as /workspace/<TICKET>/repo holds it. */
  function taskClone(bot, ticket, url) {
    const clone = path.join(bot, "workspace", ticket, "repo");
    fs.mkdirSync(clone, { recursive: true });
    for (const args of [["init", "-q", "-b", "main"], ["remote", "add", "origin", url]]) {
      const result = spawnSync(realGit(), args, { cwd: clone, encoding: "utf8" });
      assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
    }
    return clone;
  }

  it("passes every check and reports them", () => {
    const { tree, bot, data } = botLayout();
    const stub = realWrapperStub();
    try {
      const result = runWithStub({
        HERMES_HOME: path.join(bot, "hermes"),
        MYRMIDON_BOT_ROOT: bot,
        MYRMIDON_DATA_DIR: data,
        MYRMIDON_REFLINK_CHECK: "0",
        MYRMIDON_GIT_WRAPPER: stub.wrapper,
        MYRMIDON_GIT_SHADOW: stub.shadow,
        MYRMIDON_GIT_REAL: realGit(),
        MYRMIDON_TASK_ROOTS: path.join(bot, "workspace"),
        MYRMIDON_TEST_CWD: path.join(bot, "workspace"),
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /shared-objects self-check ok/);
      const report = JSON.parse(fs.readFileSync(path.join(bot, "hermes", ".myrmidon", "git-objects-check.json"), "utf8"));
      assert.equal(report.ok, true);
      assert.equal(report.store, path.join(bot, "hermes", ".myrmidon", "git-objects"));
      assert.deepEqual(report.checks.map((c) => c.check), ["usr-local-shadow", "wrapper-runs", "store-writable", "reference-clone", "store-fills", "store-in-use"]);
      assert.ok(report.checks.every((c) => c.ok && c.error === null));
      // The store-fills probe borrows the store and leaves nothing behind.
      assert.deepEqual(findMirrors(bot), []);
    } finally {
      fs.rmSync(tree, { recursive: true, force: true });
      fs.rmSync(stub.dir, { recursive: true, force: true });
    }
  });

  it("a missing shadow reports usr-local-shadow failed but never stops the gateway", () => {
    const { tree, bot, data } = botLayout();
    const stub = wrapperStub();
    try {
      const result = runWithStub({
        HERMES_HOME: path.join(bot, "hermes"),
        MYRMIDON_BOT_ROOT: bot,
        MYRMIDON_DATA_DIR: data,
        MYRMIDON_REFLINK_CHECK: "0",
        MYRMIDON_GIT_WRAPPER: stub.wrapper,
        MYRMIDON_GIT_SHADOW: path.join(stub.dir, "no-shadow", "git"),
        MYRMIDON_GIT_REAL: realGit(),
        MYRMIDON_TEST_CWD: path.join(bot, "workspace"),
      });
      assert.equal(result.status, 0, "a failed check never stops the gateway");
      assert.match(result.stderr, /ERROR: shared-objects self-check failed/);
      const report = JSON.parse(fs.readFileSync(path.join(bot, "hermes", ".myrmidon", "git-objects-check.json"), "utf8"));
      assert.equal(report.ok, false);
      const shadow = report.checks.find((c) => c.check === "usr-local-shadow");
      assert.equal(shadow.ok, false);
      assert.match(shadow.error, /does not shadow git/);
    } finally {
      fs.rmSync(tree, { recursive: true, force: true });
      fs.rmSync(stub.dir, { recursive: true, force: true });
    }
  });

  it("skips the whole check when there is no wrapper (the base image)", () => {
    const { tree, bot, data } = botLayout();
    try {
      const result = runWithStub({
        HERMES_HOME: path.join(bot, "hermes"),
        MYRMIDON_BOT_ROOT: bot,
        MYRMIDON_DATA_DIR: data,
        MYRMIDON_REFLINK_CHECK: "0",
        MYRMIDON_GIT_WRAPPER: path.join(tree, "no-such-wrapper"),
        MYRMIDON_TEST_CWD: path.join(bot, "workspace"),
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /no git wrapper at .* — skipped/);
      assert.ok(!fs.existsSync(path.join(bot, "hermes", ".myrmidon", "git-objects-check.json")));
    } finally {
      fs.rmSync(tree, { recursive: true, force: true });
    }
  });

  it("an explicit empty MYRMIDON_GIT_LOCAL_MIRROR records the store as off and passes", () => {
    const { tree, bot, data } = botLayout();
    const stub = wrapperStub();
    try {
      const result = runWithStub({
        HERMES_HOME: path.join(bot, "hermes"),
        MYRMIDON_BOT_ROOT: bot,
        MYRMIDON_DATA_DIR: data,
        MYRMIDON_REFLINK_CHECK: "0",
        MYRMIDON_GIT_WRAPPER: stub.wrapper,
        MYRMIDON_GIT_SHADOW: stub.shadow,
        MYRMIDON_GIT_REAL: realGit(),
        MYRMIDON_GIT_LOCAL_MIRROR: "",
        MYRMIDON_TEST_CWD: path.join(bot, "workspace"),
      });
      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(fs.readFileSync(path.join(bot, "hermes", ".myrmidon", "git-objects-check.json"), "utf8"));
      assert.equal(report.ok, true);
      assert.equal(report.store, "");
    } finally {
      fs.rmSync(tree, { recursive: true, force: true });
      fs.rmSync(stub.dir, { recursive: true, force: true });
    }
  });

  // myrmidon(1.6.5 BOT-DISK-G-A): the incident's state — live task clones and an
  // empty store. The old check went green on it: its reference-clone round trip
  // ran in a scratch directory and left the store empty either way.
  it("catches a store that live task clones never filled", () => {
    const { tree, bot, data } = botLayout();
    const stub = realWrapperStub();
    try {
      const clone = taskClone(bot, "OPE-1", "https://github.com/owner/repo.git");
      const result = runWithStub({
        HERMES_HOME: path.join(bot, "hermes"),
        MYRMIDON_BOT_ROOT: bot,
        MYRMIDON_DATA_DIR: data,
        MYRMIDON_REFLINK_CHECK: "0",
        MYRMIDON_GIT_WRAPPER: stub.wrapper,
        MYRMIDON_GIT_SHADOW: stub.shadow,
        MYRMIDON_GIT_REAL: realGit(),
        MYRMIDON_TASK_ROOTS: path.join(bot, "workspace"),
        MYRMIDON_TEST_CWD: path.join(bot, "workspace"),
      });
      assert.equal(result.status, 0, "a failed check never stops the gateway");
      assert.match(result.stderr, /ERROR: shared-objects self-check failed/);
      const report = JSON.parse(fs.readFileSync(path.join(bot, "hermes", ".myrmidon", "git-objects-check.json"), "utf8"));
      assert.equal(report.ok, false);
      // The wrapper's own field-shaped clone does fill the store…
      assert.equal(report.checks.find((c) => c.check === "store-fills").ok, true);
      // …but nothing on this bot ever borrowed it: that is the incident.
      const inUse = report.checks.find((c) => c.check === "store-in-use");
      assert.equal(inUse.ok, false);
      assert.match(inUse.error, /1 GitHub task clone\(s\)/);
      assert.match(inUse.error, /OPE-1/);
      assert.deepEqual(findMirrors(bot), [], "the probe does not leave a mirror behind");
      assert.ok(fs.existsSync(clone));
    } finally {
      fs.rmSync(tree, { recursive: true, force: true });
      fs.rmSync(stub.dir, { recursive: true, force: true });
    }
  });

  it("a store that a task clone did use passes", () => {
    const { tree, bot, data } = botLayout();
    const stub = realWrapperStub();
    try {
      taskClone(bot, "OPE-2", "https://github.com/owner/repo.git");
      fs.mkdirSync(path.join(bot, "hermes", ".myrmidon", "git-objects", "owner", "repo.git", "objects"), { recursive: true });
      const result = runWithStub({
        HERMES_HOME: path.join(bot, "hermes"),
        MYRMIDON_BOT_ROOT: bot,
        MYRMIDON_DATA_DIR: data,
        MYRMIDON_REFLINK_CHECK: "0",
        MYRMIDON_GIT_WRAPPER: stub.wrapper,
        MYRMIDON_GIT_SHADOW: stub.shadow,
        MYRMIDON_GIT_REAL: realGit(),
        MYRMIDON_TASK_ROOTS: path.join(bot, "workspace"),
        MYRMIDON_TEST_CWD: path.join(bot, "workspace"),
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /shared-objects self-check ok/);
      const report = JSON.parse(fs.readFileSync(path.join(bot, "hermes", ".myrmidon", "git-objects-check.json"), "utf8"));
      assert.equal(report.ok, true);
      assert.equal(report.checks.find((c) => c.check === "store-in-use").ok, true);
      // A live clone that is not a GitHub one is not the store's business.
      assert.deepEqual(findMirrors(bot), ["owner/repo.git"]);
    } finally {
      fs.rmSync(tree, { recursive: true, force: true });
      fs.rmSync(stub.dir, { recursive: true, force: true });
    }
  });

  // myrmidon(1.6.5 BOT-DISK-G live check, OPE-5281 ч.B): the store's FACTS, not
  // only the checks. The board's live acceptance ("the store is not empty", "the
  // second clone borrows from it") reads storeState, which the reporter passes on
  // and the server parses — without an exec into the bot.
  function gitStoreStateOf(bot) {
    const report = JSON.parse(fs.readFileSync(path.join(bot, "hermes", ".myrmidon", "git-objects-check.json"), "utf8"));
    return report.storeState;
  }

  it("records a store that holds no mirror as empty, so acceptance can see the gap", () => {
    const { tree, bot, data } = botLayout();
    const stub = wrapperStub();
    try {
      const result = runWithStub({
        HERMES_HOME: path.join(bot, "hermes"),
        MYRMIDON_BOT_ROOT: bot,
        MYRMIDON_DATA_DIR: data,
        MYRMIDON_REFLINK_CHECK: "0",
        MYRMIDON_GIT_WRAPPER: stub.wrapper,
        MYRMIDON_GIT_SHADOW: stub.shadow,
        MYRMIDON_GIT_REAL: realGit(),
        MYRMIDON_TEST_CWD: path.join(bot, "workspace"),
      });
      assert.equal(result.status, 0, result.stderr);
      const state = gitStoreStateOf(bot);
      assert.equal(state.enabled, true);
      assert.equal(state.path, path.join(bot, "hermes", ".myrmidon", "git-objects"));
      assert.equal(state.mirrorCount, 0);
      assert.equal(state.totalBytes, 0);
      assert.deepEqual(state.repos, []);
    } finally {
      fs.rmSync(tree, { recursive: true, force: true });
      fs.rmSync(stub.dir, { recursive: true, force: true });
    }
  });

  it("records every mirror of the store as owner/repo, and never a junk directory", () => {
    const { tree, bot, data } = botLayout();
    const stub = wrapperStub();
    const store = path.join(bot, "hermes", ".myrmidon", "git-objects");
    // One real mirror (objects/ + HEAD, the wrapper's isMirror test) and two
    // directories that only look like one.
    for (const dir of [
      path.join(store, "itkadr-git", "myrmidon.git", "objects"),
      path.join(store, "itkadr-git", "other.git", "objects"),
    ]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(path.join(store, "itkadr-git", "myrmidon.git", "objects", "pack-x.pack"), "pack");
    fs.writeFileSync(path.join(store, "itkadr-git", "myrmidon.git", "HEAD"), "ref: refs/heads/main\n");
    fs.mkdirSync(path.join(store, "owner"), { recursive: true }); // no *.git at all
    try {
      const result = runWithStub({
        HERMES_HOME: path.join(bot, "hermes"),
        MYRMIDON_BOT_ROOT: bot,
        MYRMIDON_DATA_DIR: data,
        MYRMIDON_REFLINK_CHECK: "0",
        MYRMIDON_GIT_WRAPPER: stub.wrapper,
        MYRMIDON_GIT_SHADOW: stub.shadow,
        MYRMIDON_GIT_REAL: realGit(),
        MYRMIDON_TEST_CWD: path.join(bot, "workspace"),
      });
      assert.equal(result.status, 0, result.stderr);
      const state = gitStoreStateOf(bot);
      assert.equal(state.mirrorCount, 1, "only the mirror with objects/ and HEAD counts");
      assert.deepEqual(state.repos, ["itkadr-git/myrmidon"]);
      assert.ok(state.totalBytes > 0, `the store size is reported, got ${state.totalBytes}`);
    } finally {
      fs.rmSync(tree, { recursive: true, force: true });
      fs.rmSync(stub.dir, { recursive: true, force: true });
    }
  });
});

// myrmidon(BOT-DISK-F): a member of a shared isolation-scope instance. The instance directory is
// its one mount; /data is a tmpfs of links the entrypoint makes into the member's own
// subdirectory, and the pnpm store sits in the instance directory next to every member.
describe("docker/bot-runtime/entrypoint.sh shared scope member", () => {
  function scopeLayout() {
    const tree = fs.mkdtempSync(path.join(os.tmpdir(), "myrmidon-scope-layout-"));
    const scope = path.join(tree, "bot-scope");
    const data = path.join(tree, "data");
    for (const bot of ["bot-a", "bot-b"]) {
      for (const name of ["hermes", "workspace", "scratch"]) fs.mkdirSync(path.join(scope, bot, name), { recursive: true });
    }
    fs.mkdirSync(data);
    fs.writeFileSync(path.join(scope, "bot-a", "hermes", ".env"), `API_SERVER_KEY="${"k".repeat(32)}"\n`);
    return { tree, scope, data };
  }

  it("links /data/<x> into its own subdirectory, reads the key through the link, and starts", () => {
    const { tree, scope, data } = scopeLayout();
    try {
      const result = runWithStub({
        HERMES_HOME: path.join(data, "hermes"),
        MYRMIDON_BOT_SCOPE_DIR: scope,
        MYRMIDON_BOT_SCOPE_SUBDIR: "bot-a",
        MYRMIDON_DATA_DIR: data,
        MYRMIDON_REFLINK_CHECK: "0",
        MYRMIDON_GIT_OBJECTS_CHECK: "0",
        MYRMIDON_TEST_CWD: tree,
        MYRMIDON_WORKSPACE_DIR: path.join(data, "workspace"),
      });
      assert.equal(result.status, 0, result.stderr);
      for (const name of ["hermes", "workspace", "scratch"]) {
        assert.equal(fs.readlinkSync(path.join(data, name)), path.join(scope, "bot-a", name));
      }
      assert.match(result.stderr, /shared scope member/);
      // the other member's tree is not linked or touched
      assert.deepEqual(fs.readdirSync(path.join(scope, "bot-b", "hermes")), []);
    } finally {
      fs.rmSync(tree, { recursive: true, force: true });
    }
  });

  it("reflinks work from the instance store into the member's clone roots AND into another member's", () => {
    const { tree, scope, data } = scopeLayout();
    const stub = acceptingCpStub();
    try {
      const store = path.join(scope, ".pnpm-store");
      const other = path.join(scope, "bot-b", "workspace");
      const result = runWithStub({
        MYRMIDON_TEST_STUB_BIN: stub,
        HERMES_HOME: path.join(data, "hermes"),
        MYRMIDON_BOT_SCOPE_DIR: scope,
        MYRMIDON_BOT_SCOPE_SUBDIR: "bot-a",
        MYRMIDON_DATA_DIR: data,
        npm_config_store_dir: store,
        MYRMIDON_REFLINK_ROOTS: [path.join(data, "hermes"), path.join(data, "workspace"), path.join(data, "scratch"), other].join(" "),
        MYRMIDON_GIT_OBJECTS_CHECK: "0",
        MYRMIDON_TEST_CWD: tree,
        MYRMIDON_WORKSPACE_DIR: path.join(data, "workspace"),
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /reflink self-check ok/);
      const report = JSON.parse(fs.readFileSync(path.join(scope, "bot-a", "hermes", ".myrmidon", "reflink-check.json"), "utf8"));
      assert.equal(report.ok, true);
      assert.equal(report.store, store);
      assert.equal(report.roots.length, 4);
    } finally {
      fs.rmSync(tree, { recursive: true, force: true });
    }
  });

  it("fails fast when the instance directory is not mounted or the subdirectory is missing", () => {
    const { tree, scope, data } = scopeLayout();
    try {
      const base = { HERMES_HOME: path.join(data, "hermes"), MYRMIDON_DATA_DIR: data, MYRMIDON_REFLINK_CHECK: "0",
        MYRMIDON_GIT_OBJECTS_CHECK: "0", API_SERVER_KEY: "k".repeat(32) };
      const missing = run({ ...base, MYRMIDON_BOT_SCOPE_DIR: path.join(tree, "nowhere"), MYRMIDON_BOT_SCOPE_SUBDIR: "bot-a" });
      assert.notEqual(missing.status, 0);
      assert.match(missing.stderr, /does not exist/);
      const noSub = run({ ...base, MYRMIDON_BOT_SCOPE_DIR: scope, MYRMIDON_BOT_SCOPE_SUBDIR: "bot-z" });
      assert.notEqual(noSub.status, 0);
      assert.match(noSub.stderr, /does not exist/);
    } finally {
      fs.rmSync(tree, { recursive: true, force: true });
    }
  });

  it("refuses a subdirectory name that could leave the instance directory", () => {
    const { tree, scope, data } = scopeLayout();
    try {
      for (const bad of ["../bot-b", "a/b", "..", "-x"]) {
        const result = run({
          HERMES_HOME: path.join(data, "hermes"),
          MYRMIDON_DATA_DIR: data,
          MYRMIDON_BOT_SCOPE_DIR: scope,
          MYRMIDON_BOT_SCOPE_SUBDIR: bad,
          API_SERVER_KEY: "k".repeat(32),
        });
        assert.notEqual(result.status, 0, bad);
        assert.match(result.stderr, /not a plain directory name/, bad);
      }
    } finally {
      fs.rmSync(tree, { recursive: true, force: true });
    }
  });
});
