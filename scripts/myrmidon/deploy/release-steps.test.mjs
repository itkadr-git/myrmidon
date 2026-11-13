import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// RELEASE-STEPS: the deploy step journal ($STATE_DIR/release-steps.log) records
// the intent (step-begin) before the first external effect of a step and the
// outcome (step-end) after it. An open step never survives the process: the
// exit/interrupt traps flush it as interrupted or error. The log is
// append-only: a re-run never removes the record of a previous attempt. Same
// harness pattern as release-gate.test.mjs: the real scripts run against fake
// `docker`, `curl`, `git`, `ssh`, `systemctl` and `df` first in PATH.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, "lib.sh");
const OLD = `sha256:${"a".repeat(64)}`;
const NEW = `sha256:${"b".repeat(64)}`;
const DG = `sha256:${"c".repeat(64)}`;
const FD = `sha256:${"d".repeat(64)}`;
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const VERSION = "1.4.0";
const CI_IMAGE = "ghcr.io/itkadr-git/myrmidon";
const SOURCE = "https://github.com/itkadr-git/myrmidon";
const ORIGIN = "https://github.com/itkadr-git/myrmidon.git";
const COMPANY = "2870b911-0000-4000-8000-000000000000";

const FAKE_DOCKER = `#!/usr/bin/env bash
echo "docker $*" >> "$SANDBOX/calls.log"
case "$1" in
  pull) exit 0 ;;
  run)
    case "$*" in
      *check-config*) exit 0 ;;
      *) echo "1.4.0+0123456789ab" ;;
    esac ;;
  image)
    case "$*" in
      *org.opencontainers.image.version*) cat "$SANDBOX/label-version" ;;
      *org.opencontainers.image.revision*) cat "$SANDBOX/label-revision" ;;
    esac ;;
  buildx)
    ref="$4"
    fmt=""
    for a in "$@"; do case "$a" in --format) fmt=1 ;; esac; case "$a" in *Manifest.Digest*) fmt=digest ;; esac; done
    file=""
    case "$ref" in
      *myrmidon-dockergate*) file="$SANDBOX/imagetools-dockergate.json" ;;
      *myrmidon-fleetd*) file="$SANDBOX/imagetools-fleetd.json" ;;
      *) file="$SANDBOX/imagetools.json" ;;
    esac
    if [ "$fmt" = "digest" ]; then
      jq -r '.manifest.digest' "$file" | sed 's/^/"/; s/$/"/'
    else
      cat "$file"
    fi ;;
  ps)
    if [ -e "$SANDBOX/bot-missing-container" ]; then exit 0; fi
    # Per-service container ids: the no-window test needs the dockergate and
    # fleetd containers to already run THEIR release digests, so the component
    # comparison finds nothing changed and the window never opens.
    case "$*" in
      *com.docker.compose.service=server*) echo "cid-server" ;;
      *com.docker.compose.service=dockergate*) echo "cid-dockergate" ;;
      *com.docker.compose.service=fleetd*) echo "cid-fleetd" ;;
      *) echo "cid-x" ;;
    esac
    exit 0 ;;
  inspect)
    case "$*" in
      *'{{.State.Status}} {{.State.Restarting}}'*) echo "running false" ;;
      *'{{.Config.Image}}'*)
        # The failure test needs the components to be CHANGED (their containers
        # still run the OLD board image), so the window opens and the rollout
        # fails at the component health check; the healthy path needs them
        # already on their release digests so no window opens at all.
        if [ -e "$SANDBOX/component-health-bad" ]; then
          echo "${CI_IMAGE}@${OLD}"
        else
          case "$*" in
            *cid-dockergate*) echo "ghcr.io/itkadr-git/myrmidon-dockergate@${DG}" ;;
            *cid-fleetd*) echo "ghcr.io/itkadr-git/myrmidon-fleetd@${FD}" ;;
            *) echo "${CI_IMAGE}@${OLD}" ;;
          esac
        fi ;;
      *State.Health*) echo "healthy" ;;
      *) echo "running" ;;
    esac ;;
  rm) exit 0 ;;
  logs)
    if [ -e "$SANDBOX/component-health-bad" ]; then exit 0; fi
    echo '{"event":"self-check ok","version":"1.4.0+0123456789ab","configHash":"3b7920aba58f"}' ;;
  rmi) exit 0 ;;
  compose)
    shift
    case "$1" in
      *)
        case "$*" in
          *config*) printf 'server\ndockergate\nfleetd\n' ;;
          *logs*) echo '{"event":"self-check ok","version":"1.4.0+0123456789ab","configHash":"3b7920aba58f"}' ;;
          *) exit "\${COMPOSE_FAILS:-0}" ;;
        esac ;;
    esac ;;
esac
exit 0
`;

