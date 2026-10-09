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

// A stub hermes on PATH lets the success path run to the exec: the probe
// records the umask it inherited from the entrypoint instead of starting a
// gateway.
function runWithStub(env, probeDir) {
  const bin = probeDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "myrmidon-stub-bin-"));
  // A caller-supplied probe directory may already carry its own hermes script
  // (the umask probe) — never clobber it.
  if (!fs.existsSync(path.join(bin, "hermes"))) {
    fs.writeFileSync(path.join(bin, "hermes"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  try {
    return spawnSync("bash", [ENTRYPOINT], {
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: process.env.HOME, ...env },
      encoding: "utf8",
      timeout: 20_000,
    });
  } finally {
    if (!probeDir) fs.rmSync(bin, { recursive: true, force: true });
  }
}

// myrmidon(BOT-UMASK): run files must be owner-only — every bot on a host shares
// uid 10001, so the mode bits are the only barrier between one run's scratch/cache
// and another bot's processes. The entrypoint sets umask 077 before any file write
// and every child (gateway -> session -> terminal/tool) inherits it.
describe("docker/bot-runtime/entrypoint.sh umask 077", () => {
  it("sets umask 077 before the first file write", () => {
    const source = fs.readFileSync(ENTRYPOINT, "utf8");
    const umaskAt = source.search(/^umask 077$/m);
    assert.notEqual(umaskAt, -1, "entrypoint must set umask 077");
    const firstWrite = source.search(/^\s*(mkdir|ln |ln\b|cat >|>|install )/m);
    assert.notEqual(firstWrite, -1, "test expects a file write to anchor against");
    assert.ok(
      umaskAt < firstWrite,
      "umask 077 must precede the first file write in the entrypoint",
    );
    assert.match(source, /umask 077 \(run files owner-only\)/);
  });

  it("the process the entrypoint execs inherits umask 077 (files 0600, dirs 0700)", () => {
    const tree = fs.mkdtempSync(path.join(os.tmpdir(), "myrmidon-bot-umask-"));
    try {
      const hermesHomeDir = path.join(tree, "hermes-home");
      fs.mkdirSync(hermesHomeDir);
      fs.writeFileSync(
        path.join(hermesHomeDir, ".env"),
        `API_SERVER_KEY="${"k".repeat(32)}"\n`,
        "utf8",
      );
      // The probe stands in for the real hermes binary: it records the umask it
      // inherited from the entrypoint and creates one file and one directory,
      // which is what every run artifact does.
      const probe = path.join(tree, "probe");
      fs.mkdirSync(probe);
      fs.writeFileSync(
        path.join(probe, "hermes"),
        `#!/bin/sh\numask > "${probe}/umask-value"\n: > "${probe}/probe-file"\nmkdir "${probe}/probe-dir"\n`,
        { mode: 0o755 },
      );
      const result = runWithStub({ HERMES_HOME: hermesHomeDir }, probe);
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(
        fs.readFileSync(path.join(probe, "umask-value"), "utf8").trim(),
        "0077",
        `expected the exec target to inherit umask 0077: ${result.stderr}`,
      );
      assert.equal(fs.statSync(path.join(probe, "probe-file")).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.join(probe, "probe-dir")).mode & 0o777, 0o700);
    } finally {
      fs.rmSync(tree, { recursive: true, force: true });
    }
  });

});
