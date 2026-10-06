import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// Runs the real install.sh against fake `docker`, `curl`, `ss`, `systemctl` and
// `apt-get` placed first in PATH. The fakes log every call and answer from files
// in the sandbox: no test touches GitHub, a registry or a docker daemon.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INSTALL = path.join(HERE, "install.sh");
const A = `sha256:${"a".repeat(64)}`;
const B = `sha256:${"b".repeat(64)}`;
const C = `sha256:${"c".repeat(64)}`;

const FAKE_DOCKER = `#!/usr/bin/env bash
printf 'docker %s\\n' "$*" >> "$SANDBOX/calls.log"
case "$*" in
  "compose version") echo "Docker Compose version v2.30.0"; exit 0 ;;
  *"network inspect"*) exit 0 ;;
  *"network create"*) exit 0 ;;
  *pg_dump*) echo "PGDUMP-FAKE-CONTENT"; exit 0 ;;
  *"ps -q"*) if [ -f "$SANDBOX/up" ]; then echo "c0ffee"; fi; exit 0 ;;
esac
exit 0
`;

const FAKE_CURL = `#!/usr/bin/env bash
url=""; out=""
while (($#)); do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -H|--retry|--retry-delay|--max-time) shift 2 ;;
    -f|-s|-S|-L|-fsS|-fsSL) shift ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
TAG="$(cat "$SANDBOX/tag" 2>/dev/null || echo myr-v1.6.6)"
VERSION="\${TAG#myr-v}"
BOARD="$(cat "$SANDBOX/board-digest" 2>/dev/null || echo ${A})"
 [ -n "$url" ] && printf '%s\\n' "$url" >> "$SANDBOX/curl.log"
if [ -f "$SANDBOX/broken-manifest" ]; then
  MANIFEST=\'{"schema":1,"version":"\'"$VERSION"\'","tag":"\'"$TAG"\'","components":{"dockergate":{"repository":"ghcr.io/itkadr-git/myrmidon-dockergate","digest":"${B}"}}}\'
else
  # The shape the release really publishes (structure identical to
  # releases/download/myr-v1.6.5-rc.2/release-components.json): a component is
  # an object {repository,digest}, not a bare digest string.
  MANIFEST=\'{"schema":1,"version":"\'"$VERSION"\'","tag":"\'"$TAG"\'","components":{"board":{"repository":"ghcr.io/itkadr-git/myrmidon","digest":"\'"$BOARD"\'"},"dockergate":{"repository":"ghcr.io/itkadr-git/myrmidon-dockergate","digest":"${B}"},"hermes":{"repository":"ghcr.io/itkadr-git/myrmidon-hermes","digest":"${C}"}}}\'
fi
case "$url" in
  */releases/latest/download/release-components.json) body="$MANIFEST" ;;
  */releases/download/*/release-components.json) body="$MANIFEST" ;;
  */releases/latest) body="Location: https://github.com/itkadr-git/myrmidon/releases/tag/$TAG" ;;
  */api/health)
    n=0; [ -f "$SANDBOX/health-calls" ] && n="$(cat "$SANDBOX/health-calls")"
    if [ -f "$SANDBOX/health-fail-until" ] && [ "$n" -lt "$(cat "$SANDBOX/health-fail-until")" ]; then
      body='{"status":"starting"}'
    else
      body='{"status":"ok"}'
    fi
    echo "$((n+1))" > "$SANDBOX/health-calls" ;;
  *) body='{}' ;;
esac
if [ -n "$out" ]; then printf '%s' "$body" > "$out"; else printf '%s' "$body"; fi
exit 0
`;

const FAKE_NOOP = "#!/usr/bin/env bash\nexit 0\n";