const FAKE_GIT = `#!/usr/bin/env bash
echo "git $*" >> "$SANDBOX/calls.log"
while [ "$1" = "-C" ]; do shift 2; done
case "$1" in
  rev-parse) echo "$SANDBOX/clone" ;;
  remote) cat "$SANDBOX/git-origin" ;;
  fetch) ;;
  merge-base) exit 0 ;;
  ls-remote) cat "$SANDBOX/git-tags" ;;
esac
`;

const FAKE_SSH = `#!/usr/bin/env bash
echo "ssh $*" >> "$SANDBOX/calls.log"
if [ -e "$SANDBOX/ssh-fails" ]; then echo "ssh: connect failed" >&2; exit 255; fi
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) shift 2 ;;
    *) break ;;
  esac
done
target="$1"; shift
if [ "$#" -eq 1 ]; then
  exec bash -c "$1"
fi
exec "$@"
`;

const FAKE_SYSTEMCTL = `#!/usr/bin/env bash
echo "systemctl $*" >> "$SANDBOX/calls.log"
exit 0
`;

const FAKE_CURL = `#!/usr/bin/env bash
echo "curl $*" >> "$SANDBOX/calls.log"
case "$*" in
  *api/liveness*)
    if [[ " $* " == *" -w "* ]]; then printf '200'; else printf '{"status":"ok"}'; fi
    exit 0 ;;
  *api/health*) cat "$SANDBOX/health.json" ;;
  *bot-container/status*)
    id=""
    for a in "$@"; do case "$a" in *agents/*) id="\${a##*agents/}"; id="\${id%%/*}" ;; esac; done
    if [ -e "$SANDBOX/status-$id.json" ]; then cat "$SANDBOX/status-$id.json"; else echo "{}"; fi ;;
  *agent-configurations*) echo "[]" ;;
  *agents*) cat "$SANDBOX/agents.json" ;;
  *issues*) echo '{"issues": []}' ;;
  *fleetd/health*|*dockergate/health*)
    if [ -e "$SANDBOX/component-health-bad" ]; then exit 1; fi
    echo "OK" ;;
  *) echo "{}" ;;
esac
`;

const FAKE_DF = `#!/usr/bin/env bash
echo "Filesystem 1K-blocks Used Available Use% Mounted on"
echo "/dev/sda1 100000000 10000000 90000000 10% /"
exit 0
`;

function labels(extra = {}) {
  return {
    "org.opencontainers.image.revision": COMMIT,
    "org.opencontainers.image.source": SOURCE,
    "org.opencontainers.image.version": VERSION,
    ...extra,
  };
}

