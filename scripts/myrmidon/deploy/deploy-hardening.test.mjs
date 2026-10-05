import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// Deploy hardening: every test here reproduces one failure of a production
// deploy of a release (a component preflight that judged an invalid compose
// project, a dockergate health probe that can never pass, a rollback to a stale
// override image, a config written with the wrong owner and mode, a refusal
// nobody could read) and passes once the failure is fixed.
// Same harness as release-gate.test.mjs, with a stateful fake docker: the
// containers that "run", the dockergate log, and the compose project validity
// are files the tests control. Nothing touches a real
// registry, board, daemon or dockergate.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OLD = `sha256:${"a".repeat(64)}`;
const NEW = `sha256:${"b".repeat(64)}`;
const DG = `sha256:${"c".repeat(64)}`;
const FD = `sha256:${"d".repeat(64)}`;
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const VERSION = "1.6.3";
const DG_VERSION = "1.4.0+0123456789ab";
const CI_IMAGE = "ghcr.io/itkadr-git/myrmidon";
const DG_REPO = "ghcr.io/itkadr-git/myrmidon-dockergate";
const FD_REPO = "ghcr.io/itkadr-git/myrmidon-fleetd";
const DG_RUNNING = `${DG_REPO}@sha256:${"1".repeat(64)}`;
const DG_STALE = `${DG_REPO}@sha256:${"2".repeat(64)}`;
const FD_RUNNING = `${FD_REPO}@sha256:${"3".repeat(64)}`;
const SOURCE = "https://github.com/itkadr-git/myrmidon";
const ORIGIN = "https://github.com/itkadr-git/myrmidon.git";
const COMPANY = "2870b911-0000-4000-8000-000000000000";
const PROD_SECRET = "example-prod-password";

const FAKE_DOCKER = `#!/usr/bin/env bash
echo "docker $*" >> "$SANDBOX/calls.log"
last="\${@: -1}"
# the image of a compose override file passed with -f
override_image() {
  local svc="$1" prev="" a
  for a in "$@"; do
    case "$prev" in -f) case "$a" in *docker-compose.myrmidon-$svc.yml) sed -nE 's/^ *image: *([^ #]+).*/\\1/p' "$a"; return ;; esac ;; esac
    prev="$a"
  done
}
case "$1" in
  pull) exit "\${FAKE_PULL_EXIT:-0}" ;;
  network) echo "net-id"; exit 0 ;;
  rm) exit 0 ;;
  ps)
    svc=""
    for a in "$@"; do case "$a" in label=com.docker.compose.service=*) svc="\${a#label=com.docker.compose.service=}" ;; esac; done
    if [ -n "$svc" ] && [ -f "$SANDBOX/containers/$svc.image" ]; then echo "cid-$svc"; fi
    exit 0 ;;
  inspect)
    svc="\${last#cid-}"
    case "$*" in
      *"{{.Config.Image}}"*) cat "$SANDBOX/containers/$svc.image" ;;
      *"{{.State.Status}} {{.State.Restarting}}"*) cat "$SANDBOX/containers/$svc.state" 2>/dev/null || echo "running false" ;;
    esac
    exit 0 ;;
  run)
    case "$*" in
      *check-config*)
        cfg=""
        for a in "$@"; do case "$a" in *:/etc/myrmidon-dockergate/config.json:ro) cfg="\${a%%:/etc/myrmidon-dockergate/config.json:ro}" ;; esac; done
        if [ -e "$SANDBOX/check-config-fails" ]; then cat "$SANDBOX/check-config-fails" >&2; exit 1; fi
        # the image runs as another user than the owner of the file: it needs the "other" read bit
        if [ -e "$SANDBOX/dg-runs-as-other" ] && [ -n "$cfg" ]; then
          mode="$(stat -c %a "$cfg")"
          case "$mode" in *[4-7]) ;; *) echo "config: open /etc/myrmidon-dockergate/config.json: permission denied" >&2; exit 1 ;; esac
        fi
        echo "config ok (hash 0123456789ab, 1 bot(s), 2 image(s))"; exit 0 ;;
    esac
    if [ "$last" = "version" ]; then echo "\${DG_RUN_VERSION:-${DG_VERSION}}"; exit 0; fi
    exit 0 ;;
  image)
    case "$2" in
      inspect)
        case "$*" in
          *org.opencontainers.image.version*) cat "$SANDBOX/label-version"; exit 0 ;;
          *org.opencontainers.image.revision*) cat "$SANDBOX/label-revision"; exit 0 ;;
        esac
        exit 0 ;;
    esac ;;
  buildx)
    ref="$4"
    fmt=""
    for a in "$@"; do case "$a" in *Manifest.Digest*) fmt=digest ;; esac; done
    case "$ref" in
      *myrmidon-dockergate*) file="$SANDBOX/imagetools-dockergate.json" ;;
      *myrmidon-fleetd*) file="$SANDBOX/imagetools-fleetd.json" ;;
      *) file="$SANDBOX/imagetools.json" ;;
    esac
    if [ "$fmt" = "digest" ]; then jq -r '.manifest.digest' "$file" | sed 's/^/"/; s/$/"/'; else cat "$file"; fi ;;
  compose)
    sub=""
    for a in "$@"; do case "$a" in config|up|logs|ps|stop) sub="$a"; break ;; esac; done
    if [ "$sub" = "config" ]; then
      if [ -e "$SANDBOX/compose-invalid" ]; then cat "$SANDBOX/compose-invalid" >&2; exit 1; fi
      # a project without the board image override has a server service with no image
      case "$*" in *docker-compose.myrmidon-image.yml*) ;; *) echo 'service "server" has neither an image nor a build context specified: invalid compose project' >&2; exit 1 ;; esac
      case "$*" in
        *--services*) printf 'server\\ndockergate\\nfleetd\\n'; exit 0 ;;
        *"--format json"*) cat "$SANDBOX/compose-config.json"; exit 0 ;;
      esac
      exit 0
    fi
    if [ "$sub" = "logs" ]; then
      case "$last" in dockergate) cat "$SANDBOX/dg-log" 2>/dev/null ;; esac
      exit 0
    fi
    if [ "$sub" = "up" ]; then
      [ -e "$SANDBOX/compose-up-fails" ] && exit 1
      svc="$last"
      img="$(override_image "$svc" "$@")"
      case "$svc" in server) img="$(override_image image "$@")" ;; esac
      if [ -n "$img" ]; then echo "$img" > "$SANDBOX/containers/$svc.image"; fi
      if [ "$svc" = "dockergate" ]; then
        if [ -e "$SANDBOX/dg-crashloop" ]; then echo "restarting true" > "$SANDBOX/containers/dockergate.state"
        else
          h="$(sha256sum "$SANDBOX/dg/config.json" | cut -c1-12)"
          [ -e "$SANDBOX/dg-stale-hash" ] && h="deadbeef0000"
          echo '{"event":"self-check ok","version":"'"\${DG_LOGGED_VERSION:-${DG_VERSION}}"'","configHash":"'"$h"'"}' >> "$SANDBOX/dg-log"
        fi
      fi
      exit 0
    fi
    exit 0 ;;
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

const FAKE_SSH = `#!/usr/bin/env bash
echo "ssh $*" >> "$SANDBOX/calls.log"
while [ "$#" -gt 0 ]; do case "$1" in -o) shift 2 ;; *) break ;; esac; done
shift
if [ "$#" -eq 1 ]; then exec bash -c "$1"; fi
exec "$@"
`;

const FAKE_SYSTEMCTL = `#!/usr/bin/env bash
echo "systemctl $*" >> "$SANDBOX/calls.log"
exit 0
`;

// dockergate as the signal command sees it: a reload appends the line a real
// dockergate logs; a file it cannot read leaves the old config in memory.
const DG_SIM = `#!/usr/bin/env bash
echo hup >> "$SANDBOX/sighup.log"
if [ -e "$SANDBOX/dg-reload-fails" ]; then
  echo '{"level":"error","event":"config_reload_failed","detail":"invalid"}' >> "$SANDBOX/dg-log"
  exit 0
