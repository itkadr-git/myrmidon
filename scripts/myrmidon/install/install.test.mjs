import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { composeEnvVars, composeInterpolation } from "./compose-check.mjs";

// Runs the real install.sh against fake `docker`, `curl`, `ss`, `systemctl` and
// `apt-get` placed first in PATH. The fakes log every call and answer from files
// in the sandbox: no test touches GitHub, a registry or a docker daemon.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INSTALL = path.join(HERE, "install.sh");
const A = `sha256:${"a".repeat(64)}`;
const B = `sha256:${"b".repeat(64)}`;
const C = `sha256:${"c".repeat(64)}`;

const FAKE_DOCKER = `#!/usr/bin/env bash
if [[ "$1" == "compose" ]]; then
  shift
  while [[ "$1" == "--project-name" || "$1" == "--project-directory" || "$1" == "--env-file" || "$1" == "-f" ]]; do shift 2; done
elif [[ "$1" == "--project-name" ]]; then
  shift 2
fi
printf 'docker %s\\n' "$*" >> "$SANDBOX/calls.log"
case "$*" in
  "compose version") echo "Docker Compose version v2.30.0"; exit 0 ;;
  *"config"*) exit 0 ;;
  *"pull --quiet"*) exit 0 ;;
  *"up -d"*) touch "$SANDBOX/up"; exit 0 ;;
  *"down"*) rm -f "$SANDBOX/up"; exit 0 ;;
  *"network inspect"*) exit 0 ;;
  *"network create"*) exit 0 ;;
  *pg_dump*) echo "PGDUMP-FAKE-CONTENT"; exit 0 ;;
  *pg_isready*) exit 0 ;;
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
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(PAPERCLIP|MYRMIDON|POSTGRES|DATABASE_URL|BETTER_AUTH_SECRET|JWT_SECRET|PAPERCLIP_TOOL_ACTION_SIGNING_SECRET|PAPERCLIP_INSTALL_DATABASE_URL)/.test(key))),
      PATH: `${sb.bin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
      BASH_ENV: "",
      SANDBOX: sb.dir,
      MYRMIDON_INSTALL_SKIP_ROOT_CHECK: "1",
      MYRMIDON_INSTALL_SKIP_DOCKER_INSTALL: "1",
      MYRMIDON_INSTALL_LANG: "en",
      MYRMIDON_INSTALL_HEALTH_TIMEOUT: "5",
      ...env,
    },
  });
}

const calls = (sb) => (fs.existsSync(path.join(sb.dir, "calls.log")) ? fs.readFileSync(path.join(sb.dir, "calls.log"), "utf8") : "");
const envFile = (sb) => fs.readFileSync(path.join(sb.opt, "deploy.env"), "utf8");