function sandbox({ componentHealth = "ok" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myrmidon-release-steps-"));
  const bin = path.join(dir, "bin");
  const composeDir = path.join(dir, "compose");
  fs.mkdirSync(bin);
  fs.mkdirSync(composeDir);
  fs.writeFileSync(path.join(bin, "docker"), FAKE_DOCKER, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "curl"), FAKE_CURL, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "git"), FAKE_GIT, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "ssh"), FAKE_SSH, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "systemctl"), FAKE_SYSTEMCTL, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "df"), FAKE_DF, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "calls.log"), "");
  fs.writeFileSync(
    path.join(dir, "imagetools.json"),
    JSON.stringify({ architecture: "amd64", os: "linux", config: { Env: ["A=1"], Labels: labels() } }),
  );
  fs.writeFileSync(
    path.join(dir, "imagetools-dockergate.json"),
    JSON.stringify({ config: { Labels: labels() }, manifest: { digest: DG } }),
  );
  fs.writeFileSync(
    path.join(dir, "imagetools-fleetd.json"),
    JSON.stringify({ config: { Labels: labels() }, manifest: { digest: FD } }),
  );
  if (componentHealth !== "ok") fs.writeFileSync(path.join(dir, "component-health-bad"), "");
  fs.writeFileSync(path.join(dir, "git-origin"), `${ORIGIN}\n`);
  fs.writeFileSync(path.join(dir, "git-tags"), "");
  fs.writeFileSync(path.join(dir, "label-version"), `${VERSION}\n`);
  fs.writeFileSync(path.join(dir, "label-revision"), `${COMMIT}\n`);
  fs.writeFileSync(
    path.join(dir, "health.json"),
    JSON.stringify({ status: "ok", version: VERSION, commit: COMMIT }),
  );
  const agentId = "77777777-7777-4777-8777-777777777777";
  fs.writeFileSync(
    path.join(dir, "agents.json"),
    JSON.stringify([{ id: agentId, adapterType: "hermes_gateway", name: "bot-a" }]),
  );
  fs.writeFileSync(
    path.join(dir, `status-${agentId}.json`),
    JSON.stringify({
      enabled: true,
      container: { state: "running", image: CI_IMAGE },
      containerError: null,
    }),
  );
  const override = path.join(composeDir, "docker-compose.myrmidon-image.yml");
  fs.writeFileSync(path.join(composeDir, "docker-compose.yml"), "services:\n  server:\n    image: test\n  dockergate:\n    image: test\n  fleetd:\n    image: test\n");
  fs.writeFileSync(override, `services:\n  server:\n    image: ${CI_IMAGE}@${OLD}\n`);
  const unitDir = path.join(dir, "systemd");
  fs.mkdirSync(unitDir, { recursive: true });
  const unit = fs.readFileSync(path.join(HERE, "paperclip.service.template"), "utf8")
    .replaceAll("__COMPOSE_DIR__", composeDir)
    .replaceAll("__COMPOSE_FILE_ARGS__", `-f ${composeDir}/docker-compose.yml -f ${composeDir}/docker-compose.myrmidon-image.yml -f ${composeDir}/docker-compose.myrmidon-dockergate.yml -f ${composeDir}/docker-compose.myrmidon-fleetd.yml`)
    .replaceAll("__COMPOSE_SERVICE__", "server");
  fs.writeFileSync(path.join(unitDir, "paperclip.service"), unit);
  const predeployEnv = path.join(dir, "predeploy-board.env");
  fs.writeFileSync(predeployEnv, "JWT_SECRET=test-secret\n");
  const config = path.join(dir, "deploy.env");
  fs.writeFileSync(
    config,
    [
      `COMPOSE_DIR=${composeDir}`,
      "COMPOSE_SERVICE=server",
      "COMPOSE_FILES=docker-compose.yml",
      `MYRMIDON_BOT_IMAGE_ROLLOUT_DOCKERGATE_CONFIG=${path.join(dir, "dg-config.json")}`,
      "HEALTH_URL=http://127.0.0.1:3100/api/health",
      "HEALTH_TIMEOUT_SEC=2",
      "POLL_INTERVAL_SEC=1",
      `STATE_DIR=${path.join(dir, "state")}`,
      `DUMP_DIR=${path.join(dir, "dumps")}`,
      `DUMP_COMMAND='head -c 2048 /dev/zero > "$DUMP_FILE"'`,
      "MAINTENANCE_MODE=hook",
      `MAINTENANCE_ENTER_COMMAND='echo enter >> ${path.join(dir, "maintenance.log")}'`,
      `MAINTENANCE_EXIT_COMMAND='echo exit >> ${path.join(dir, "maintenance.log")}'`,
      "RUNNING_RUNS_COMMAND='echo 0'",
      `SYSTEMD_UNIT_DIR=${unitDir}`,
      `BOARD_API_URL=http://127.0.0.1:3100/api`,
      `BOARD_COMPANY_ID=${COMPANY}`,
      "MYRMIDON_DEPLOY_POSTCHECK_RUNS=0",
      `MYRMIDON_DEPLOY_SMOKE_COMPANY=${COMPANY}`,
      "MYRMIDON_DEPLOY_SMOKE_TIMEOUT_SEC=2",
      "MYRMIDON_DEPLOY_SMOKE_INTERVAL_SEC=1",
      `MYR_DOCKERGATE_HEALTH_URL=http://127.0.0.1:3100/dockergate/health`,
      `MYR_FLEETD_HEALTH_URL=http://127.0.0.1:3100/fleetd/health`,
      "MYRMIDON_BOT_IMAGE_ROLLOUT=0",
      "MYRMIDON_DEPLOY_MIN_FREE_GB=0",
      `MYRMIDON_PREDEPLOY_POSTGRES_IMAGE=postgres:16-alpine`,
      "MYRMIDON_PREDEPLOY_IO_DEVICE=/dev/fake-docker-data",
      "MYRMIDON_PREDEPLOY_IO_RATE=30000000",
      `MYRMIDON_PREDEPLOY_BOARD_ENV_FILE=${predeployEnv}`,
      "MYRMIDON_PREDEPLOY_BOARD_PORT=13110",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(dir, "dg-config.json"), JSON.stringify({ images: [], bots: [] }));
  return { dir, bin, config, override, composeDir, stateDir: path.join(dir, "state") };
}