fi
h="$(sha256sum "$SANDBOX/dg/config.json" | cut -c1-12)"
echo '{"event":"config_reloaded","version":"${DG_VERSION}","configHash":"'"$h"'"}' >> "$SANDBOX/dg-log"
`;

const FAKE_CURL = `#!/usr/bin/env bash
echo "curl $*" >> "$SANDBOX/calls.log"
case "$*" in
  *--unix-socket*) echo "curl: (22) The requested URL returned error: 403" >&2; exit 22 ;;
  *api/maintenance*)
    if [ -f "$SANDBOX/maintenance-down" ]; then
      n="$(cat "$SANDBOX/maintenance-down")"
      if [ "$n" -gt 0 ]; then echo $((n - 1)) > "$SANDBOX/maintenance-down"; echo "curl: (56) Recv failure: Connection reset by peer" >&2; exit 56; fi
    fi
    case "$*" in
      *'"action":"enter"'*) echo on > "$SANDBOX/maintenance-state"; echo '{"ok":true}' ;;
      *'"action":"exit"'*) echo off > "$SANDBOX/maintenance-state"; echo '{"ok":true}' ;;
      *) echo '{"instance":{"state":"'"$(cat "$SANDBOX/maintenance-state" 2>/dev/null || echo off)"'","runningRuns":0}}' ;;
    esac ;;
  *api/health*) cat "$SANDBOX/health.json" ;;
  *companies/*/issues*) echo '{"issues": []}' ;;
  *companies/*/agents*) echo '[]' ;;
  *fleetd/health*)
    if [ -f "$SANDBOX/fleetd-health-bad" ]; then
      n="$(cat "$SANDBOX/fleetd-health-bad")"
      if [ "$n" -gt 0 ]; then echo $((n - 1)) > "$SANDBOX/fleetd-health-bad"; exit 1; fi
    fi
    echo OK ;;
  *) echo "{}" ;;
