import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// RELEASE-GATE (the 01.10 incident): integration tests of the release deploy
// flow — deploy.sh must roll the board and the matching component images
// together, refuse a release whose component digests are missing, and report
// DEGRADED when the post-deploy bot smoke fails. Same harness pattern as
// deploy.test.mjs: the real scripts run against fake `docker`, `curl` and
// `git` first in PATH; no test touches a real registry, board or daemon.

const HERE = path.dirname(fileURLToPath(import.meta.url));
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

// The registry answers one inspect per repository. The tag (component
// resolution) and every digest reference (CI check) share it. The component
// digests ride in the answer's .manifest.digest so --format
// '{{json .Manifest.Digest}}' resolves them.
const FAKE_DOCKER = `#!/usr/bin/env bash
echo "docker $*" >> "$SANDBOX/calls.log"
case "$1" in
  pull) exit 0 ;;
  run)
    case "$*" in
      *check-config*) if [ -e "$SANDBOX/check-config-fails" ]; then echo "config: refused" >&2; exit 1; fi; exit 0 ;;
      *) echo "1.4.0+0123456789ab" ;;
    esac ;;
  image)
    case "$*" in
      *org.opencontainers.image.version*) cat "$SANDBOX/label-version" ;;
      *org.opencontainers.image.revision*) cat "$SANDBOX/label-revision" ;;
    esac ;;
  buildx)
    ref="$4"
    # The scripts ask either the whole image JSON ({{json .Image}}, the CI
    # check) or just the index digest ({{json .Manifest.Digest}}, component
    # resolution). Answer from the same registry files either way.
    fmt=""
    for a in "$@"; do case "$a" in --format) fmt=1 ;; esac; case "$a" in *Manifest.Digest*) fmt=digest ;; esac; done
    file=""
    case "$ref" in
      *myrmidon-dockergate*)
        if [ -e "$SANDBOX/components-missing" ]; then echo "ERROR: not found" >&2; exit 1; fi
        file="$SANDBOX/imagetools-dockergate.json" ;;
      *myrmidon-fleetd*)
        if [ -e "$SANDBOX/components-missing" ]; then echo "ERROR: not found" >&2; exit 1; fi
        file="$SANDBOX/imagetools-fleetd.json" ;;
      *)
        if [ -e "$SANDBOX/registry-missing" ]; then echo "ERROR: not found" >&2; exit 1; fi
        file="$SANDBOX/imagetools.json" ;;
    esac
    if [ "$fmt" = "digest" ]; then
      jq -r '.manifest.digest' "$file" | sed 's/^/"/; s/$/"/'
    else
      cat "$file"
    fi ;;
  ps) echo "cid-x"; exit 0 ;;
  inspect)
    # a container exists for every service and runs; its image is not recorded
    # here (the previous image then falls back to the override file)
    case "$*" in *"{{.State.Status}} {{.State.Restarting}}"*) echo "running false" ;; esac
    exit 0 ;;
  compose)
    case "$*" in
      *--services)
        # The compose project's declared services (for the HOST-TARGETING
        # fail-closed pre-check): the sandbox's base compose file declares
        # server + dockergate + fleetd, mirroring a real release stack.
        # DEPLOY-PRECHECK (the 05.10 incident): with composeConfigFails the
        # project cannot be read — the real compose error on stderr, nothing on
        # stdout, exit 1, exactly like docker compose on an invalid project.
        if [ -e "$SANDBOX/compose-config-fails" ]; then
          echo 'service "server" has neither an image nor a build context specified' >&2
          echo "ERROR: Invalid compose project" >&2
          exit 1
        fi
        printf 'server\ndockergate\nfleetd\n' ;;
      *logs*)
        # DG_LOGGED_VERSION: the NEW image (digest c...) logs a wrong version; the restored old one is fine
        v="1.4.0+0123456789ab"
        if [ -n "\${DG_LOGGED_VERSION:-}" ] && grep -q "sha256:cccc" "$SANDBOX/compose/docker-compose.myrmidon-dockergate.yml" 2>/dev/null; then v="$DG_LOGGED_VERSION"; fi
        # the hash of the dockergate config the tests name (dg-config-file), as the real log carries it
        h=""
        if [ -f "$SANDBOX/dg-config-file" ]; then h="$(sha256sum "$(cat "$SANDBOX/dg-config-file")" | cut -c1-12)"; fi
        echo '{"event":"self-check ok","version":"'"$v"'","configHash":"'"$h"'"}' ;;
      *) exit "\${COMPOSE_FAILS:-0}" ;;
    esac ;;
esac
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

// HOST-TARGETING: the fake ssh either passes the remote command to the local
// fake docker/cat (so the test sees the exact remote command line in the
// calls log) or fails outright (sshFails: no key, unreachable host).
const FAKE_SSH = `#!/usr/bin/env bash
echo "ssh $*" >> "$SANDBOX/calls.log"
if [ -e "$SANDBOX/ssh-fails" ]; then echo "ssh: connect failed" >&2; exit 255; fi
# Drop the ssh options, keep user@host, then run the rest locally (with
# bash -c when the remote command came as one string).
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

// The fake board: health, the company agents list, and per-agent
// bot-container status from files the test controls.
const FAKE_CURL = `#!/usr/bin/env bash
echo "curl $*" >> "$SANDBOX/calls.log"
case "$*" in
  *api/health*) cat "$SANDBOX/health.json" ;;
  *bot-container/status*)
    id=""
    for a in "$@"; do case "$a" in *agents/*) id="\${a##*agents/}"; id="\${id%%/*}" ;; esac; done
    if [ -e "$SANDBOX/status-$id.json" ]; then cat "$SANDBOX/status-$id.json"; else echo "{}"; fi ;;
  *agents*) cat "$SANDBOX/agents.json" ;;
  *issues*) echo '{"issues": []}' ;;
  *fleetd/health*)
    # fleetd-health-bad holds the number of probes that still fail (then it answers)
    if [ -f "$SANDBOX/fleetd-health-bad" ]; then
      n="$(cat "$SANDBOX/fleetd-health-bad")"
      if [ "$n" -gt 0 ]; then echo $((n - 1)) > "$SANDBOX/fleetd-health-bad"; exit 1; fi
    fi
    if [ -e "$SANDBOX/component-health-bad" ]; then exit 1; fi
    echo "OK" ;;
  *dockergate/health*)
    if [ -e "$SANDBOX/component-health-bad" ]; then exit 1; fi
    echo "OK" ;;
  *) echo "{}" ;;
esac
`;