it("dry-run renders and validates without pulling or starting services", () => {
  const sb = sandbox();
  const result = run(sb, ["--dry-run"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Dry run complete/);
  assert.ok(fs.existsSync(path.join(sb.opt, "compose.yml")));
  assert.doesNotMatch(calls(sb), /pull|up -d/);
});

const REPO = path.join(HERE, "..", "..", "..");

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
    assert.match(env, /MYR_LICENSE_INSTANCE_ID=$/m);
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

  it("the default profile stands up one PostgreSQL 18 + pgvector with per-service databases and roles", () => {
    const sb = sandbox();
    const r = run(sb);
    assert.equal(r.status, 0, r.stderr);
    const env = envFile(sb);
    assert.match(env, /MYRMIDON_DB_PROFILE=internal/);
    // The shared server is the pgvector project's own build of PostgreSQL 18:
    // no postgres:17 image survives in the generated stack.
    assert.match(env, /MYRMIDON_DB_IMAGE=docker\.io\/pgvector\/pgvector:pg18/);
    assert.match(env, /MYRMIDON_SHARED_SERVICES="litellm langfuse hindsight"/);
    for (const svc of ["LITELLM", "LANGFUSE", "HINDSIGHT"]) {
      assert.match(env, new RegExp(`MYRMIDON_${svc}_PASSWORD=[0-9a-f]{48}`), `a role password for ${svc}`);
    }
    // Sizing: defaults derived from the total, every value in the env file.
    assert.match(env, /MYRMIDON_DB_TOTAL_MEMORY_MB=[0-9]+/);
    assert.match(env, /MYRMIDON_DB_SHARED_BUFFERS=[0-9]+MB/);
    assert.match(env, /MYRMIDON_DB_EFFECTIVE_CACHE_SIZE=[0-9]+MB/);
    assert.match(env, /MYRMIDON_DB_MAINTENANCE_WORK_MEM=[0-9]+MB/);
    assert.match(env, /MYRMIDON_DB_WORK_MEM=[0-9]+MB/);
    assert.match(env, /MYRMIDON_DB_SHM_SIZE=[0-9]+m/);

    const compose = fs.readFileSync(path.join(sb.opt, "compose.yml"), "utf8");
    assert.ok(compose.includes("image: ${MYRMIDON_DB_IMAGE"), "the db image is taken from deploy.env");
    assert.ok(compose.includes("shared_buffers=${MYRMIDON_DB_SHARED_BUFFERS"), "memory parameters are passed to the server");
    assert.ok(compose.includes("./db-init:/docker-entrypoint-initdb.d:ro"), "the init script is mounted");
    assert.ok(compose.includes("postgres://") && compose.includes("@db:5432/"), "the board's database lives on the shared server");

    assert.doesNotMatch(compose, /image: postgres:/, "no literal postgres:17 image in the generated compose");
    assert.doesNotMatch(compose, /paperclip-data:/i, "clean installs do not generate legacy Paperclip volume names");

    const init = fs.readFileSync(path.join(sb.opt, "db-init", "01-shared-roles.sh"), "utf8");
    assert.equal(fs.statSync(path.join(sb.opt, "db-init", "01-shared-roles.sh")).mode & 0o755, 0o755);
    assert.ok(init.includes('CREATE EXTENSION IF NOT EXISTS vector;"'), "pgvector is enabled in every database");
    // The script loops over the services listed in deploy.env instead of
    // baking passwords into a world-readable file: the role/database/owner
    // statements stay templates, the names come from the env it is handed.
    assert.ok(init.includes("CREATE ROLE ${svc} LOGIN"), "a login role per service");
    assert.ok(init.includes("CREATE DATABASE ${svc} OWNER ${svc}"), "a private database per service");
    assert.match(env, /MYRMIDON_SHARED_SERVICES="litellm langfuse hindsight"/, "the shared services list is persisted");
    for (const svc of ["litellm", "langfuse", "hindsight"]) {
      assert.match(env, new RegExp(`MYRMIDON_${svc.toUpperCase()}_PASSWORD=.+`), `a password for ${svc}`);
    }
    assert.ok(init.includes("ALTER SYSTEM SET shared_buffers"), "the sizing is persisted in the cluster");
  });

  it("the memory sizing is taken from the install environment and capped", () => {
    const sb = sandbox();
    const r = run(sb, [], { MYRMIDON_DB_TOTAL_MEMORY_MB: "8192" });
    assert.equal(r.status, 0, r.stderr);
    const env = envFile(sb);
    assert.match(env, /MYRMIDON_DB_SHARED_BUFFERS=2048MB/);
    assert.match(env, /MYRMIDON_DB_EFFECTIVE_CACHE_SIZE=6144MB/);
    assert.match(env, /MYRMIDON_DB_MAINTENANCE_WORK_MEM=128MB/);

    // A large host stays at the cap unless the operator raises it by hand.
    const big = sandbox();
    const rb = run(big, [], { MYRMIDON_DB_TOTAL_MEMORY_MB: "65536" });
    assert.equal(rb.status, 0, rb.stderr);
    assert.match(envFile(big), /MYRMIDON_DB_TOTAL_MEMORY_MB=16384/);
    assert.match(envFile(big), /MYRMIDON_DB_SHARED_BUFFERS=4096MB/);
  });

  it("the external profile uses the operator's shared server and creates no db container", () => {
    const url = "postgresql://boardrole:dummy-external-pw@shared-db.internal:5432/paperclip";
    const sb = sandbox();
    const r = run(sb, ["--database-url", url]);
    assert.equal(r.status, 0, r.stderr);
    const env = envFile(sb);
    assert.match(env, /MYRMIDON_DB_PROFILE=external/);
    assert.match(env, /MYRMIDON_DATABASE_URL=postgresql:\/\/boardrole/);
    assert.doesNotMatch(env, /MYRMIDON_LITELLM_PASSWORD/, "no role passwords are generated for someone else's server");

    const compose = fs.readFileSync(path.join(sb.opt, "compose.yml"), "utf8");
    assert.doesNotMatch(compose, /^  db:$/m, "the compose project grows no db service");
    assert.doesNotMatch(compose, /pgdata:/, "no local database volume");
    assert.ok(compose.includes("${MYRMIDON_DATABASE_URL:?"), "the board points at the external server");
    assert.ok(!fs.existsSync(path.join(sb.opt, "db-init")), "no init script without a local server");

    // A re-run without the flag keeps the profile: it is recorded in deploy.env.
    const again = run(sb);
    assert.equal(again.status, 0, again.stderr);
    assert.match(envFile(sb), /MYRMIDON_DB_PROFILE=external/);
    assert.doesNotMatch(fs.readFileSync(path.join(sb.opt, "compose.yml"), "utf8"), /^  db:$/m);
  });

  it("preserves an existing qualified PostgreSQL image and data configuration", () => {
    const sb = sandbox();
    assert.equal(run(sb).status, 0);
    const composePath = path.join(sb.opt, "compose.yml");
    let compose = fs.readFileSync(composePath, "utf8");
    compose = `services:\n  db:\n    image: registry.example.internal/team/postgres-custom:17.4\n    volumes:\n      - pgdata:/var/lib/postgresql/data\n  server:\n    volumes:\n      - /srv/myrmidon-state:/var/lib/myrmidon\n${compose}`;
    fs.writeFileSync(composePath, compose);
    const envPath = path.join(sb.opt, "deploy.env");
    const envBefore = fs.readFileSync(envPath, "utf8");
    const secretsBefore = envBefore.split("\n").filter((line) => /PASSWORD=|SECRET=/.test(line));
    const volumeBefore = compose.match(/pgdata:[^\n]*/)[0];
    const dataPathBefore = compose.match(/\/srv\/myrmidon-state[^\n]*/)?.[0];
    const databaseUrlBefore = envBefore.match(/^MYRMIDON_DATABASE_URL=.*$/m)?.[0];

    fs.writeFileSync(path.join(sb.dir, "up"), "");
    const updated = run(sb);
    assert.equal(updated.status, 0, updated.stderr);

    const envAfter = fs.readFileSync(envPath, "utf8");
    const composeAfter = fs.readFileSync(composePath, "utf8");
    assert.ok(composeAfter.includes("registry.example.internal/team/postgres-custom:17.4"));
    assert.equal(composeAfter.match(/pgdata:[^\n]+/)[0].split("\\n")[0], volumeBefore);
    assert.ok(dataPathBefore && composeAfter.includes(dataPathBefore), "the bind mount path stays unchanged");
    for (const secret of secretsBefore) assert.ok(envAfter.includes(secret), "preserves generated secret values");
    assert.ok(envAfter.includes("MYRMIDON_DB_PROFILE=internal"));
    if (databaseUrlBefore) assert.ok(envAfter.includes(databaseUrlBefore), "preserves the database connection setting");
  });

  it("detects qualified legacy PostgreSQL references", () => {
    const sb = sandbox();
    const composePath = path.join(sb.opt, "compose.yml");
    fs.mkdirSync(sb.opt, { recursive: true });
    fs.writeFileSync(composePath, "services:\n  db:\n    image: registry.example.internal/team/postgres:17\nvolumes:\n  pgdata:\n    name: paperclip_pgdata\n  myrmidon-data:\n");
    const legacyUrl = `postgresql://${"legacy-role"}:${"preserved"}@db.example:5432/app`;
    const envContents = `MYRMIDON_DB_PROFILE=keep\nMYRMIDON_DB_IMAGE=registry.example.internal/team/postgres:17\nMYRMIDON_DATABASE_URL=${legacyUrl}\nPOSTGRES_PASSWORD=legacy-secret\n`;
    fs.writeFileSync(path.join(sb.opt, "deploy.env"), envContents);
    fs.writeFileSync(path.join(sb.opt, ".myrmidon-install"), "myrmidon\n");
    const r = run(sb);
    assert.equal(r.status, 0, r.stderr);
    const result = fs.readFileSync(composePath, "utf8");
    assert.ok(result.includes("registry.example.internal/team/postgres:17") || result.includes("MYRMIDON_DB_IMAGE=registry.example.internal/team/postgres:17"));
    assert.ok(result.includes("paperclip_pgdata"));
    assert.ok(result.includes("myrmidon-data"));
    assert.ok(fs.readFileSync(path.join(sb.opt, "deploy.env"), "utf8").includes("MYRMIDON_DB_PROFILE=keep"));
  });

  it("refuses an external database URL that is not a postgres connection string", () => {
    const sb = sandbox();
    const r = run(sb, ["--database-url", "http://db.internal/paperclip"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /postgres:/);
  });

  it("the generated compose interpolates like docker compose config would", () => {
    // Review rationale: substring greps cannot see a broken ${VAR...}
    // template; only compose-style interpolation does. A leaked mask or a
    // U+2026 inside a reference is a hard error here, not a silent miss.
    const sb = sandbox();
    assert.equal(run(sb).status, 0);
    const vars = composeEnvVars(envFile(sb));
    const compose = fs.readFileSync(path.join(sb.opt, "compose.yml"), "utf8");
    const { errors, interpolated } = composeInterpolation(compose, vars);
    assert.deepEqual(errors, [], "the generated compose must interpolate with no errors");
    const pw = vars["POSTGRES_PASSWORD"];
    assert.ok(pw && pw.length >= 8, "deploy.env carries the generated board password");
    assert.ok(
      interpolated.includes("postgres://paperclip:" + pw + "@db:5432/paperclip"),
      "the interpolated board DATABASE_URL uses the deploy password and the db host",
    );
  });

  it("the static compose in the repository interpolates with the documented defaults", () => {
    const src = fs.readFileSync(path.join(REPO, "docker", "docker-compose.yml"), "utf8");
    const full = composeInterpolation(src, { POSTGRES_PASSWORD: "operator-pw", BETTER_AUTH_SECRET: "secret" });
    assert.deepEqual(full.errors, [], "no broken reference in the shipped compose");
    assert.ok(
      full.interpolated.includes("postgres://paperclip:operator-pw@db:5432/paperclip"),
      "the board URL tracks the password given to compose",
    );
    // Without an operator password the documented dev default keeps the
    // local stack working; only the deliberately-required auth secret fails.
    const dev = composeInterpolation(src, {});
    assert.ok(
      dev.interpolated.includes("postgres://paperclip:paperclip@db:5432/paperclip"),
      "the dev stack keeps working with the paperclip default",
    );
    assert.deepEqual(
      dev.errors.map((e) => e.split(" ")[0]),
      ["BETTER_AUTH_SECRET"],
      "only the one required secret fails when nothing is set",
    );
  });

  it("gives the board the one shared license directory, read-write, at the module path", () => {
    // The antigravity adapter runs inside the board and reads
    // /etc/myrmidon-license/license.key there; host modules read the same host
    // file. The licensing screen must write that one file, so the board mounts
    // the host directory read-write and points MYR_LICENSE_PATH at it.
    const sb = sandbox();
    assert.equal(run(sb).status, 0);
    const env = envFile(sb);
    assert.match(env, /^MYRMIDON_LICENSE_DIR=\/etc\/myrmidon-license$/m);
    const compose = fs.readFileSync(path.join(sb.opt, "compose.yml"), "utf8");
    assert.match(compose, /^      MYR_LICENSE_PATH: "\/etc\/myrmidon-license\/license\.key"$/m);
    assert.match(compose, /^      - \$\{MYRMIDON_LICENSE_DIR:-\/etc\/myrmidon-license\}:\/etc\/myrmidon-license$/m);
    const { errors, interpolated } = composeInterpolation(compose, composeEnvVars(env));
    assert.deepEqual(errors, []);
    assert.ok(interpolated.includes("- /etc/myrmidon-license:/etc/myrmidon-license\n"), "mounted read-write, not :ro");

    const custom = sandbox();
    assert.equal(run(custom, [], { MYRMIDON_LICENSE_DIR: "/srv/licenses" }).status, 0);
    assert.match(envFile(custom), /^MYRMIDON_LICENSE_DIR=\/srv\/licenses$/m);
  });

  it("stops when the license issuing key sits in the license directory", () => {
    for (const make of [
      (d) => fs.mkdirSync(path.join(d, "issuer")),
      (d) => fs.writeFileSync(path.join(d, "signing.pem"), "x"),
      (d) => fs.writeFileSync(path.join(d, "key_ed25519"), "x"),
    ]) {
      const sb = sandbox();
      const licDir = path.join(sb.dir, "lic");
      fs.mkdirSync(licDir);
      make(licDir);
      const result = run(sb, ["--dry-run"], { MYRMIDON_LICENSE_DIR: licDir });
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}${result.stderr}`, /ключ выпуска лежит в каталоге лицензии/);
    }
    const clean = sandbox();
    const licDir = path.join(clean.dir, "lic");
    fs.mkdirSync(licDir);
    fs.writeFileSync(path.join(licDir, "license.key"), "MYR1.x\n");
    assert.equal(run(clean, ["--dry-run"], { MYRMIDON_LICENSE_DIR: licDir }).status, 0);
  });

  it("mounts the database volume at the path the PostgreSQL 18 image declares", () => {
    // PG18 keeps the cluster at /var/lib/postgresql/18/docker and the image
    // declares VOLUME /var/lib/postgresql. Mounting .../data would leave the
    // real data directory in an anonymous volume.
    const sb = sandbox();
    assert.equal(run(sb).status, 0);
    const files = [
      ["compose.yml", fs.readFileSync(path.join(sb.opt, "compose.yml"), "utf8")],
      ["docker-compose.yml", fs.readFileSync(path.join(REPO, "docker", "docker-compose.yml"), "utf8")],
      ["paperclip-db.container", fs.readFileSync(path.join(REPO, "docker", "quadlet", "paperclip-db.container"), "utf8")],
    ];
    for (const [name, txt] of files) {
      assert.ok(/pgdata(:|=)\/var\/lib\/postgresql(?!\/)/.test(txt), name + " mounts at the declared VOLUME path");
      assert.ok(!txt.includes("/var/lib/postgresql/data"), name + " must not keep the PG17 data path");
    }
  });

  it("an external connection string with shell metacharacters survives sourcing deploy.env", () => {
    // deploy.env is read with `. deploy.env`: the URL must be written with
    // printf %q, or $, `, \ and parens break the source (and the re-run).
    const sb = sandbox();
    const url = "postgresql://boardrole:p%4ss-w0$rd`x(bare)@shared-db.internal:5432/paperclip";
    const r = run(sb, ["--database-url", url]);
    assert.equal(r.status, 0, r.stderr);
    const round = spawnSync("bash", ["-c", '. "$PWD/deploy.env"; printf %s "$MYRMIDON_DATABASE_URL"'], {
      cwd: sb.opt,
      encoding: "utf8",
    });
    assert.equal(round.status, 0, round.stderr);
    assert.equal(round.stdout, url, "sourcing deploy.env yields the exact URL back");
  });
  it("--help names the database profile options", () => {
    const piped = spawnSync("bash", ["-s", "--", "--help"], {
      cwd: os.tmpdir(),
      encoding: "utf8",
      input: fs.readFileSync(INSTALL, "utf8"),
      env: { ...process.env, MYRMIDON_INSTALL_LANG: "en" },
    });
    assert.equal(piped.status, 0, piped.stderr);
    assert.match(piped.stdout, /--database-url/);
  });
});