esac
`;

const labels = () => ({
  "org.opencontainers.image.revision": COMMIT,
  "org.opencontainers.image.source": SOURCE,
  "org.opencontainers.image.version": VERSION,
});
const sha12 = (buf) => crypto.createHash("sha256").update(buf).digest("hex").slice(0, 12);
const imageJson = (digest) => JSON.stringify({ config: { Labels: labels() }, manifest: { digest } });

const dgConfigJson = () =>
  JSON.stringify(
    {
      listen: "/run/myrmidon-dockergate/engine.sock",
      upstream: "/var/run/docker.sock",
      apiVersion: "1.45",
      caller: { container: "paperclip-server-1", containerLabels: { "a": "b" }, argv: ["node"], uid: 1000, gid: 1000, mode: "uid" },
      images: [`${CI_IMAGE}-hermes@sha256:${"9".repeat(64)}`],
      bots: [],
    },
    null,
    2,
  );

function canonicalUnit(composeDir, { components = true, extraFiles = [] } = {}) {
  const files = [`${composeDir}/docker-compose.yml`, `${composeDir}/docker-compose.myrmidon-image.yml`];
  if (components) files.push(`${composeDir}/docker-compose.myrmidon-dockergate.yml`, `${composeDir}/docker-compose.myrmidon-fleetd.yml`);
  files.push(...extraFiles);
  return fs
    .readFileSync(path.join(HERE, "paperclip.service.template"), "utf8")
    .replaceAll("__COMPOSE_DIR__", composeDir)
    .replaceAll("__COMPOSE_FILE_ARGS__", files.map((f) => `-f ${f}`).join(" "))
    .replaceAll("__COMPOSE_SERVICE__", "server");
}

function sandbox({
  // the images that run (containers) and what the generated override files say
  dgRunning = DG_RUNNING,
  dgOverride = DG_RUNNING,
  fdRunning = FD_RUNNING,
  fdOverride = FD_RUNNING,
  unit = "canonical", // canonical | legacy | none | foreign
  botRollout = false,
  maintenanceApi = false,
  dgConfigMode = 0o644,
  fleetdHealthUrl = true,
  composeConfig,
  extraConfig = [],
  dgHealthUrl = "",
  dumpHeader = "PGDMP",
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myrmidon-hardening-"));
  const bin = path.join(dir, "bin");
  const composeDir = path.join(dir, "compose");
  for (const d of [bin, composeDir, path.join(dir, "containers"), path.join(dir, "dg"), path.join(dir, "systemd")]) {
    fs.mkdirSync(d, { recursive: true });
  }
  const put = (name, text, mode) => fs.writeFileSync(path.join(bin, name), text, { mode: mode ?? 0o755 });
  put("docker", FAKE_DOCKER);
  put("curl", FAKE_CURL);
  put("git", FAKE_GIT);
  put("ssh", FAKE_SSH);
  put("systemctl", FAKE_SYSTEMCTL);
  put("dg-sim", DG_SIM);
  fs.writeFileSync(path.join(dir, "calls.log"), "");
  fs.writeFileSync(path.join(dir, "imagetools.json"), imageJson(`sha256:${"9".repeat(64)}`));
  fs.writeFileSync(path.join(dir, "imagetools-dockergate.json"), imageJson(DG));
  fs.writeFileSync(path.join(dir, "imagetools-fleetd.json"), imageJson(FD));
  fs.writeFileSync(path.join(dir, "git-origin"), `${ORIGIN}\n`);
  fs.writeFileSync(path.join(dir, "git-tags"), "");
  fs.writeFileSync(path.join(dir, "label-version"), `${VERSION}\n`);
  fs.writeFileSync(path.join(dir, "label-revision"), `${COMMIT}\n`);
  fs.writeFileSync(path.join(dir, "health.json"), JSON.stringify({ status: "ok", version: VERSION, commit: COMMIT }));

  // the compose project: the base file has no image for server; the override gives it one
  fs.writeFileSync(path.join(composeDir, "docker-compose.yml"), "services: {}\n");
  const boardOverride = path.join(composeDir, "docker-compose.myrmidon-image.yml");
  fs.writeFileSync(boardOverride, `services:\n  server:\n    image: ${CI_IMAGE}@${OLD}\n`);
  fs.writeFileSync(path.join(dir, "containers", "server.image"), `${CI_IMAGE}@${OLD}\n`);
  const dgOverridePath = path.join(composeDir, "docker-compose.myrmidon-dockergate.yml");
  const fdOverridePath = path.join(composeDir, "docker-compose.myrmidon-fleetd.yml");
  if (dgOverride) fs.writeFileSync(dgOverridePath, `services:\n  dockergate:\n    image: ${dgOverride}\n`);
  if (fdOverride) fs.writeFileSync(fdOverridePath, `services:\n  fleetd:\n    image: ${fdOverride}\n`);
  if (dgRunning) fs.writeFileSync(path.join(dir, "containers", "dockergate.image"), `${dgRunning}\n`);
  if (fdRunning) fs.writeFileSync(path.join(dir, "containers", "fleetd.image"), `${fdRunning}\n`);
  fs.writeFileSync(
    path.join(dir, "compose-config.json"),
    composeConfig ??
      JSON.stringify({
        services: {
          server: {
            image: `${CI_IMAGE}@${OLD}`,
            user: "node",
            working_dir: "/app",
            command: ["node", "server.js"],
            environment: {
              DATABASE_URL: `postgres://paperclip:${PROD_SECRET}@db:5432/paperclip?sslmode=disable`,
              FEATURE_FLAG: "on",
              PORT: "3100",
            },
          },
          db: { image: "postgres:17-alpine" },
        },
      }),
  );

  // dockergate: its config and the log it has written so far
  const dgConfig = path.join(dir, "dg", "config.json");
  fs.writeFileSync(dgConfig, dgConfigJson());
  fs.chmodSync(dgConfig, dgConfigMode);
  fs.writeFileSync(
    path.join(dir, "dg-log"),
    `${JSON.stringify({ event: "self-check ok", version: DG_VERSION, configHash: sha12(fs.readFileSync(dgConfig)) })}\n`,
  );

  // the boot unit
  const unitFile = path.join(dir, "systemd", "paperclip.service");
  if (unit === "canonical") fs.writeFileSync(unitFile, canonicalUnit(composeDir));
  else if (unit === "legacy") fs.writeFileSync(unitFile, canonicalUnit(composeDir, { components: false }));
  else if (unit === "foreign") fs.writeFileSync(unitFile, canonicalUnit(composeDir).replace("up -d --no-deps server", "up -d # vendor"));

  const calls = path.join(dir, "calls.log");
  const lines = [
    `COMPOSE_DIR=${composeDir}`,
    "COMPOSE_SERVICE=server",
    "HEALTH_URL=http://127.0.0.1:3100/api/health",
    "HEALTH_TIMEOUT_SEC=2",
    "POLL_INTERVAL_SEC=1",
    `STATE_DIR=${path.join(dir, "state")}`,
    `DUMP_DIR=${path.join(dir, "dumps")}`,
    `DUMP_COMMAND='printf ${dumpHeader} > "$DUMP_FILE"; head -c 2048 /dev/zero >> "$DUMP_FILE"'`,
    "RUNNING_RUNS_COMMAND='echo 0'",
    `SYSTEMD_UNIT_DIR=${path.join(dir, "systemd")}`,
    `BOARD_API_URL=http://127.0.0.1:3100/api`,
    `BOARD_COMPANY_ID=${COMPANY}`,
    ...(fleetdHealthUrl ? ["MYR_FLEETD_HEALTH_URL=http://127.0.0.1:3100/fleetd/health"] : []),
    ...(dgHealthUrl ? [`MYR_DOCKERGATE_HEALTH_URL='${dgHealthUrl}'`] : []),
    `DOCKERGATE_LOGS_COMMAND=''`,
  ];
  if (maintenanceApi) {
    lines.push("MAINTENANCE_MODE=api", "MAINTENANCE_API_URL=http://127.0.0.1:3100/api/maintenance");
  } else {
    lines.push(
      "MAINTENANCE_MODE=hook",
      `MAINTENANCE_ENTER_COMMAND='echo MAINT-ENTER >> ${calls}; echo enter >> ${path.join(dir, "maintenance.log")}'`,
      `MAINTENANCE_EXIT_COMMAND='echo MAINT-EXIT >> ${calls}; echo exit >> ${path.join(dir, "maintenance.log")}'`,
    );
  }
  if (botRollout) {
    lines.push(
      `MYRMIDON_BOT_IMAGE_ROLLOUT_DOCKERGATE_CONFIG=${dgConfig}`,
      `MYRMIDON_BOT_IMAGE_ROLLOUT_DOCKERGATE_SIGNAL_COMMAND=dg-sim`,
      "MYRMIDON_BOT_IMAGE_ROLLOUT_DOCKERGATE_RELOAD_TIMEOUT_SEC=2",
      "MYRMIDON_BOT_IMAGE_ROLLOUT_BOT_TIMEOUT_SEC=3",
    );
  } else {
    lines.push("MYRMIDON_BOT_IMAGE_ROLLOUT=0");
  }
  // PREDEPLOY-DB-CHECK (#579, predeploy-board-check.sh) is on by default and has
  // its own tests (predeploy-board-check.test.mjs, deploy.test.mjs); this file is
  // about the preflight, the images and the rollback, so it is switched off here.
  lines.push("MYRMIDON_PREDEPLOY_CHECK=0");
  lines.push("MYRMIDON_DEPLOY_SMOKE=0", ...extraConfig, "");
  const config = path.join(dir, "deploy.env");
  fs.writeFileSync(config, lines.join("\n"));
  return { dir, bin, config, composeDir, dgConfig, boardOverride, dgOverridePath, fdOverridePath, unitFile };
}