function labels(extra = {}) {
  return {
    "org.opencontainers.image.revision": COMMIT,
    "org.opencontainers.image.source": SOURCE,
    "org.opencontainers.image.version": VERSION,
    ...extra,
  };
}

function sandbox({
  health,
  dumpBytes = 2048,
  labelVersion = VERSION,
  labelRevision = COMMIT,
  current = OLD,
  currentImage,
  registryLabels,
  registryMissing = false,
  componentsMissing = false,
  componentHealth = "ok",
  smoke = "ok",
  smokeCompany = COMPANY,
  composeFails = "0",
  // DEPLOY-PRECHECK (the 05.10 incident): the compose project cannot be read —
  // `docker compose config --services` prints the real compose error and exits 1.
  composeConfigFails = false,
  origin = ORIGIN,
  tags = "",
  sshFails = false,
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myrmidon-release-gate-"));
  const bin = path.join(dir, "bin");
  const composeDir = path.join(dir, "compose");
  fs.mkdirSync(bin);
  fs.mkdirSync(composeDir);
  fs.writeFileSync(path.join(bin, "docker"), FAKE_DOCKER, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "curl"), FAKE_CURL, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "git"), FAKE_GIT, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "ssh"), FAKE_SSH, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "calls.log"), "");
  if (sshFails) fs.writeFileSync(path.join(dir, "ssh-fails"), "");
  const lbls = registryLabels === undefined ? labels() : registryLabels;
  fs.writeFileSync(
    path.join(dir, "imagetools.json"),
    JSON.stringify({ architecture: "amd64", os: "linux", config: { Env: ["A=1"], Labels: lbls } }),
  );
  // Component registry answers: the tag resolves to the component digest, and
  // the digest reference passes the CI check (same labels).
  fs.writeFileSync(
    path.join(dir, "imagetools-dockergate.json"),
    JSON.stringify({ config: { Labels: labels() }, manifest: { digest: DG } }),
  );
  fs.writeFileSync(
    path.join(dir, "imagetools-fleetd.json"),
    JSON.stringify({ config: { Labels: labels() }, manifest: { digest: FD } }),
  );
  if (registryMissing) fs.writeFileSync(path.join(dir, "registry-missing"), "");
  if (componentsMissing) fs.writeFileSync(path.join(dir, "components-missing"), "");
  if (composeConfigFails) fs.writeFileSync(path.join(dir, "compose-config-fails"), "");
  if (componentHealth !== "ok") fs.writeFileSync(path.join(dir, "component-health-bad"), "");
  fs.writeFileSync(path.join(dir, "git-origin"), `${origin}\n`);
  fs.writeFileSync(path.join(dir, "git-tags"), tags);
  fs.writeFileSync(path.join(dir, "label-version"), `${labelVersion}\n`);
  fs.writeFileSync(path.join(dir, "label-revision"), `${labelRevision}\n`);
  fs.writeFileSync(
    path.join(dir, "health.json"),
    JSON.stringify(health ?? { status: "ok", version: labelVersion, commit: COMMIT }),
  );
  // The board's company agents (one hermes_gateway bot) and its container status.
  const agentId = "77777777-7777-4777-8777-777777777777";
  fs.writeFileSync(
    path.join(dir, "agents.json"),
    JSON.stringify([{ id: agentId, adapterType: "hermes_gateway", name: "bot-a" }]),
  );
  const containerState = smoke === "ok" ? "running" : smoke === "created" ? "created" : "missing";
  fs.writeFileSync(
    path.join(dir, `status-${agentId}.json`),
    JSON.stringify({
      enabled: true,
      container: { state: containerState, image: CI_IMAGE },
      containerError: null,
    }),
  );
  const override = path.join(composeDir, "docker-compose.myrmidon-image.yml");
  if (currentImage) {
    fs.writeFileSync(override, `services:\n  server:\n    image: ${currentImage}\n`);
  } else if (current) {
    fs.writeFileSync(override, `services:\n  server:\n    image: ${CI_IMAGE}@${current}\n`);
  }
  // myrmidon(BOOT-PATH): deploy.sh verifies the boot unit; give the sandbox the canonical
  // one in a sandbox dir (the same template the deploy scripts ship).
  const unitDir = path.join(dir, "systemd");
  fs.mkdirSync(unitDir, { recursive: true });
  const unit = fs.readFileSync(path.join(HERE, "paperclip.service.template"), "utf8")
    .replaceAll("__COMPOSE_DIR__", composeDir)
    .replaceAll("__COMPOSE_FILE_ARGS__", `-f ${composeDir}/docker-compose.yml -f ${composeDir}/docker-compose.myrmidon-image.yml -f ${composeDir}/docker-compose.myrmidon-dockergate.yml -f ${composeDir}/docker-compose.myrmidon-fleetd.yml`)
    .replaceAll("__COMPOSE_SERVICE__", "server");
  fs.writeFileSync(path.join(unitDir, "paperclip.service"), unit);
  // The board's own environment for the throwaway board container of
  // PREDEPLOY-DB-CHECK.
  const predeployEnv = path.join(dir, "predeploy-board.env");
  fs.writeFileSync(predeployEnv, "JWT_SECRET=test-secret\n");
  const config = path.join(dir, "deploy.env");
  fs.writeFileSync(
    config,
    [
      `COMPOSE_DIR=${composeDir}`,
      "COMPOSE_SERVICE=server",
      "HEALTH_URL=http://127.0.0.1:3100/api/health",
      "HEALTH_TIMEOUT_SEC=2",
      "POLL_INTERVAL_SEC=1",
      `STATE_DIR=${path.join(dir, "state")}`,
      `DUMP_DIR=${path.join(dir, "dumps")}`,
      `DUMP_COMMAND='head -c ${dumpBytes} /dev/zero > "$DUMP_FILE"'`,
      "MAINTENANCE_MODE=hook",
      `MAINTENANCE_ENTER_COMMAND='echo enter >> ${path.join(dir, "maintenance.log")}'`,
      `MAINTENANCE_EXIT_COMMAND='echo exit >> ${path.join(dir, "maintenance.log")}'`,
      "RUNNING_RUNS_COMMAND='echo 0'",
      `SYSTEMD_UNIT_DIR=${unitDir}`,
      `BOARD_API_URL=http://127.0.0.1:3100/api`,
      // PREDEPLOY-DB-CHECK: the attention list of the company is walked against
      // the throwaway copy, so the check needs the company id too.
      `BOARD_COMPANY_ID=${COMPANY}`,
      ...(smokeCompany ? [`MYRMIDON_DEPLOY_SMOKE_COMPANY=${smokeCompany}`] : []),
      "MYRMIDON_DEPLOY_SMOKE_TIMEOUT_SEC=2",
      "MYRMIDON_DEPLOY_SMOKE_INTERVAL_SEC=1",
      `MYR_DOCKERGATE_HEALTH_URL=http://127.0.0.1:3100/dockergate/health`,
      `MYR_FLEETD_HEALTH_URL=http://127.0.0.1:3100/fleetd/health`,
      // The bot image rollout has its own tests (bot-image-rollout.test.mjs).
      "MYRMIDON_BOT_IMAGE_ROLLOUT=0",
      // PREDEPLOY-DB-CHECK (the 05.10 incident): the pre-window check is ON by
      // default; this sandbox walks the real default path list, so the attention
      // list of the company is exercised against the throwaway copy.
      "MYRMIDON_PREDEPLOY_POSTGRES_IMAGE=postgres:16-alpine",
      `MYRMIDON_PREDEPLOY_BOARD_ENV_FILE=${predeployEnv}`,
      "MYRMIDON_PREDEPLOY_BOARD_PORT=13110",
      "",
    ].join("\n"),
  );
  return { dir, bin, config, override, composeDir, agentId, predeployEnv };
}

