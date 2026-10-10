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
  *pg_isready*) exit 0 ;;
  # The installer enables the vector extension of the knowledge corpus and reads
  # its version back: the fake database answers the version query.
  *"CREATE EXTENSION IF NOT EXISTS vector"*) exit 0 ;;
  *"extname='vector'"*) echo "\${FAKE_VECTOR_VERSION:-0.8.7}"; exit 0 ;;
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
    // The daemon socket is root:docker 0660 and dockergate runs as the nonroot
    // user 65532: without the socket's group the container dies on
    // "the daemon does not answer: upstream_error".
    assert.match(env, /MYRMIDON_DOCKER_GID=[0-9]+/);
    const compose = fs.readFileSync(path.join(sb.opt, "compose.yml"), "utf8");
    assert.ok(compose.includes("group_add:"), "dockergate must be granted the docker socket group");
    // dockergate pins the board's main process by a walk over /proc, so it has to
    // share the host pid namespace: without `pid: host` it sees only its own
    // processes, the board pid is missing, and every resolve fails with
    // "caller_resolve_failed: board_not_running" while the container looks up.
    assert.match(compose, /pid:\s*host/, "dockergate must share the host pid namespace");
    assert.match(compose, /network_mode:\s*none/, "dockergate serves a unix socket only");
    assert.ok(
      compose.includes("${MYRMIDON_BOARD_REPOSITORY:?the board repository must be set}@${MYRMIDON_BOARD_DIGEST:?the board digest must be set}"),
      "the board image reference is built from the manifest repository and digest",
    );
    // CORPUS (1.6.6): the knowledge corpus keeps embeddings in a `vector` column,
    // so the database image ships pgvector and the installer ENABLES the extension
    // in the fresh database before the board starts. An image that merely offers
    // the binary would leave the module switched off; the board itself does not
    // create the extension.
    assert.match(compose, /image:\s*pgvector\/pgvector:0\.8\.7-pg17/, "the database image must ship pgvector");
    assert.ok(
      calls(sb).includes("CREATE EXTENSION IF NOT EXISTS vector"),
      "the fresh install must enable the vector extension",
    );
    assert.match(r.stderr, /vector extension: 0\.8\.7/, "the install log names the version it enabled");
    const stackOrder = calls(sb)
      .split("\n")
      .filter((l) => l.includes("CREATE EXTENSION") || l.includes("up -d"));
    assert.equal(stackOrder.length, 3, stackOrder.join(" | "));
    assert.ok(
      stackOrder[0].includes("up -d db") && stackOrder[1].includes("CREATE EXTENSION") && stackOrder[2].includes("up -d"),
      `the extension must be created between the database and the board: ${stackOrder.join(" | ")}`,
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
    // The board refuses every Host header it was not told about, the machine's
    // own address included, so the allow list travels with the install.
    assert.match(env, /MYRMIDON_ALLOWED_HOSTNAMES=\S+/);
    assert.match(compose, /PAPERCLIP_ALLOWED_HOSTNAMES: "\$\{MYRMIDON_ALLOWED_HOSTNAMES:?/);
  });

  it("opens the board by IP and names that address in the allow list", () => {
    const sb = sandbox();
    // The address the installer prints has to reach the board on the first
    // click: a bare hostname only resolves for whoever has DNS for it.
    const r = run(sb, [], { MYRMIDON_ALLOWED_HOSTS: "board.test,10.20.30.40" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(envFile(sb), /MYRMIDON_ALLOWED_HOSTNAMES=board\.test,10\.20\.30\.40/);
    assert.match(envFile(sb), /MYRMIDON_PUBLIC_URL=http:\/\/10\.20\.30\.40:3100/);
    assert.match(r.stdout, /Address:\s+http:\/\/10\.20\.30\.40:3100/);
    assert.match(
      fs.readFileSync(path.join(sb.opt, "compose.yml"), "utf8"),
      /PAPERCLIP_ALLOWED_HOSTNAMES: "\$\{MYRMIDON_ALLOWED_HOSTNAMES:?/,
    );
  });

  it("refuses a fresh database that reports another vector version", () => {
    const sb = sandbox();
    const r = run(sb, [], { FAKE_VECTOR_VERSION: "0.7.0" });
    assert.equal(r.status, 1, "the pinned extension version is part of the acceptance of a fresh install");
    assert.match(r.stderr, /reports vector 0\.7\.0/);
    assert.match(r.stderr, /installs vector 0\.8\.7/);
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
    // The fresh install brings the database up on its own (the vector extension of
    // the knowledge corpus has to exist before the board starts), then the stack:
    // two calls, plus the failed switch and the rollback.
    assert.equal(ups.length, 4, "install (database, then stack), failed switch and rollback each recreate the stack");
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

  it("answers --help and names a missing option value in plain language when piped", () => {
    // The documented form pipes the script into bash, so $0 is "bash". Reading
    // the header back out of $0 (sed -n '2,40p' "$0") answered
    // "sed: can't read bash" — a novice asking for help got an error instead.
    const piped = (args) =>
      spawnSync("bash", ["-s", "--", ...args], {
        cwd: os.tmpdir(),
        encoding: "utf8",
        input: fs.readFileSync(INSTALL, "utf8"),
        env: { ...process.env, MYRMIDON_INSTALL_LANG: "en" },
      });

    const help = piped(["--help"]);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /ONE-COMMAND-INSTALL/);
    assert.match(help.stdout, /--uninstall/);
    assert.doesNotMatch(help.stdout + help.stderr, /can't read bash/);

    // --version without its value used to die on `$2: unbound variable`.
    const missing = piped(["--version"]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /--version needs a value/);
  });
});