function run(sb, script, args, { umask, env } = {}) {
  const bash = process.env.PATH.split(":").map((d) => path.join(d, "bash")).find((f) => fs.existsSync(f));
  const argv = [path.join(HERE, script), "--config", sb.config, ...args];
  const cmd = umask ? ["-c", `umask ${umask}; exec "$@"`, "sh", bash, ...argv] : argv;
  const result = spawnSync(umask ? "sh" : bash, cmd, {
    env: { ...process.env, PATH: `${sb.bin}:${process.env.PATH}`, SANDBOX: sb.dir, ...(env ?? {}) },
    encoding: "utf8",
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
const calls = (sb) => read(path.join(sb.dir, "calls.log"));
const running = (sb, svc) => read(path.join(sb.dir, "containers", `${svc}.image`)).trim();
const overrideImage = (file) => (read(file).match(/image:\s*(\S+)/) ?? [])[1];
const noPullNoDump = (sb) => {
  assert.doesNotMatch(calls(sb), /docker pull/);
  assert.ok(!fs.existsSync(path.join(sb.dir, "dumps")), "no dump was taken");
  assert.doesNotMatch(calls(sb), /MAINT-ENTER/);
};

describe("A8 / failure 1: the component compose project includes the board image override", () => {
  it("the component preflight validates the whole file set and finds the service", () => {
    const sb = sandbox();
    const { code, out } = run(sb, "rollout-component.sh", ["--component", "dockergate", "--digest", DG, "--dry-run"]);
    assert.equal(code, 0, out);
    // `config --services` ran with the board image override among the -f files
    const line = calls(sb).split("\n").find((l) => /compose .*config --services/.test(l));
    assert.ok(line, "config --services was called");
    assert.match(line, /-f \S*docker-compose\.myrmidon-image\.yml/);
    assert.match(line, /-f \S*docker-compose\.myrmidon-dockergate\.yml/);
    assert.doesNotMatch(out, /is not a service/);
  });

  it("an invalid compose project is reported with compose's own error, not as 'not a service'", () => {
    const sb = sandbox();
    fs.writeFileSync(path.join(sb.dir, "compose-invalid"), "yaml: line 4: mapping values are not allowed in this context\n");
    const { code, out } = run(sb, "rollout-component.sh", ["--component", "dockergate", "--digest", DG, "--dry-run"]);
    assert.notEqual(code, 0, out);
    assert.match(out, /mapping values are not allowed in this context/);
    assert.match(out, /compose project itself cannot be read/);
    assert.doesNotMatch(out, /is not a service/);
  });

  it("a service that the valid project does not define is still refused as 'not a service'", () => {
    const sb = sandbox({ extraConfig: ["MYR_DOCKERGATE_COMPOSE_SERVICE=nosuchservice"] });
    const { code, out } = run(sb, "rollout-component.sh", ["--component", "dockergate", "--digest", DG, "--dry-run"]);
    assert.notEqual(code, 0, out);
    assert.match(out, /is not a service of the compose project/);
  });
});

describe("A2: --dry-run runs the preflights of the real run and fails exactly when it would", () => {
  const scenarios = [
    {
      name: "the compose project does not validate",
      setup: (sb) => fs.writeFileSync(path.join(sb.dir, "compose-invalid"), "services.server.build: invalid compose project text\n"),
      opts: {},
      expect: /invalid compose project text/,
    },
    {
      name: "dockergate check-config refuses the config",
      setup: (sb) => fs.writeFileSync(path.join(sb.dir, "check-config-fails"), "config: caller.uid must not be 0\n"),
      opts: { botRollout: true },
      expect: /caller\.uid must not be 0/,
    },
    {
      name: "dockergate cannot read its config (owner/mode)",
      setup: (sb) => fs.writeFileSync(path.join(sb.dir, "dg-runs-as-other"), ""),
      opts: { botRollout: true, dgConfigMode: 0o600 },
      expect: /permission denied/,
    },
    {
      name: "fleetd has no health URL",
      setup: () => {},
      opts: { fleetdHealthUrl: false },
      expect: /MYR_FLEETD_HEALTH_URL/,
    },
    {
      name: "the boot unit is foreign",
      setup: () => {},
      opts: { unit: "foreign" },
      expect: /boot unit/,
    },
    {
      name: "the board image was not built by CI",
      setup: (sb) => fs.writeFileSync(path.join(sb.dir, "git-tags"), ""),
      opts: {},
      expect: /built by CI|image refused/,
      mutate: (sb) => {
        const f = path.join(sb.dir, "imagetools.json");
        fs.writeFileSync(f, JSON.stringify({ config: { Labels: {} } }));
      },
    },
  ];
  for (const sc of scenarios) {
    it(`both runs fail before the first pull: ${sc.name}`, () => {
      const dry = sandbox(sc.opts);
      sc.setup(dry);
      sc.mutate?.(dry);
      const dryRun = run(dry, "deploy.sh", ["--digest", NEW, "--dry-run"]);
      const real = sandbox(sc.opts);
      sc.setup(real);
      sc.mutate?.(real);
      const realRun = run(real, "deploy.sh", ["--digest", NEW]);
      assert.notEqual(dryRun.code, 0, `dry run must fail:\n${dryRun.out}`);
      assert.notEqual(realRun.code, 0, `real run must fail:\n${realRun.out}`);
      assert.match(dryRun.out, sc.expect);
      assert.match(realRun.out, sc.expect);
      // the real run stopped before the pull, the dump and the window
      noPullNoDump(real);
      assert.equal(overrideImage(real.boardOverride), `${CI_IMAGE}@${OLD}`);
    });
  }

  it("a valid configuration passes the dry run and then the real run, with the same preflight", () => {
    const sb = sandbox({ botRollout: true });
    const dry = run(sb, "deploy.sh", ["--digest", NEW, "--dry-run"]);
    assert.equal(dry.code, 0, dry.out);
    assert.match(dry.out, /preflight ok/);
    // the dry run really asked compose and the dockergate binary
    const log = calls(sb);
    assert.match(log, /compose .*config --quiet/);
    assert.match(log, /compose .*config --services/);
    assert.match(log, /check-config/);
    assert.doesNotMatch(log, /docker pull/);
    assert.doesNotMatch(log, /up -d/);
    assert.equal(fs.existsSync(path.join(sb.dir, "dumps")), false);
    const real = run(sb, "deploy.sh", ["--digest", NEW]);
    assert.equal(real.code, 0, real.out);
    assert.match(real.out, /preflight ok/);
  });

  it("the dry run checks the EDITED dockergate config with the owner and mode of the real file", () => {
    // the real file is 0600: a service running as another user cannot read it
    const sb = sandbox({ botRollout: true, dgConfigMode: 0o600 });
    fs.writeFileSync(path.join(sb.dir, "dg-runs-as-other"), "");
    const before = read(sb.dgConfig);
    const { code, out } = run(sb, "deploy.sh", ["--digest", NEW, "--dry-run"]);
    assert.notEqual(code, 0, out);
    assert.match(out, /permission denied/);
    assert.equal(read(sb.dgConfig), before, "the dry run did not edit the config");
    assert.deepEqual(
      fs.readdirSync(path.join(sb.dir, "dg")),
      ["config.json"],
      "the dry run left no temp file behind",
    );
  });

  it("an unsynced boot unit is accepted by the dry run exactly when SYSTEMD_UNIT_INSTALL=1 lets the real run update it", () => {
    for (const install of [false, true]) {
      const dry = sandbox({ unit: "legacy", extraConfig: install ? ["SYSTEMD_UNIT_INSTALL=1"] : [] });
      const real = sandbox({ unit: "legacy", extraConfig: install ? ["SYSTEMD_UNIT_INSTALL=1"] : [] });
      const d = run(dry, "deploy.sh", ["--digest", NEW, "--dry-run"]);
      const r = run(real, "deploy.sh", ["--digest", NEW]);
      assert.equal(d.code === 0, r.code === 0, `install=${install}\ndry:\n${d.out}\nreal:\n${r.out}`);
      assert.equal(r.code === 0, install);
    }
  });
});

describe("A1 / failure 3: one source of truth per component image", () => {
  it("the canonical boot unit lists the override files of the local release components", () => {
    const sb = sandbox({ unit: "none", extraConfig: ["SYSTEMD_UNIT_INSTALL=1"] });
    const { code, out } = run(sb, "deploy.sh", ["--digest", NEW]);
    assert.equal(code, 0, out);
    const unit = read(sb.unitFile);
    assert.match(unit, new RegExp(`-f ${sb.composeDir}/docker-compose\\.myrmidon-image\\.yml -f ${sb.composeDir}/docker-compose\\.myrmidon-dockergate\\.yml -f ${sb.composeDir}/docker-compose\\.myrmidon-fleetd\\.yml`));
  });

  it("a component that does not live on this host is not part of its boot unit", () => {
    const sb = sandbox({ unit: "none", extraConfig: ["SYSTEMD_UNIT_INSTALL=1", "MYR_FLEETD_HOST=skip"] });
    const { code, out } = run(sb, "deploy.sh", ["--digest", NEW, "--dry-run"]);
    assert.equal(code, 0, out);
    const real = run(sb, "deploy.sh", ["--digest", NEW]);
    assert.equal(real.code, 0, real.out);
    assert.doesNotMatch(read(sb.unitFile), /myrmidon-fleetd/);
    assert.match(read(sb.unitFile), /myrmidon-dockergate/);
  });

  it("the unit of the previous release is replaced with SYSTEMD_UNIT_INSTALL=1 and refused without it", () => {
    const refused = sandbox({ unit: "legacy" });
    const r1 = run(refused, "deploy.sh", ["--digest", NEW]);
    assert.notEqual(r1.code, 0, r1.out);
    assert.match(r1.out, /does not match the canonical unit/);
    assert.match(r1.out, /override files of the local release components/);
    assert.match(read(refused.unitFile), /^ExecStart=.*image\.yml up -d/m);
    noPullNoDump(refused);

    const updated = sandbox({ unit: "legacy", extraConfig: ["SYSTEMD_UNIT_INSTALL=1"] });
    const r2 = run(updated, "deploy.sh", ["--digest", NEW]);
    assert.equal(r2.code, 0, r2.out);
    assert.match(r2.out, /boot unit updated/);
    assert.match(read(updated.unitFile), /myrmidon-dockergate\.yml/);
    assert.match(calls(updated), /systemctl daemon-reload/);
  });

  it("a foreign unit is never replaced, even with SYSTEMD_UNIT_INSTALL=1", () => {
    const sb = sandbox({ unit: "foreign", extraConfig: ["SYSTEMD_UNIT_INSTALL=1"] });
    const before = read(sb.unitFile);
    const { code, out } = run(sb, "deploy.sh", ["--digest", NEW]);
    assert.notEqual(code, 0, out);
    assert.equal(read(sb.unitFile), before);
  });

  it("a stale override is corrected to the image that runs before anything changes", () => {
    const sb = sandbox({ dgOverride: DG_STALE });
    const { code, out } = run(sb, "deploy.sh", ["--digest", NEW]);
    assert.equal(code, 0, out);
    assert.match(out, new RegExp(`override \\S*dockergate\\.yml: ${DG_STALE} -> ${DG_RUNNING}`));
    // and the deploy recorded the RUNNING image as the previous one
    assert.equal(read(path.join(sb.dir, "state", "previous-dockergate-image")).trim(), DG_RUNNING);
  });

  it("the rollback restores dockergate to the image that ran, not to the stale override", () => {
    // the override file says STALE, the container runs RUNNING; fleetd then fails its health
    // check, so the window rolls everything back
    const sb = sandbox({ dgOverride: DG_STALE });
    fs.writeFileSync(path.join(sb.dir, "fleetd-health-bad"), "3");
    const { code, out } = run(sb, "deploy.sh", ["--digest", NEW]);
    assert.notEqual(code, 0, out);
    assert.match(out, /ROLLED BACK/);
    assert.equal(running(sb, "dockergate"), DG_RUNNING, "dockergate runs the image it ran before the deploy");
    assert.equal(overrideImage(sb.dgOverridePath), DG_RUNNING, "its override names the same image");
    assert.equal(running(sb, "fleetd"), FD_RUNNING);
    assert.equal(overrideImage(sb.fdOverridePath), FD_RUNNING);
    assert.notEqual(running(sb, "dockergate"), DG_STALE);
  });

  it("the board's previous image is the running container's: a stale override and a stale state file lose", () => {
    const STALE = `${CI_IMAGE}@sha256:${"5".repeat(64)}`;
    const sb = sandbox();
    // the container runs OLD; the override file and the previous-image state file say something else
    fs.writeFileSync(sb.boardOverride, `services:\n  server:\n    image: ${STALE}\n`);
    fs.mkdirSync(path.join(sb.dir, "state"), { recursive: true });
    fs.writeFileSync(path.join(sb.dir, "state", "previous-image"), `${STALE}\n`);
    fs.writeFileSync(path.join(sb.dir, "fleetd-health-bad"), "3");
    const { code, out } = run(sb, "deploy.sh", ["--digest", NEW]);
    assert.notEqual(code, 0, out);
    assert.match(out, new RegExp(`override \\S*image\\.yml: ${STALE} -> ${CI_IMAGE}@${OLD}`));
    assert.match(out, /ROLLED BACK/);
    assert.equal(running(sb, "server"), `${CI_IMAGE}@${OLD}`, "the rollback targeted the running image");
    assert.equal(overrideImage(sb.boardOverride), `${CI_IMAGE}@${OLD}`);
  });

  it("rollback.sh records the running board image, not the override file, as the way back", () => {
    const sb = sandbox();
    const STALE = `${CI_IMAGE}@sha256:${"5".repeat(64)}`;
    fs.writeFileSync(sb.boardOverride, `services:\n  server:\n    image: ${STALE}\n`);
    const { code, out } = run(sb, "rollback.sh", ["--to-image", `${CI_IMAGE}@${NEW}`]);
    assert.equal(code, 0, out);
    assert.match(out, /names .*5{64} but the board container runs .*a{64}/);
    assert.equal(read(path.join(sb.dir, "state", "previous-image")).trim(), `${CI_IMAGE}@${OLD}`);
  });

  it("the previous image is read from the container (docker inspect), not from the file", () => {
    const sb = sandbox({ dgOverride: null });
    const { code, out } = run(sb, "rollout-component.sh", ["--component", "dockergate", "--digest", DG]);
    assert.equal(code, 0, out);
    assert.equal(read(path.join(sb.dir, "state", "previous-dockergate-image")).trim(), DG_RUNNING);
    assert.match(calls(sb), /docker inspect --format \{\{\.Config\.Image\}\} cid-dockergate/);
  });
});

describe("A4 / failure 2: dockergate is proven by its log, not by a ping the host cannot make", () => {
  const SOCKET_PROBE = "--unix-socket /run/myrmidon-dockergate/engine.sock http://localhost/_ping";

  it("a healthy dockergate passes although the documented socket probe returns 403", () => {
    const sb = sandbox({ botRollout: true, dgHealthUrl: SOCKET_PROBE });
    const { code, out } = run(sb, "rollout-component.sh", ["--component", "dockergate", "--digest", DG]);
    assert.equal(code, 0, out);
    assert.match(out, /MYR_DOCKERGATE_HEALTH_URL is ignored/);
    assert.match(out, /dockergate runs: version 1\.4\.0\+0123456789ab, config hash [0-9a-f]{12}/);
    assert.doesNotMatch(calls(sb), /--unix-socket/, "the host never pings the socket");
  });

  it("works with no health URL at all", () => {
    const sb = sandbox({ botRollout: true });
    const { code, out } = run(sb, "rollout-component.sh", ["--component", "dockergate", "--digest", DG]);
    assert.equal(code, 0, out);
  });

  it("fails when the log reports another version than the new binary's", () => {
    const sb = sandbox({ botRollout: true });
    const { code, out } = run(sb, "rollout-component.sh", ["--component", "dockergate", "--digest", DG], { env: { DG_LOGGED_VERSION: "1.3.0+aaaaaaaaaaaa" } });
    assert.notEqual(code, 0, out);
    assert.match(out, /reports version '1\.3\.0\+aaaaaaaaaaaa', expected '1\.4\.0\+0123456789ab'/);
    assert.match(out, /DEGRADED/);
  });

  it("fails when the process did not load the expected config (hash differs)", () => {
    const sb = sandbox({ botRollout: true });
    fs.writeFileSync(path.join(sb.dir, "dg-stale-hash"), "");
    const { code, out } = run(sb, "rollout-component.sh", ["--component", "dockergate", "--digest", DG]);
    assert.notEqual(code, 0, out);
    assert.match(out, /config hash 'deadbeef0000', expected '[0-9a-f]{12}'/);
  });

  it("fails when the container crash-loops", () => {
    const sb = sandbox({ botRollout: true });
    fs.writeFileSync(path.join(sb.dir, "dg-crashloop"), "");
    const { code, out } = run(sb, "rollout-component.sh", ["--component", "dockergate", "--digest", DG]);
    assert.notEqual(code, 0, out);
    assert.match(out, /the container is 'restarting', not running/);
  });

  it("a whole deploy does not declare a healthy dockergate dead, and does not roll back", () => {
    const sb = sandbox({ botRollout: true, dgHealthUrl: SOCKET_PROBE });
    const { code, out } = run(sb, "deploy.sh", ["--digest", NEW]);
    assert.equal(code, 0, out);
    assert.doesNotMatch(out, /ROLLING BACK/);
    assert.equal(running(sb, "dockergate"), `${DG_REPO}@${DG}`);
  });

  it("the rollback's own health check passes the same way (no ROLLBACK INCOMPLETE)", () => {
    const sb = sandbox({ dgHealthUrl: SOCKET_PROBE });
    const { code, out } = run(sb, "rollback-component.sh", ["--component", "dockergate", "--to-image", DG_RUNNING]);
    assert.equal(code, 0, out);
    assert.match(out, /rolled dockergate back/);
    assert.equal(running(sb, "dockergate"), DG_RUNNING);
  });

  it("the rollback fails when dockergate does not come up on the restored image", () => {
    const sb = sandbox();
    fs.writeFileSync(path.join(sb.dir, "dg-crashloop"), "");
    const { code, out } = run(sb, "rollback-component.sh", ["--component", "dockergate", "--to-image", DG_RUNNING]);
    assert.notEqual(code, 0, out);
    assert.match(out, /did not prove healthy after the rollback/);
  });

  it("a failed component rollout rolls everything back and the rollback verifies dockergate by its log", () => {
    const sb = sandbox({ botRollout: true, dgHealthUrl: SOCKET_PROBE });
    fs.writeFileSync(path.join(sb.dir, "fleetd-health-bad"), "3");
    const { code, out } = run(sb, "deploy.sh", ["--digest", NEW]);
    assert.notEqual(code, 0, out);
    assert.match(out, /ROLLED BACK/);
    assert.doesNotMatch(out, /ROLLBACK INCOMPLETE/);
    assert.equal(running(sb, "dockergate"), DG_RUNNING);
  });
});

describe("A5 / failure 4: a config write keeps the owner and mode; a reload is verified", () => {
  const botArgs = ["--phase", "config", "--resolution", "tag", "--ref", VERSION, "--dockergate-image", `${DG_REPO}@${DG}`];
  const withBotImages = (sb) => {
    for (const [name, digest] of [["hermes", "e"], ["hermes-dev", "f"], ["hermes-node", "a"]]) {
      fs.writeFileSync(path.join(sb.dir, `imagetools-${name}.json`), imageJson(`sha256:${digest.repeat(64)}`));
    }
  };
  const botDigests = ["--digest", `hermes=sha256:${"e".repeat(64)}`, "--digest", `hermes-dev=sha256:${"f".repeat(64)}`, "--digest", `hermes-node=sha256:${"a".repeat(64)}`];
  const mode = (file) => (fs.statSync(file).mode & 0o777).toString(8);

  for (const m of [0o644, 0o640]) {
    it(`a strict umask does not turn a ${m.toString(8)} config into 0600`, () => {
      const sb = sandbox({ botRollout: true, dgConfigMode: m });
      withBotImages(sb);
      const { code, out } = run(sb, "bot-image-rollout.sh", [...botArgs, ...botDigests], { umask: "077" });
      assert.equal(code, 0, out);
      assert.match(read(sb.dgConfig), /myrmidon-hermes-dev@sha256:f{64}/, "the config was edited");
      assert.equal(mode(sb.dgConfig), m.toString(8), "the mode of the original file is kept");
      assert.deepEqual(fs.readdirSync(path.join(sb.dir, "dg")), ["config.json"], "no temp file is left");
    });
  }

  it("keeps the owner of the original file (when the test runs as root)", { skip: process.getuid?.() !== 0 }, () => {
    const sb = sandbox({ botRollout: true });
    withBotImages(sb);
    fs.chownSync(sb.dgConfig, 65532, 65532);
    const { code, out } = run(sb, "bot-image-rollout.sh", [...botArgs, ...botDigests], { umask: "077" });
    assert.equal(code, 0, out);
    assert.equal(fs.statSync(sb.dgConfig).uid, 65532);
    assert.equal(fs.statSync(sb.dgConfig).gid, 65532);
  });

  it("the check-config of the edited file runs as the service user and passes when the mode is kept", () => {
    const sb = sandbox({ botRollout: true, dgConfigMode: 0o644 });
    withBotImages(sb);
    fs.writeFileSync(path.join(sb.dir, "dg-runs-as-other"), "");
    const { code, out } = run(sb, "bot-image-rollout.sh", [...botArgs, ...botDigests], { umask: "077" });
    assert.equal(code, 0, out);
  });

  it("the override files keep their mode too", () => {
    const sb = sandbox();
    fs.chmodSync(sb.dgOverridePath, 0o640);
    const { code, out } = run(sb, "rollout-component.sh", ["--component", "dockergate", "--digest", DG], { umask: "077" });
    assert.equal(code, 0, out);
    assert.equal(mode(sb.dgOverridePath), "640");
    fs.chmodSync(sb.boardOverride, 0o644);
    const dep = run(sb, "deploy.sh", ["--digest", NEW, "--force"], { umask: "077" });
    assert.equal(dep.code, 0, dep.out);
    assert.equal(mode(sb.boardOverride), "644");
  });

  it("after SIGHUP the rollout checks that dockergate loaded the new config hash", () => {
    const sb = sandbox({ botRollout: true });
    withBotImages(sb);
    const { code, out } = run(sb, "bot-image-rollout.sh", [...botArgs, ...botDigests]);
    assert.equal(code, 0, out);
    const hash = sha12(fs.readFileSync(sb.dgConfig));
    assert.match(out, new RegExp(`dockergate reloaded \\(SIGHUP\\): it runs config hash ${hash}`));
    assert.match(read(path.join(sb.dir, "dg-log")), new RegExp(`"configHash":"${hash}"`));
  });

  it("fails loudly when the reload did not take effect (the old allowlist stays in memory)", () => {
    const sb = sandbox({ botRollout: true });
    withBotImages(sb);
    fs.writeFileSync(path.join(sb.dir, "dg-reload-fails"), "");
    const { code, out } = run(sb, "bot-image-rollout.sh", [...botArgs, ...botDigests]);
    assert.notEqual(code, 0, out);
    assert.match(out, /dockergate did not load the new config after SIGHUP/);
    assert.match(out, /expected config hash [0-9a-f]{12}/);
    assert.match(out, /owner and mode/);
  });

  it("a deploy whose reload fails rolls back and tells the dockergate config was restored and reloaded", () => {
    const sb = sandbox({ botRollout: true });
    fs.writeFileSync(path.join(sb.dir, "dg-reload-fails"), "");
    // dockergate is already on the release image: only its config changes (SIGHUP)
    fs.writeFileSync(path.join(sb.dir, "containers", "dockergate.image"), `${DG_REPO}@${DG}\n`);
    fs.writeFileSync(sb.dgOverridePath, `services:\n  dockergate:\n    image: ${DG_REPO}@${DG}\n`);
    const before = read(sb.dgConfig);
    const { code, out } = run(sb, "deploy.sh", ["--digest", NEW]);
    assert.notEqual(code, 0, out);
    assert.match(out, /dockergate did not load the new config after SIGHUP/);
    assert.equal(read(sb.dgConfig), before, "the config file is restored");
  });
});

describe("A6 / failure 5: the output of check-config is logged on refusal", () => {
  const args = ["--phase", "config", "--resolution", "tag", "--ref", VERSION, "--dockergate-image", `${DG_REPO}@${DG}`,
    "--digest", `hermes=sha256:${"e".repeat(64)}`, "--digest", `hermes-dev=sha256:${"f".repeat(64)}`, "--digest", `hermes-node=sha256:${"a".repeat(64)}`];

  it("the refusal of the binary shows its reason (stdout and stderr)", () => {
    const sb = sandbox({ botRollout: true });
    fs.writeFileSync(path.join(sb.dir, "check-config-fails"), "config: open /etc/myrmidon-dockergate/config.json: permission denied\n");
    const { code, out } = run(sb, "bot-image-rollout.sh", args);
    assert.notEqual(code, 0, out);
    assert.match(out, /dockergate check-config refused .* \(exit 1\); its output:/);
    assert.match(out, /\| config: open \/etc\/myrmidon-dockergate\/config\.json: permission denied/);
    assert.match(out, /check-config refused the edited config/);
  });

  it("a root-only config the service user cannot open is refused with that reason visible", () => {
    const sb = sandbox({ botRollout: true, dgConfigMode: 0o600 });
    fs.writeFileSync(path.join(sb.dir, "dg-runs-as-other"), "");
    const { code, out } = run(sb, "bot-image-rollout.sh", args);
    assert.notEqual(code, 0, out);
    assert.match(out, /\| config: open .*: permission denied/);
  });

  it("an operator's check command has both streams logged", () => {
    const sb = sandbox({
      botRollout: true,
      extraConfig: [`MYRMIDON_BOT_IMAGE_ROLLOUT_DOCKERGATE_CHECK_CONFIG_COMMAND='echo out-line; echo err-line >&2; exit 3'`],
    });
    const { code, out } = run(sb, "bot-image-rollout.sh", args);
    assert.notEqual(code, 0, out);
    assert.match(out, /\| out-line/);
    assert.match(out, /\| err-line/);
  });

  it("the component rollout logs the refusal too", () => {
    const sb = sandbox({ botRollout: true });
    fs.writeFileSync(path.join(sb.dir, "check-config-fails"), "config: bots[0].maxPids is out of range\n");
    const { code, out } = run(sb, "rollout-component.sh", ["--component", "dockergate", "--digest", DG]);
    assert.notEqual(code, 0, out);
    assert.match(out, /\| config: bots\[0\]\.maxPids is out of range/);
  });
});