function run(sb, script, args) {
  const result = spawnSync(
    process.env.PATH.split(":").map((d) => path.join(d, "bash")).find((f) => fs.existsSync(f)),
    [path.join(HERE, script), "--config", sb.config, ...args],
    {
      env: {
        ...process.env,
        PATH: `${sb.bin}:${process.env.PATH}`,
        SANDBOX: sb.dir,
        COMPOSE_FAILS: sb.composeFails ?? "0",
        ...(sb.env ?? {}),
      },
      encoding: "utf8",
    },
  );
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
const calls = (sb) => read(path.join(sb.dir, "calls.log"));

describe("deploy.sh: release components roll out together (RELEASE-GATE)", () => {
  it("refuses a release whose component digests are missing, before anything changes", () => {
    const sb = sandbox({ componentsMissing: true });
    const before = read(sb.override);
    const { code, out } = run(sb, "deploy.sh", ["--digest", NEW]);
    assert.notEqual(code, 0, out);
    assert.match(out, /component digests missing/i);
    assert.match(out, /release incomplete/i);
    // Nothing changed: no pull, no dump, no maintenance, no compose.
    assert.equal(read(sb.override), before);
    assert.doesNotMatch(calls(sb), /docker pull/);
    assert.ok(!fs.existsSync(path.join(sb.dir, "dumps")));
    assert.ok(!fs.existsSync(path.join(sb.dir, "state")));
  });

  it("rolls dockergate and fleetd in the same run, each with its own health check", () => {
    const sb = sandbox();
    const { code, out } = run(sb, "deploy.sh", ["--digest", NEW]);
    assert.equal(code, 0, out);
    const log = calls(sb);
    // The board image, then both components, were pulled by digest.
    assert.match(log, new RegExp(`docker pull --quiet ${CI_IMAGE}@${NEW}`));
    assert.match(log, new RegExp(`docker pull --quiet ghcr.io/itkadr-git/myrmidon-dockergate@${DG}`));
    assert.match(log, new RegExp(`docker pull --quiet ghcr.io/itkadr-git/myrmidon-fleetd@${FD}`));
    // The component override files were written with the resolved digests.
    assert.match(
      read(path.join(sb.composeDir, "docker-compose.myrmidon-dockergate.yml")),
      new RegExp(`image: ghcr.io/itkadr-git/myrmidon-dockergate@${DG}`),
    );
    assert.match(
      read(path.join(sb.composeDir, "docker-compose.myrmidon-fleetd.yml")),
      new RegExp(`image: ghcr.io/itkadr-git/myrmidon-fleetd@${FD}`),
    );
    // Each component service was recreated.
    assert.match(log, /up -d --no-deps dockergate/);
    assert.match(log, /up -d --no-deps fleetd/);
    // fleetd's health URL was probed; dockergate has no probe a host can pass and
    // is proven by the version in its self-check log line instead.
    assert.match(log, /fleetd\/health/);
    assert.doesNotMatch(log, /dockergate\/health/);
    assert.match(out, /dockergate runs: version 1\.4\.0\+0123456789ab/);
    // The smoke saw a running bot container.
    assert.match(out, /re-applied after the deploy/);
    assert.match(out, /release gate passed/);
  });

  it("DOCKERGATE-FIRST: the components roll out before the board is switched, so the board is verified against the NEW dockergate", () => {
    const sb = sandbox();
    const { code, out } = run(sb, "deploy.sh", ["--digest", NEW]);
    assert.equal(code, 0, out);
    const log = calls(sb);
    const dockergate = log.indexOf("up -d --no-deps dockergate");
    const board = log.indexOf("up -d --no-deps server");
    assert.ok(dockergate >= 0 && board >= 0, log);
    // The 05.10 order was board first, dockergate after: the new board never
    // became `ok` against the old dockergate (`route_not_allowed`) and the fleet
    // stood still. The new dockergate is now recreated BEFORE the board.
    assert.ok(dockergate < board, "the board was recreated before the new dockergate: the 05.10 order");
    assert.match(out, /component dockergate rolled out/);
  });

  it("PREDEPLOY-DB-CHECK: the board is proven on a copy of the production database, with the new dockergate, before the window", () => {
    const sb = sandbox();
    const { code, out } = run(sb, "deploy.sh", ["--digest", NEW]);
    assert.equal(code, 0, out);
    const log = calls(sb);
    assert.match(out, /prove the image on a copy of the production database/);
    assert.match(out, /PREDEPLOY-DB-CHECK: passed/);
    // its own Postgres from the dump, its own network, on 127.0.0.1 only
    assert.match(log, /docker network create myr-predeploy-/);
    assert.match(log, /-e POSTGRES_DB=myrmidon/);
    assert.match(log, new RegExp(`-p 127\\.0\\.0\\.1:13110:3100 ${CI_IMAGE}@${NEW}`));
    // the NEW dockergate of the release, not the one that is running
    assert.match(log, new RegExp(`docker run -d --name myr-predeploy-dockergate-[^ ]+ --network [^ ]+ ghcr\\.io/itkadr-git/myrmidon-dockergate@${DG}`));
    // the attention list and the main company routes of the copy
    assert.match(log, new RegExp(`http://127\\.0\\.0\\.1:13110/api/companies/${COMPANY}/attention`));
    // and the copy is gone before the board is switched (the window)
    assert.match(log, /docker rm -f myr-predeploy-board-/);
    assert.ok(log.indexOf("docker rm -f myr-predeploy-board-") < log.indexOf("up -d --no-deps server"), "the board was switched before the copy was checked");
  });

  it("resolves components by the release tag when the board was built from a tag", () => {
    const sb = sandbox();
    const { code, out } = run(sb, "deploy.sh", ["--digest", NEW]);
    assert.equal(code, 0, out);
    // The version label is a plain semver (a tag build): resolution used it.
    assert.match(out, /release components \(tag 1\.4\.0, from the registry\)/);
    // The component registry was asked for the tag, not just sha-.
    assert.match(calls(sb), /imagetools inspect ghcr.io\/itkadr-git\/myrmidon-dockergate:1\.4\.0/);
  });

  it("resolves components by the commit short sha when there is no release tag", () => {
    // A main build between releases: the version label is not a plain semver,
    // so component resolution falls back to the sha-<short> tag.
    const sb = sandbox({
      labelVersion: "1.4.0+3.git.0123456",
      registryLabels: labels({ "org.opencontainers.image.version": "1.4.0+3.git.0123456" }),
    });
    const { code, out } = run(sb, "deploy.sh", ["--digest", NEW]);
    assert.equal(code, 0, out);
    assert.match(out, /release components \(sha 0123456, from the registry\)/);
    assert.match(calls(sb), /imagetools inspect ghcr.io\/itkadr-git\/myrmidon-dockergate:sha-0123456/);
  });

  it("reports DEGRADED and prints the rollback commands when the bot smoke fails", () => {
    const sb = sandbox({ smoke: "created" });
    const { code, out } = run(sb, "deploy.sh", ["--digest", NEW]);
    assert.notEqual(code, 0);
    assert.match(out, /DEGRADED: no bot container re-applied/i);
    assert.match(out, /rollback\.sh --config/);
    assert.match(out, /rollback-component\.sh --config/);
    // The board and the components DID roll out; the failure is the smoke.
    assert.match(calls(sb), new RegExp(`docker pull --quiet ghcr.io/itkadr-git/myrmidon-dockergate@${DG}`));
  });

  it("warns when the smoke cannot run (no company configured)", () => {
    const sb = sandbox({ smokeCompany: "" });
    const { code, out } = run(sb, "deploy.sh", ["--digest", NEW]);
    assert.equal(code, 0, out);
    assert.match(out, /smoke skipped: MYRMIDON_DEPLOY_SMOKE_COMPANY is not set/);
  });

  it("--dry-run checks the components read-only and prints the plan", () => {
    const sb = sandbox();
    const before = read(sb.override);
    const { code, out } = run(sb, "deploy.sh", ["--digest", NEW, "--dry-run"]);
    assert.equal(code, 0, out);
    assert.match(out, /release components.*board, dockergate, fleetd, bot images/);
    assert.match(out, /dockergate: <none> -> ghcr.io\/itkadr-git\/myrmidon-dockergate@/);
    assert.match(out, /fleetd: <none> -> ghcr.io\/itkadr-git\/myrmidon-fleetd@/);
    assert.match(out, /post-deploy smoke/);
    // Read-only: the component registry was read, nothing was pulled or recreated.
    assert.match(calls(sb), /imagetools inspect ghcr.io\/itkadr-git\/myrmidon-dockergate:1\.4\.0/);
    assert.doesNotMatch(calls(sb), /docker pull|up -d/);
    assert.equal(read(sb.override), before);
  });
});

describe("rollout-component.sh", () => {
  it("refuses an unknown component", () => {
    const sb = sandbox();
    const { code, out } = run(sb, "rollout-component.sh", ["--component", "nonsense", "--digest", DG]);
    assert.notEqual(code, 0);
    assert.match(out, /unknown component: nonsense/);
  });

  it("HOST=skip: a component not managed by this deploy exits 0 with a loud SKIP, and rolls nothing", () => {
    const sb = sandbox();
    fs.appendFileSync(sb.config, "MYR_FLEETD_HOST=skip\n");
    const { code, out } = run(sb, "rollout-component.sh", ["--component", "fleetd", "--digest", FD]);
    assert.equal(code, 0, out);
    assert.match(out, /SKIP: fleetd is not managed by this deploy/);
    // The image was still CI-verified (read-only) but nothing was pulled or recreated.
    assert.match(calls(sb), /buildx imagetools inspect ghcr\.io\/itkadr-git\/myrmidon-fleetd/);
    assert.doesNotMatch(calls(sb), /docker pull/);
    assert.doesNotMatch(calls(sb), /up -d/);
  });

  it("HOST=remote:<user>@<host>: docker and compose run through ssh, the override is written remotely", () => {
    const sb = sandbox();
    fs.appendFileSync(sb.config, "MYR_FLEETD_HOST=remote:root@vm-exec\n");
    const { code, out } = run(sb, "rollout-component.sh", ["--component", "fleetd", "--digest", FD]);
    assert.equal(code, 0, out);
    // The pull and the compose recreate went through ssh to the remote host.
    assert.match(calls(sb), /ssh -o BatchMode=yes -o ConnectTimeout=10 root@vm-exec docker pull --quiet ghcr\.io\/itkadr-git\/myrmidon-fleetd/);
    assert.match(calls(sb), /ssh -o BatchMode=yes -o ConnectTimeout=10 root@vm-exec docker compose .* up -d --no-deps fleetd/);
    // The override write went through ssh as a single remote command (the
    // fake ssh runs it locally, so the file appearing proves the write path:
    // what was logged is the ssh line with the printf inside).
    assert.match(calls(sb), /image: ghcr\.io\/itkadr-git\/myrmidon-fleetd@/);
    // The local compose call (no ssh prefix) never ran from the script
    // itself: the fake ssh executes the remote command locally, so bare
    // docker lines in the log are the fake ssh's own exec — every line the
    // script produced is pinned by the two ssh assertions above.
  });

  it("HOST=remote:<user>@<host>: a broken ssh (no key / unreachable) fails the component rollout, not silently", () => {
    const sb = sandbox({ sshFails: true });
    fs.appendFileSync(sb.config, "MYR_FLEETD_HOST=remote:root@vm-exec\n");
    const { code, out } = run(sb, "rollout-component.sh", ["--component", "fleetd", "--digest", FD]);
    assert.notEqual(code, 0);
    assert.match(out, /cannot pull|compose up failed|not a service of the compose project|compose project itself cannot be read/);
  });

  it("rejects a malformed MYR_<COMPONENT>_HOST value", () => {
    const sb = sandbox();
    fs.appendFileSync(sb.config, "MYR_FLEETD_HOST=elsewhere\n");
    const { code, out } = run(sb, "rollout-component.sh", ["--component", "fleetd", "--digest", FD]);
    assert.notEqual(code, 0);
    assert.match(out, /MYR_FLEETD_HOST must be local, skip or remote:/);
  });

  it("refuses a component image that is not in the registry, changing nothing", () => {
    const sb = sandbox({ componentsMissing: true });
    const { code, out } = run(sb, "rollout-component.sh", ["--component", "dockergate", "--digest", DG]);
    assert.notEqual(code, 0);
    assert.match(out, /cannot be read from the registry/);
    assert.doesNotMatch(calls(sb), /docker pull/);
  });

  it("refuses when fleetd has no health URL configured, before anything is pulled", () => {
    const sb = sandbox();
    fs.appendFileSync(sb.config, "MYR_FLEETD_HEALTH_URL=\n");
    const { code, out } = run(sb, "rollout-component.sh", ["--component", "fleetd", "--digest", FD]);
    assert.notEqual(code, 0);
    assert.match(out, /MYR_FLEETD_HEALTH_URL/);
    assert.doesNotMatch(calls(sb), /docker pull/);
  });

  it("dockergate needs no health URL: its self-check log line is the proof", () => {
    const sb = sandbox();
    fs.appendFileSync(sb.config, "MYR_DOCKERGATE_HEALTH_URL=\n");
    const { code, out } = run(sb, "rollout-component.sh", ["--component", "dockergate", "--digest", DG]);
    assert.equal(code, 0, out);
  });

  it("remembers the previous component image for the rollback", () => {
    const sb = sandbox();
    fs.writeFileSync(
      path.join(sb.composeDir, "docker-compose.myrmidon-dockergate.yml"),
      `services:\n  dockergate:\n    image: ghcr.io/itkadr-git/myrmidon-dockergate@${OLD}\n`,
    );
    const { code, out } = run(sb, "rollout-component.sh", ["--component", "dockergate", "--digest", DG]);
    assert.equal(code, 0, out);
    assert.equal(
      read(path.join(sb.dir, "state", "previous-dockergate-image")).trim(),
      `ghcr.io/itkadr-git/myrmidon-dockergate@${OLD}`,
    );
  });

  it("refuses a local rollout when the component is not a service of the compose project (fail-closed pre-check, nothing pulled)", () => {
    const sb = sandbox();
    // A component nobody declares: neither the fake compose --services list
    // (server/dockergate/fleetd) nor an override file.
    fs.appendFileSync(sb.config, "MYR_DOCKERGATE_COMPOSE_SERVICE=nonexistent-gate\n");
    const { code, out } = run(sb, "rollout-component.sh", ["--component", "dockergate", "--digest", DG]);
    assert.notEqual(code, 0);
    assert.match(out, /not a service of the compose project/);
    assert.match(out, /nonexistent-gate missing/);
    // Fail-closed BEFORE the pull and the override write.
    assert.doesNotMatch(calls(sb), /docker pull ghcr\.io\/itkadr-git\/myrmidon-dockergate/);
    assert.ok(!fs.existsSync(path.join(sb.composeDir, "docker-compose.myrmidon-dockergate.yml")));
  });

  // DEPLOY-PRECHECK (the 05.10 incident): when `docker compose config` itself
  // fails, the pre-check reports the REAL compose error — not the misleading
  // "is not a service of the compose project", which is what the 05.10 deploy
  // printed (the compose project was invalid: `server` had no image).
  it("reports the real compose error when the project cannot be read, not a missing service", () => {
    const sb = sandbox({ composeConfigFails: true });
    const { code, out } = run(sb, "rollout-component.sh", ["--component", "dockergate", "--digest", DG]);
    assert.notEqual(code, 0);
    assert.match(out, /compose project itself cannot be read/);
    assert.match(out, /neither an image nor a build context/);
    assert.doesNotMatch(out, /is not a service of the compose project/);
    // Fail-closed BEFORE the pull and the override write.
    assert.doesNotMatch(calls(sb), /docker pull/);
    assert.ok(!fs.existsSync(path.join(sb.composeDir, "docker-compose.myrmidon-dockergate.yml")));
  });

  it("--dry-run refuses the same unreadable compose project, changing nothing", () => {
    const sb = sandbox({ composeConfigFails: true });
    const { code, out } = run(sb, "rollout-component.sh", ["--component", "dockergate", "--digest", DG, "--dry-run"]);
    assert.notEqual(code, 0);
    assert.match(out, /compose project itself cannot be read/);
    assert.match(out, /neither an image nor a build context/);
    assert.doesNotMatch(calls(sb), /docker pull/);
    assert.ok(!fs.existsSync(path.join(sb.composeDir, "docker-compose.myrmidon-dockergate.yml")));
  });
});

describe("rollback-component.sh", () => {
  it("returns to the remembered component image", () => {
    const sb = sandbox();
    // A rollout first, so the previous image is remembered.
    fs.writeFileSync(
      path.join(sb.composeDir, "docker-compose.myrmidon-dockergate.yml"),
      `services:\n  dockergate:\n    image: ghcr.io/itkadr-git/myrmidon-dockergate@${OLD}\n`,
    );
    assert.equal(run(sb, "rollout-component.sh", ["--component", "dockergate", "--digest", DG]).code, 0);
    const { code, out } = run(sb, "rollback-component.sh", ["--component", "dockergate"]);
    assert.equal(code, 0, out);
    assert.match(
      read(path.join(sb.composeDir, "docker-compose.myrmidon-dockergate.yml")),
      new RegExp(`image: ghcr.io/itkadr-git/myrmidon-dockergate@${OLD}`),
    );
  });

  it("HOST=remote:<user>@<host>: the rollback goes through ssh to the same host as the rollout (no local recreate)", () => {
    const sb = sandbox();
    fs.appendFileSync(sb.config, "MYR_FLEETD_HOST=remote:root@vm-exec\n");
    // A rollout first: through ssh, it remembers the previous image.
    fs.writeFileSync(
      path.join(sb.composeDir, "docker-compose.myrmidon-fleetd.yml"),
      `services:\n  fleetd:\n    image: ghcr.io/itkadr-git/myrmidon-fleetd@${OLD}\n`,
    );
    assert.equal(run(sb, "rollout-component.sh", ["--component", "fleetd", "--digest", FD]).code, 0);
    const { code, out } = run(sb, "rollback-component.sh", ["--component", "fleetd"]);
    assert.equal(code, 0, out);
    // Every docker/compose call the rollback made went through ssh to the remote host.
    const log = calls(sb);
    assert.match(log, /ssh -o BatchMode=yes -o ConnectTimeout=10 root@vm-exec docker pull --quiet ghcr\.io\/itkadr-git\/myrmidon-fleetd/);
    assert.match(log, /ssh -o BatchMode=yes -o ConnectTimeout=10 root@vm-exec docker compose .* up -d --no-deps fleetd/);
  });

  it("HOST=skip: the rollback exits 0 with a loud SKIP, touching nothing", () => {
    const sb = sandbox();
    fs.appendFileSync(sb.config, "MYR_FLEETD_HOST=skip\n");
    const { code, out } = run(sb, "rollback-component.sh", ["--component", "fleetd"]);
    assert.equal(code, 0, out);
    assert.match(out, /SKIP: fleetd is not managed by this deploy/);
    assert.doesNotMatch(calls(sb), /docker pull/);
  });

  it("dies with a clear message when no previous component image is recorded", () => {
    const sb = sandbox();
    const { code, out } = run(sb, "rollback-component.sh", ["--component", "dockergate"]);
    assert.notEqual(code, 0);
    assert.match(out, /no previous dockergate image recorded/);
  });
});

describe("bot-apply-smoke.sh", () => {
  function runSmoke(sb, args) {
    const result = spawnSync(
      process.env.PATH.split(":").map((d) => path.join(d, "bash")).find((f) => fs.existsSync(f)),
      [path.join(HERE, "bot-apply-smoke.sh"), ...args],
      { env: { ...process.env, PATH: `${sb.bin}:${process.env.PATH}`, SANDBOX: sb.dir }, encoding: "utf8" },
    );
    return { code: result.status, out: `${result.stdout}${result.stderr}` };
  }

  it("succeeds when a bot container is running", () => {
    const sb = sandbox({ smoke: "ok" });
    const { code, out } = runSmoke(sb, [
      "--board-url", "http://127.0.0.1:3100/api",
      "--company", COMPANY,
      "--timeout", "2",
      "--interval", "1",
    ]);
    assert.equal(code, 0, out);
    assert.match(out, /OK: bot container of agent .* is running/);
  });

  it("fails when no bot container re-applies within the window", () => {
    const sb = sandbox({ smoke: "created" });
    const { code, out } = runSmoke(sb, [
      "--board-url", "http://127.0.0.1:3100/api",
      "--company", COMPANY,
      "--timeout", "2",
      "--interval", "1",
    ]);
    assert.notEqual(code, 0);
    assert.match(out, /SMOKE FAILED/);
  });
});

const PRE_DG = `ghcr.io/itkadr-git/myrmidon-dockergate@sha256:${"1".repeat(64)}`;
const PRE_FD = `ghcr.io/itkadr-git/myrmidon-fleetd@sha256:${"2".repeat(64)}`;
const writeComponentOverride = (sb, name, ref) =>
  fs.writeFileSync(
    path.join(sb.composeDir, `docker-compose.myrmidon-${name}.yml`),
    `services:\n  ${name}:\n    image: ${ref}\n`,
  );
const imageOf = (file) => /image:\s*(\S+)/.exec(read(file))?.[1];

describe("ONE-DEPLOY: all components in one window, all-or-nothing", () => {
  it("a dockergate failure rolls everything back together: the board and the config", () => {
    const sb = sandbox();
    writeComponentOverride(sb, "dockergate", PRE_DG);
    writeComponentOverride(sb, "fleetd", PRE_FD);
    // dockergate comes up reporting the wrong self-check version
    sb.env = { DG_LOGGED_VERSION: "0.0.1+deadbeefdead" };
    const { code, out } = run(sb, "deploy.sh", ["--digest", NEW]);
    assert.notEqual(code, 0, out);
    assert.match(out, /reports version '0\.0\.1\+deadbeefdead', expected '1\.4\.0\+0123456789ab'/);
    assert.match(out, /ROLLING BACK TOGETHER/);
    assert.match(out, /ROLLED BACK/);
    // the board is back on its previous image, dockergate on its previous one
    assert.equal(imageOf(sb.override), `${CI_IMAGE}@${OLD}`);
    assert.equal(imageOf(path.join(sb.composeDir, "docker-compose.myrmidon-dockergate.yml")), PRE_DG);
    // fleetd was never reached: not pulled, not recreated
    assert.doesNotMatch(calls(sb), /docker pull --quiet ghcr.io\/itkadr-git\/myrmidon-fleetd/);
    assert.equal(imageOf(path.join(sb.composeDir, "docker-compose.myrmidon-fleetd.yml")), PRE_FD);
    // the window was lifted again
    assert.match(read(path.join(sb.dir, "maintenance.log")), /exit/);
  });

  it("a fleetd failure after a healthy dockergate rolls dockergate back as well", () => {
    const sb = sandbox();
    writeComponentOverride(sb, "dockergate", PRE_DG);
    writeComponentOverride(sb, "fleetd", PRE_FD);
    fs.writeFileSync(path.join(sb.dir, "fleetd-health-bad"), "3");
    const { code, out } = run(sb, "deploy.sh", ["--digest", NEW]);
    assert.notEqual(code, 0, out);
    assert.match(out, /ROLLED BACK/);
    assert.equal(imageOf(sb.override), `${CI_IMAGE}@${OLD}`);
    assert.equal(imageOf(path.join(sb.composeDir, "docker-compose.myrmidon-dockergate.yml")), PRE_DG);
    assert.equal(imageOf(path.join(sb.composeDir, "docker-compose.myrmidon-fleetd.yml")), PRE_FD);
    // dockergate was switched first (pulled at its release digest), then returned
    assert.match(calls(sb), new RegExp(`docker pull --quiet ghcr.io/itkadr-git/myrmidon-dockergate@${DG}`));
    assert.match(calls(sb), new RegExp(`docker pull --quiet ${PRE_DG.replace(/[.@/]/g, "\\$&")}`));
  });

  it("MYRMIDON_COMPONENT_AUTO_ROLLBACK=0 keeps the old manual contract: nothing rolls back, maintenance stays on", () => {
    const sb = sandbox();
    writeComponentOverride(sb, "dockergate", PRE_DG);
    writeComponentOverride(sb, "fleetd", PRE_FD);
    fs.writeFileSync(path.join(sb.dir, "fleetd-health-bad"), "3");
    fs.appendFileSync(sb.config, "MYRMIDON_COMPONENT_AUTO_ROLLBACK=0\n");
    const { code, out } = run(sb, "deploy.sh", ["--digest", NEW]);
    assert.notEqual(code, 0, out);
    assert.match(out, /automatic rollback is off/);
    // DOCKERGATE-FIRST: the components roll out BEFORE the board, so the failed
    // fleetd stopped the window with the board still on its previous image (the
    // operator has one less thing to clean up by hand).
    assert.equal(imageOf(sb.override), `${CI_IMAGE}@${OLD}`);
    assert.doesNotMatch(read(path.join(sb.dir, "maintenance.log")), /exit/);
  });

  it("a component that already runs its release image is not restarted", () => {
    const sb = sandbox();
    writeComponentOverride(sb, "dockergate", `ghcr.io/itkadr-git/myrmidon-dockergate@${DG}`);
    writeComponentOverride(sb, "fleetd", PRE_FD);
    const { code, out } = run(sb, "deploy.sh", ["--digest", NEW]);
    assert.equal(code, 0, out);
    assert.match(out, /component dockergate unchanged: not restarted/);
    // dockergate: no pull of its image, no recreate; fleetd (changed) moved
    assert.doesNotMatch(calls(sb), /up -d --no-deps dockergate/);
    assert.doesNotMatch(calls(sb), new RegExp(`docker pull --quiet ghcr.io/itkadr-git/myrmidon-dockergate@${DG}`));
    assert.match(calls(sb), /up -d --no-deps fleetd/);
    assert.equal(imageOf(path.join(sb.composeDir, "docker-compose.myrmidon-fleetd.yml")), `ghcr.io/itkadr-git/myrmidon-fleetd@${FD}`);
  });

  it("when everything already runs the release, nothing is restarted and no window opens", () => {
    const sb = sandbox({ current: NEW });
    writeComponentOverride(sb, "dockergate", `ghcr.io/itkadr-git/myrmidon-dockergate@${DG}`);
    writeComponentOverride(sb, "fleetd", `ghcr.io/itkadr-git/myrmidon-fleetd@${FD}`);
    const { code, out } = run(sb, "deploy.sh", ["--digest", NEW]);
    assert.equal(code, 0, out);
    assert.match(out, /nothing to restart/);
    assert.doesNotMatch(calls(sb), /docker pull|up -d/);
    assert.equal(read(path.join(sb.dir, "maintenance.log")), "");
  });

  it("--dry-run lists every component with what changes and what stays", () => {
    const sb = sandbox();
    writeComponentOverride(sb, "dockergate", `ghcr.io/itkadr-git/myrmidon-dockergate@${DG}`);
    const { code, out } = run(sb, "deploy.sh", ["--digest", NEW, "--dry-run"]);
    assert.equal(code, 0, out);
    assert.match(out, /board: .* -> /);
    assert.match(out, /dockergate: unchanged .*: not restarted/);
    assert.match(out, /fleetd: <none> -> ghcr.io\/itkadr-git\/myrmidon-fleetd@/);
    assert.match(out, /bot images:/);
  });

  it("--release reads the manifest: the board digest and the components come from it", () => {
    const sb = sandbox();
    const manifest = path.join(sb.dir, "release-components.json");
    fs.writeFileSync(manifest, JSON.stringify({
      schema: 1, version: "1.4.0", tag: "myr-v1.4.0",
      components: {
        board: { repository: CI_IMAGE, digest: NEW },
        dockergate: { repository: "ghcr.io/itkadr-git/myrmidon-dockergate", digest: DG },
        fleetd: { repository: "ghcr.io/itkadr-git/myrmidon-fleetd", digest: FD },
        hermes: { repository: "ghcr.io/itkadr-git/myrmidon-hermes", digest: `sha256:${"e".repeat(64)}` },
      },
    }));
    fs.appendFileSync(sb.config, `MYRMIDON_RELEASE_MANIFEST_FILE=${manifest}\n`);
    const { code, out } = run(sb, "deploy.sh", ["--release", "myr-v1.4.0", "--dry-run"]);
    assert.equal(code, 0, out);
    assert.match(out, /release components \(tag 1\.4\.0, from the manifest\)/);
    assert.match(out, new RegExp(`board: .* -> ${CI_IMAGE.replace(/\./g, "\\.")}@${NEW}`));
    // the components were NOT resolved through the registry tags
    assert.doesNotMatch(calls(sb), /imagetools inspect ghcr.io\/itkadr-git\/myrmidon-dockergate:/);
    // a --digest that disagrees with the manifest is refused
    const bad = run(sb, "deploy.sh", ["--release", "myr-v1.4.0", "--digest", `sha256:${"7".repeat(64)}`, "--dry-run"]);
    assert.notEqual(bad.code, 0);
    assert.match(bad.out, /does not match the board image/);
  });
});

describe("rollout-component.sh: dockergate config before the recreate (ONE-DEPLOY)", () => {
  const withConfig = (sb) => {
    const cfg = path.join(sb.dir, "dockergate.config.json");
    fs.writeFileSync(cfg, JSON.stringify({ images: [] }));
    fs.writeFileSync(path.join(sb.dir, "dg-config-file"), cfg);
    fs.appendFileSync(sb.config, `MYRMIDON_BOT_IMAGE_ROLLOUT_DOCKERGATE_CONFIG=${cfg}\n`);
    return cfg;
  };

  it("runs dockergate check-config with the new image before the service is recreated", () => {
    const sb = sandbox();
    withConfig(sb);
    const { code, out } = run(sb, "rollout-component.sh", ["--component", "dockergate", "--digest", DG]);
    assert.equal(code, 0, out);
    const log = calls(sb);
    const check = log.indexOf("check-config");
    const recreate = log.indexOf("up -d --no-deps dockergate");
    assert.ok(check >= 0 && recreate > check, "check-config ran before the recreate");
    assert.match(log, new RegExp(`myrmidon-dockergate@${DG} check-config`));
    assert.match(out, /dockergate runs: version 1\.4\.0\+0123456789ab, config hash [0-9a-f]{12}/);
  });

  it("a config the new dockergate refuses stops the rollout before anything is recreated", () => {
    const sb = sandbox();
    withConfig(sb);
    fs.writeFileSync(path.join(sb.dir, "check-config-fails"), "");
    const { code, out } = run(sb, "rollout-component.sh", ["--component", "dockergate", "--digest", DG]);
    assert.notEqual(code, 0);
    assert.match(out, /check-config refused/);
    assert.doesNotMatch(calls(sb), /up -d --no-deps dockergate/);
    assert.ok(!fs.existsSync(path.join(sb.composeDir, "docker-compose.myrmidon-dockergate.yml")));
  });

  it("an unchanged component exits 0 without pulling or recreating (--force recreates)", () => {
    const sb = sandbox();
    writeComponentOverride(sb, "fleetd", `ghcr.io/itkadr-git/myrmidon-fleetd@${FD}`);
    const same = run(sb, "rollout-component.sh", ["--component", "fleetd", "--digest", FD]);
    assert.equal(same.code, 0, same.out);
    assert.match(same.out, /UNCHANGED: fleetd already runs/);
    assert.doesNotMatch(calls(sb), /docker pull|up -d/);
    const forced = run(sb, "rollout-component.sh", ["--component", "fleetd", "--digest", FD, "--force"]);
    assert.equal(forced.code, 0, forced.out);
    assert.match(calls(sb), /up -d --no-deps fleetd/);
  });
});