function sandbox({ tag = "myr-v1.6.6", board = A, up = false, osRelease = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myrmidon-install-test-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  for (const [name, body] of [
    ["docker", FAKE_DOCKER],
    ["curl", FAKE_CURL],
    ["ss", FAKE_NOOP],
    ["systemctl", FAKE_NOOP],
    ["apt-get", FAKE_NOOP],
  ]) {
    fs.writeFileSync(path.join(bin, name), body, { mode: 0o755 });
  }
  fs.writeFileSync(path.join(dir, "tag"), tag);
  fs.writeFileSync(path.join(dir, "board-digest"), board);
  if (up) fs.writeFileSync(path.join(dir, "up"), "");
  return { dir, bin, opt: path.join(dir, "opt"), osRelease };
}

function run(sb, args = [], env = {}) {
  return spawnSync("bash", [INSTALL, "--dir", sb.opt, ...args], {
    cwd: sb.dir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${sb.bin}:${process.env.PATH}`,
      SANDBOX: sb.dir,
      MYRMIDON_INSTALL_SKIP_ROOT_CHECK: "1",
      MYRMIDON_INSTALL_LANG: "en",
      MYRMIDON_INSTALL_HEALTH_TIMEOUT: "5",
      ...env,
    },
  });
}

const calls = (sb) => (fs.existsSync(path.join(sb.dir, "calls.log")) ? fs.readFileSync(path.join(sb.dir, "calls.log"), "utf8") : "");
const envFile = (sb) => fs.readFileSync(path.join(sb.opt, "deploy.env"), "utf8");

describe("install.sh", () => {
  it("installs a fresh stack: pins the release digests, writes the secrets and starts the services", () => {
    const sb = sandbox();
    const r = run(sb);
    assert.equal(r.status, 0, r.stderr);
    const env = envFile(sb);
    assert.match(env, new RegExp(`MYRMIDON_BOARD_DIGEST=${A}`));
    assert.match(env, /MYRMIDON_VERSION=1\.6\.6/);
    assert.match(env, /POSTGRES_PASSWORD=[0-9a-f]{48}/);
    assert.match(env, /BETTER_AUTH_SECRET=[0-9a-f]{64}/);
    assert.equal(fs.statSync(path.join(sb.opt, "deploy.env")).mode & 0o777, 0o600);
    const compose = fs.readFileSync(path.join(sb.opt, "compose.yml"), "utf8");
    assert.ok(
      compose.includes("${MYRMIDON_BOARD_REPOSITORY:?the board repository must be set}@${MYRMIDON_BOARD_DIGEST:?the board digest must be set}"),
      "the board image reference is built from the manifest repository and digest",
    );
    const config = JSON.parse(fs.readFileSync(path.join(sb.opt, "dockergate", "config.json"), "utf8"));
    assert.deepEqual(config.images, [`ghcr.io/itkadr-git/myrmidon-hermes@${C}`]);
    assert.equal(config.caller.mode, "container-main-process");
    assert.ok(calls(sb).includes("pull --quiet"));
    assert.ok(calls(sb).includes("up -d"));
    assert.match(r.stdout, /first account becomes the administrator/);
    // The release is read over the public download endpoints: the anonymous
    // GitHub API (60 requests per hour per IP) must not appear on this path.
    const urls = fs.readFileSync(path.join(sb.dir, "curl.log"), "utf8");
    assert.ok(urls.includes("/releases/latest/download/release-components.json"), urls);
    assert.ok(!urls.includes("api.github.com"), `no anonymous API call expected, got: ${urls}`);
  });

  it("refuses a manifest that does not name a board digest", () => {
    const sb = sandbox();
    fs.writeFileSync(path.join(sb.dir, "broken-manifest"), "");
    const r = run(sb);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /names no board image digest/);
  });

  it("re-running against a newer release dumps the database and switches the digests", () => {
    const sb = sandbox();
    assert.equal(run(sb).status, 0);
    fs.writeFileSync(path.join(sb.dir, "up"), "");
    fs.writeFileSync(path.join(sb.dir, "tag"), "myr-v1.6.7");
    fs.writeFileSync(path.join(sb.dir, "board-digest"), `sha256:${"d".repeat(64)}`);
    const r = run(sb);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(calls(sb).includes("pg_dump"), "the pre-update dump must run before the image changes");
    assert.match(envFile(sb), /MYRMIDON_VERSION=1\.6\.7/);
    assert.match(envFile(sb), new RegExp(`MYRMIDON_BOARD_DIGEST=sha256:${"d".repeat(64)}`));
    const dumps = fs.readdirSync(path.join(sb.opt, "state"));
    assert.equal(dumps.length, 1, "exactly one pre-update dump");
  });

  it("rolls a board that does not become healthy back to the previous digests", () => {
    const sb = sandbox();
    assert.equal(run(sb).status, 0);
    fs.writeFileSync(path.join(sb.dir, "up"), "");
    fs.writeFileSync(path.join(sb.dir, "tag"), "myr-v1.6.9");
    fs.writeFileSync(path.join(sb.dir, "board-digest"), `sha256:${"f".repeat(64)}`);
    // The new board never answers; the rolled-back one does.
    fs.writeFileSync(path.join(sb.dir, "health-fail-until"), "2");
    const r = run(sb);
    assert.equal(r.status, 1, "an update that ends on a rollback is a failure");
    assert.match(r.stderr, /rolling back to the previous digests/);
    assert.match(envFile(sb), /MYRMIDON_VERSION=1\.6\.6/);
    assert.match(envFile(sb), new RegExp(`MYRMIDON_BOARD_DIGEST=${A}`));
    const ups = calls(sb).split("\n").filter((l) => l.includes("up -d"));
    assert.equal(ups.length, 3, "install, failed switch and rollback each recreate the stack");
  });

  it("does nothing when the running release is already the latest", () => {
    const sb = sandbox();
    assert.equal(run(sb).status, 0);
    fs.writeFileSync(path.join(sb.dir, "up"), "");
    const before = calls(sb).split("\n").filter((l) => l.includes("up -d")).length;
    const r = run(sb);
    assert.equal(r.status, 0, r.stderr);
    const after = calls(sb).split("\n").filter((l) => l.includes("up -d")).length;
    assert.equal(after, before, "the stack is not recreated for a release that already runs");
    assert.ok(!calls(sb).split("\n").slice(-4).some((l) => l.includes("pull")), "nothing is pulled");
    assert.match(r.stderr, /nothing to change/);
  });

  it("refuses a directory that this installer did not create", () => {
    const sb = sandbox();
    fs.mkdirSync(sb.opt, { recursive: true });
    fs.writeFileSync(path.join(sb.opt, "someone-elses-file"), "keep me");
    const r = run(sb);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /carries no .myrmidon-install stamp/);
    assert.equal(fs.readFileSync(path.join(sb.opt, "someone-elses-file"), "utf8"), "keep me");
  });

  it("uninstall --purge removes the stack and the directory; without --purge the data stays", () => {
    const sb = sandbox();
    assert.equal(run(sb).status, 0);
    fs.writeFileSync(path.join(sb.dir, "up"), "");
    const plain = run(sb, ["--uninstall"]);
    assert.equal(plain.status, 0, plain.stderr);
    assert.ok(fs.existsSync(sb.opt), "without --purge the directory is kept");
    assert.ok(calls(sb).includes("down"));
    const purged = run(sb, ["--uninstall", "--purge"]);
    assert.equal(purged.status, 0, purged.stderr);
    assert.equal(fs.existsSync(sb.opt), false);
  });

  it("speaks Russian when the locale says so", () => {
    const sb = sandbox();
    const r = run(sb, [], { MYRMIDON_INSTALL_LANG: "ru" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Первый администратор/);
  });

  it("accepts an explicit --version and refuses a malformed one", () => {
    const sb = sandbox();
    fs.writeFileSync(path.join(sb.dir, "tag"), "myr-v1.6.7");
    const ok = run(sb, ["--version", "myr-v1.6.7"]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(envFile(sb), /MYRMIDON_VERSION=1\.6\.7/);
    const bad = run(sb, ["--version", "1.6.7"]);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /--version must look like/);
  });

  it("refuses a CPU below the x86-64-v2 baseline before changing the machine", () => {
    const sb = sandbox();
    const old = path.join(sb.dir, "cpuinfo-old");
    fs.writeFileSync(old, "processor\t: 0\nflags\t\t: fpu vme de pse sse sse2\nvendor_id\t: GenuineIntel\n");
    const r = run(sb, [], { MYRMIDON_INSTALL_CPUINFO: old });
    assert.equal(r.status, 1, "a CPU the board image cannot start on is a refusal, not a late failure");
    assert.match(r.stderr, /x86-64-v2/);
    assert.ok(!fs.existsSync(sb.opt), "the refusal comes before anything is created");

    const good = path.join(sb.dir, "cpuinfo-ok");
    fs.writeFileSync(good, "processor\t: 0\nflags\t\t: fpu vme sse4_1 sse4_2 popcnt cx16 ssse3\n");
    const ok = run(sb, [], { MYRMIDON_INSTALL_CPUINFO: good });
    assert.equal(ok.status, 0, ok.stderr);
  });
});