function run(sb, script, args) {
  const env = {
    ...process.env,
    PATH: `${sb.bin}:${process.env.PATH}`,
    SANDBOX: sb.dir,
    COMPOSE_FAILS: "0",
  };
  delete env.BASH_ENV;
  delete env.ENV;
  const result = spawnSync(
    process.env.PATH.split(":").map((d) => path.join(d, "bash")).find((f) => fs.existsSync(f)),
    [path.join(HERE, script), "--config", sb.config, ...args],
    { env, encoding: "utf8" },
  );
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
const stepsLog = (sb) => read(path.join(sb.stateDir, "release-steps.log"));

// Unit harness: one lib.sh helper body in a sandbox, the config already loaded.
function runBody(sb, body) {
  const script = [
    "set -euo pipefail",
    `source ${LIB}`,
    "DRY_RUN=0",
    `load_config ${sb.config}`,
    "trap 'release_steps_flush EXIT \"$?\"' EXIT",
    body,
    "",
  ].join("\n");
  const result = spawnSync("bash", ["-c", script], {
    env: { ...process.env, BASH_ENV: "", PATH: `${sb.bin}:${process.env.PATH}`, SANDBOX: sb.dir },
    encoding: "utf8",
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

function unitSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myrmidon-release-steps-unit-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(dir, "calls.log"), "");
  const config = path.join(dir, "deploy.env");
  fs.writeFileSync(
    config,
    [`COMPOSE_DIR=${dir}`, "COMPOSE_SERVICE=server", "HEALTH_URL=http://127.0.0.1:3100/api/health", `STATE_DIR=${path.join(dir, "state")}`, ""].join("\n"),
  );
  return { dir, bin, config, stateDir: path.join(dir, "state") };
}

describe("lib.sh: release step journal helpers", () => {
  it("records begin before end for a completed step", () => {
    const sb = unitSandbox();
    const { code, out } = runBody(sb, 'step_begin "s1" "d1"; step_end_ok "done"');
    assert.equal(code, 0, out);
    const log = stepsLog(sb);
    const lines = log.trim().split("\n");
    assert.equal(lines.length, 2, log);
    assert.match(lines[0], / step-begin s1 d1$/);
    assert.match(lines[1], / step-end s1 ok done$/);
    assert.ok(log.indexOf("step-begin") < log.indexOf("step-end"), "begin must precede end");
    // Both lines share the attempt id of this run.
    const begin = lines[0].match(/attempt=(\S+)/)?.[1];
    assert.ok(begin, log);
    assert.match(lines[1], new RegExp(`attempt=${begin} `));
  });

  it("flushes a step open at exit as an error, never as ok", () => {
    const sb = unitSandbox();
    const { code, out } = runBody(sb, 'step_begin "s1"; exit 3');
    assert.equal(code, 3, out);
    const log = stepsLog(sb);
    assert.match(log, / step-begin s1 \n/);
    assert.match(log, / step-end s1 error exit-status=3\n/);
    assert.doesNotMatch(log, / step-end s1 ok /);
  });

  it("no-ops when step_end_ok runs without an open step", () => {
    const sb = unitSandbox();
    const { code, out } = runBody(sb, "step_end_ok");
    assert.equal(code, 0, out);
    assert.equal(stepsLog(sb), "");
  });

  it("keeps the previous attempt when a second run appends to the same state dir", () => {
    const sb = unitSandbox();
    const first = runBody(sb, 'step_begin "s1" "first"; step_end_ok "first done"');
    assert.equal(first.code, 0, first.out);
    const firstId = stepsLog(sb).match(/attempt=(\S+)/)?.[1];
    const second = runBody(sb, 'step_begin "s1" "second"; step_end_ok "second done"');
    assert.equal(second.code, 0, second.out);
    const log = stepsLog(sb);
    const lines = log.trim().split("\n");
    assert.equal(lines.length, 4, log);
    const secondId = lines[2].match(/attempt=(\S+)/)?.[1];
    assert.ok(firstId && secondId && firstId !== secondId, log);
    assert.match(lines[0], /step-begin s1 first/);
    assert.match(lines[1], /step-end s1 ok first done/);
  });

  it("uses one attempt id for several steps of the same process", () => {
    const sb = unitSandbox();
    const { code, out } = runBody(sb, 'step_begin "a"; step_end_ok; step_begin "b"; step_end_ok');
    assert.equal(code, 0, out);
    const ids = [...stepsLog(sb).matchAll(/attempt=(\S+)/g)].map((m) => m[1]);
    assert.equal(ids.length, 4, stepsLog(sb));
    assert.ok(new Set(ids).size === 1, stepsLog(sb));
  });
});

describe("deploy.sh: board-rollout step journal (RELEASE-STEPS)", () => {
  it("a successful window deploy records board-rollout begin then ok", () => {
    const sb = sandbox();
    const { code, out } = run(sb, "deploy.sh", ["--digest", NEW]);
    assert.equal(code, 0, out);
    const log = stepsLog(sb);
    // `${digest:0:19}` keeps "sha256:" plus 12 hex chars; same convention as
    // the maintenance_reason log line. The trailing ( |\n) anchors the end of
    // the detail field (the line ends with a newline).
    assert.match(log, / step-begin board-rollout ref=ghcr\.io\/itkadr-git\/myrmidon@sha256:b{64} digest=sha256:b{12}( |\n)/);
    assert.match(log, / step-end board-rollout ok board deployed/);
    assert.doesNotMatch(log, /error|interrupted/);
  });

  it("a no-window deploy writes no board-rollout step", () => {
    const sb = sandbox();
    // Same digest as the running image: nothing to restart (need_window=0).
    const { code, out } = run(sb, "deploy.sh", ["--digest", OLD]);
    assert.equal(code, 0, out);
    assert.doesNotMatch(stepsLog(sb), /board-rollout/);
  });

  it("a failure inside the window still records the open step (never lost)", () => {
    const sb = sandbox({ componentHealth: "bad" });
    const { code, out } = run(sb, "deploy.sh", ["--digest", NEW]);
    assert.notEqual(code, 0, out);
    const log = stepsLog(sb);
    // The window was entered (the begin precedes the first effect), then the
    // component health check failed the window; the step must be flushed.
    assert.match(log, / step-begin board-rollout /);
    assert.doesNotMatch(log, / step-end board-rollout ok /);
    assert.match(log, / step-end board-rollout (error|interrupted)/);
    // The intent line is before the failure flush.
    const begin = log.indexOf("step-begin board-rollout");
    const end = log.indexOf("step-end board-rollout");
    assert.ok(begin >= 0 && end > begin, log);
  });

  it("a re-run appends and keeps the first attempt", () => {
    const sb = sandbox();
    assert.equal(run(sb, "deploy.sh", ["--digest", NEW]).code, 0);
    assert.equal(run(sb, "deploy.sh", ["--digest", NEW]).code, 0);
    const log = stepsLog(sb);
    const begins = [...log.matchAll(/step-begin board-rollout/g)].length;
    const oks = [...log.matchAll(/step-end board-rollout ok/g)].length;
    assert.equal(begins, 2, log);
    assert.equal(oks, 2, log);
    const ids = [...log.matchAll(/attempt=(\S+)/g)].map((m) => m[1]);
    assert.ok(new Set(ids).size === 2, log);
  });
});

describe("bot-image-rollout.sh: bot-config and bot-cards step journal (RELEASE-STEPS)", () => {
  const rolloutArgs = ["--resolution", "tag", "--ref", VERSION, "--digest", `hermes=${NEW}`];

  it("the config phase records bot-config begin then ok and exits after it", () => {
    const sb = sandbox();
    const { code, out } = run(sb, "bot-image-rollout.sh", ["--phase", "config", ...rolloutArgs]);
    assert.equal(code, 0, out);
    const log = stepsLog(sb);
    assert.match(log, / step-begin bot-config /);
    assert.match(log, / step-end bot-config ok config complete/);
    assert.doesNotMatch(log, /bot-cards/);
  });

  it("the cards phase records bot-cards begin then ok", () => {
    const sb = sandbox();
    const { code, out } = run(sb, "bot-image-rollout.sh", ["--phase", "cards", ...rolloutArgs]);
    assert.equal(code, 0, out);
    const log = stepsLog(sb);
    assert.match(log, / step-begin bot-cards /);
    assert.match(log, / step-end bot-cards ok /);
    assert.doesNotMatch(log, /bot-config/);
  });

});
