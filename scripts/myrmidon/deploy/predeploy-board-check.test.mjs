import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// Runs the real predeploy-board-check.sh against fake `docker` and `curl`
// binaries placed first in PATH: the same style as deploy.test.mjs and
// post-boot-check.test.mjs. The fakes answer from files in the sandbox, so the
// throwaway stack can be made green or red per test; no real container, daemon
// or registry is touched.
//
// PREDEPLOY-DB-CHECK (the 05.10 incident): the new board image must come up on a
// COPY of the production database (the predeploy dump), next to the new
// dockergate, on its own network, before the maintenance window opens.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NEW = `sha256:${"b".repeat(64)}`;
const DG = `sha256:${"c".repeat(64)}`;
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const VERSION = "2026.916.1-myr.1";
const IMAGE = "ghcr.io/itkadr-git/myrmidon";
const DOCKERGATE_REPO = "ghcr.io/itkadr-git/myrmidon-dockergate";
const COMPANY = "2870b911-483a-4091-9f15-183841811143";

// Fake docker: every call is logged; the answers come from sandbox files.
const FAKE_DOCKER = `#!/usr/bin/env bash
echo "docker $*" >> "$SANDBOX/calls.log"
case "$1" in
  network)
    [ -e "$SANDBOX/network-fails" ] && { echo "Error: network create failed" >&2; exit 1; }
    exit 0 ;;
  run)
    name=""
    prev=""
    for a in "$@"; do
      [ "$prev" = "--name" ] && name="$a"
      prev="$a"
    done
    if [ -n "$name" ] && [ -f "$SANDBOX/run-fails" ] && grep -qxF "$name" "$SANDBOX/run-fails"; then
      echo "Error: cannot start container $name" >&2; exit 1
    fi
    echo "0123456789ab"
    exit 0 ;;
  exec)
    case "$*" in *pg_restore*)
      # myrmidon(PREDEPLOY-NO-ACL): models a dump with GRANTs to production-only
      # roles. Such a dump restores only when pg_restore skips privileges:
      # without --no-acl the restore aborts on the missing role, exactly like
      # the real pg_restore on "GRANT ... TO backup_ro" when backup_ro is absent.
      if [ -e "$SANDBOX/grant-to-missing-role" ] && ! printf '%s' "$*" | grep -q -- '--no-acl'; then
        echo 'pg_restore: error: could not execute query: ERROR: role "backup_ro" does not exist' >&2
        exit 1
      fi
      [ -e "$SANDBOX/restore-fails" ] && exit 1 ;;
    esac
    exit 0 ;;
  logs)
    name=""
    for a in "$@"; do case "$a" in myr-predeploy-*) name="$a" ;; esac; done
    if [ -n "$name" ] && [ -f "$SANDBOX/logs-$name" ]; then cat "$SANDBOX/logs-$name"; else echo "container $name: no such logs"; fi
    exit 0 ;;
  rm)
    exit 0 ;;
  volume)
    # DEPLOY-HYGIENE: the copy's named volume must be removed by the trap
    exit 0 ;;
  image)
    case "$*" in
      *org.opencontainers.image.version*) cat "$SANDBOX/label-version"; exit 0 ;;
      *org.opencontainers.image.revision*) cat "$SANDBOX/label-revision"; exit 0 ;;
    esac
    exit 0 ;;
esac
exit 0
`;

// Fake curl: -w prints an http code (200 unless the sandbox says otherwise);
// a plain call prints the health body. down-urls makes a URL unreachable.
const FAKE_CURL = `#!/usr/bin/env bash
echo "curl $*" >> "$SANDBOX/calls.log"
url=""; has_w=0
for a in "$@"; do
  case "$a" in http*) url="$a" ;; esac
  [ "$a" = "-w" ] && has_w=1
done
if [ -e "$SANDBOX/down-urls" ] && grep -qF "$url" "$SANDBOX/down-urls"; then
  echo "curl: (7) Failed to connect to $url" >&2; exit 7
fi
if [ "$has_w" = "1" ]; then
  code="200"
  if [ -f "$SANDBOX/http-codes" ]; then
    while read -r pattern value; do
      [ -n "$pattern" ] || continue
      case "$url" in *"$pattern"*) code="$value" ;; esac
    done < "$SANDBOX/http-codes"
  fi
  printf '%s' "$code"
  # curl without -f exits 0 whatever the code: the caller reads the printed
  # http_code. Only an unreachable URL (handled above) exits non-zero.
  exit 0
fi
cat "$SANDBOX/health.json"
`;

function sandbox({
  health = { status: "ok", version: VERSION, commit: COMMIT },
  labelVersion = VERSION,
  labelRevision = COMMIT,
  omit = [],
  extraConfig = "",
  envFileContent = "JWT_SECRET=test-secret\nMYRMIDON_BOT_DOCKER_SOCKET=/run/myrmidon-dockergate/engine.sock\n",
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myrmidon-predeploy-"));
  const bin = path.join(dir, "bin");
  const composeDir = path.join(dir, "compose");
  const stateDir = path.join(dir, "state");
  fs.mkdirSync(bin);
  fs.mkdirSync(composeDir);
  fs.writeFileSync(path.join(bin, "docker"), FAKE_DOCKER, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "curl"), FAKE_CURL, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "calls.log"), "");
  fs.writeFileSync(path.join(dir, "health.json"), JSON.stringify(health));
  fs.writeFileSync(path.join(dir, "label-version"), `${labelVersion}\n`);
  fs.writeFileSync(path.join(dir, "label-revision"), `${labelRevision}\n`);
  const dump = path.join(dir, "myrmidon.dump");
  fs.writeFileSync(dump, "x".repeat(2048));
  const boardEnv = path.join(dir, "board.env");
  fs.writeFileSync(boardEnv, envFileContent);
  const wanted = new Map([
    ["MYRMIDON_IMAGE", `MYRMIDON_IMAGE=${IMAGE}`],
    ["COMPOSE_DIR", `COMPOSE_DIR=${composeDir}`],
    ["COMPOSE_SERVICE", "COMPOSE_SERVICE=server"],
    ["HEALTH_URL", "HEALTH_URL=http://127.0.0.1:3100/api/health"],
    ["HEALTH_TIMEOUT_SEC", "HEALTH_TIMEOUT_SEC=2"],
    ["POLL_INTERVAL_SEC", "POLL_INTERVAL_SEC=1"],
    ["STATE_DIR", `STATE_DIR=${stateDir}`],
    ["DUMP_DIR", `DUMP_DIR=${path.join(dir, "dumps")}`],
    ["BOARD_COMPANY_ID", `BOARD_COMPANY_ID=${COMPANY}`],
    ["MYRMIDON_PREDEPLOY_POSTGRES_IMAGE", "MYRMIDON_PREDEPLOY_POSTGRES_IMAGE=postgres:16-alpine"],
    ["MYRMIDON_PREDEPLOY_BOARD_ENV_FILE", `MYRMIDON_PREDEPLOY_BOARD_ENV_FILE=${boardEnv}`],
    ["MYRMIDON_PREDEPLOY_BOARD_PORT", "MYRMIDON_PREDEPLOY_BOARD_PORT=13110"],
    ["MYRMIDON_PREDEPLOY_HEALTH_TIMEOUT_SEC", "MYRMIDON_PREDEPLOY_HEALTH_TIMEOUT_SEC=2"],
  ]);
  for (const key of omit) wanted.delete(key);
  const config = path.join(dir, "deploy.env");
  fs.writeFileSync(config, [...wanted.values(), extraConfig, ""].join("\n"));
  return { dir, bin, config, composeDir, stateDir, dump, boardEnv };
}

function run(sb, args, extraEnv = {}) {
  const result = spawnSync(
    process.env.PATH.split(":").map((d) => path.join(d, "bash")).find((f) => fs.existsSync(f)),
    [path.join(HERE, "predeploy-board-check.sh"), "--config", sb.config, ...args],
    { env: { ...process.env, PATH: `${sb.bin}:${process.env.PATH}`, SANDBOX: sb.dir, ...extraEnv }, encoding: "utf8" },
  );
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
const calls = (sb) => read(path.join(sb.dir, "calls.log"));
const full = (sb, ...args) => run(sb, ["--digest", NEW, "--dump", sb.dump, ...args]);

describe("predeploy-board-check.sh (PREDEPLOY-DB-CHECK: the 05.10 incident)", () => {
  it("proves the image on a copy of the production database: own network, the new dockergate, the attention list, teardown", () => {
    const sb = sandbox();
    const { code, out } = full(sb, "--dockergate-digest", DG);
    assert.equal(code, 0, out);
    const log = calls(sb);
    // its own network: created, used by all three containers, removed at the end
    assert.match(log, /docker network create myr-predeploy-bbbbbbbb-\d+/);
    assert.match(log, /docker run -d --name myr-predeploy-db-[^ ]+ --network myr-predeploy-/);
    assert.match(log, /docker run -d --name myr-predeploy-dockergate-[^ ]+ --network myr-predeploy-/);
    assert.match(log, /docker run -d --name myr-predeploy-board-[^ ]+ --network myr-predeploy-/);
    // the copy is a Postgres created with the configured database/user
    assert.match(log, /-e POSTGRES_DB=myrmidon/);
    assert.match(log, /postgres:16-alpine/);
    // the NEW dockergate of the release, from its digest, on the same network
    assert.match(log, new RegExp(`docker run -d --name myr-predeploy-dockergate-[^ ]+ --network myr-predeploy-[^ ]+ ${DOCKERGATE_REPO}@${DG}`));
    // the board of this release, on 127.0.0.1 only, from the copy's env file
    assert.match(log, new RegExp(`docker run -d --name myr-predeploy-board-[^ ]+ --network myr-predeploy-[^ ]+ --env-file ${sb.stateDir}/predeploy-board.env -p 127\\.0\\.0\\.1:13110:3100 ${IMAGE}@${NEW}`));
    // the dump was restored, then the attention list and the main routes walked
    assert.match(log, /docker exec /);
    assert.match(log, new RegExp(`curl .*http://127\\.0\\.0\\.1:13110/api/health`));
    assert.match(log, new RegExp(`curl .*http://127\\.0\\.0\\.1:13110/api/companies/${COMPANY}/attention`));
    assert.match(log, new RegExp(`curl .*http://127\\.0\\.0\\.1:13110/api/companies/${COMPANY}/issues\\?limit=1`));
    assert.match(out, /board ok on the copy/);
    assert.match(out, /passed: .* comes up ok on a copy of the production database/);
    // DEPLOY-HYGIENE (OPE-5107): the copy's data lives in a NAMED volume of
    // this run (an anonymous one survives `docker rm -f` and stays on the
    // disk), mounted into the throwaway Postgres and removed with the stack
    assert.match(log, /docker run -d --name myr-predeploy-db-[^ ]+ --network myr-predeploy-[^ ]+ -v myr-predeploy-dbvol-bbbbbbbb-\d+:\/var\/lib\/postgresql\/data/);
    assert.match(log, /docker volume rm -f myr-predeploy-dbvol-bbbbbbbb-\d+/);
    // everything was removed again
    assert.match(log, /docker rm -f myr-predeploy-board-[^ ]+ myr-predeploy-dockergate-[^ ]+ myr-predeploy-db-/);
    assert.match(log, /docker network rm myr-predeploy-/);
  });

  it("the throwaway board only ever sees the copy's DATABASE_URL (production credentials in the env file are ignored)", () => {
    const sb = sandbox({
      envFileContent: [
        "JWT_SECRET=test-secret",
        "DATABASE_URL=postgres://produser:prodpassword@db-prod.example:5432/prod",
        "MYRMIDON_BOT_DOCKER_SOCKET=/run/myrmidon-dockergate/engine.sock",
      ].join("\n"),
    });
    const { code, out } = full(sb);
    assert.equal(code, 0, out);
    const env = read(path.join(sb.stateDir, "predeploy-board.env"));
    assert.doesNotMatch(env, /prodpassword|db-prod\.example/);
    assert.match(env, /^JWT_SECRET=test-secret$/m);
    assert.match(env, /^MYRMIDON_BOT_DOCKER_SOCKET=\/run\/myrmidon-dockergate\/engine\.sock$/m);
    assert.match(env, /^DATABASE_URL=postgres:\/\/myrmidon:[^@]+@myr-predeploy-db-[^:]+:5432\/myrmidon$/m);
    assert.match(out, /the DATABASE_URL of .* is ignored: the throwaway board talks to the copy/);
  });

  it("the board that does not come up on the copy fails the check (the 05.10 signature)", () => {
    // The board starts on CI's empty database and never becomes ok on data like
    // production's — exactly what release 1.6.3 did inside the maintenance window.
    const sb = sandbox({ health: { status: "degraded", version: VERSION, commit: COMMIT } });
    const { code, out } = full(sb);
    assert.notEqual(code, 0, out);
    assert.match(out, /did not come up on the copy/);
    assert.match(out, /does not start on the copy of the production database/);
    assert.match(out, /stops BEFORE the maintenance window, production was not touched/);
    // the container logs are the operator's evidence, and the stack is removed
    assert.match(out, /logs of myr-predeploy-board-/);
    assert.match(calls(sb), /docker rm -f myr-predeploy-board-/);
    // DEPLOY-HYGIENE: a FAILED check removes the copy's volume too (the trap
    // runs on every exit) — the 3.4/3.6 GB orphans of 05.10 and rc.3 were
    // exactly failed/successful checks whose volume survived
    assert.match(calls(sb), /docker volume rm -f myr-predeploy-dbvol-/);
  });

  it("a 5xx from the attention list fails the check (the data path 1.6.3 broke)", () => {
    const sb = sandbox();
    fs.writeFileSync(path.join(sb.dir, "http-codes"), "attention 500\n");
    const { code, out } = full(sb);
    assert.notEqual(code, 0, out);
    assert.match(out, /\/api\/companies\/[^ ]+\/attention answered HTTP 500/);
    assert.match(out, /stops BEFORE the maintenance window/);
  });

  it("an unreachable route fails the check", () => {
    const sb = sandbox();
    fs.writeFileSync(path.join(sb.dir, "down-urls"), `http://127.0.0.1:13110/api/companies/${COMPANY}/dashboard\n`);
    const { code, out } = full(sb);
    assert.notEqual(code, 0, out);
    assert.match(out, /did not answer .*dashboard \(curl exit 7\)/);
  });

  it("a 401/403 is a warning without credentials and a failure with them", () => {
    const anon = sandbox();
    fs.writeFileSync(path.join(anon.dir, "http-codes"), "attention 403\n");
    const anonRun = full(anon);
    assert.equal(anonRun.code, 0, anonRun.out);
    assert.match(anonRun.out, /WARNING .*attention answered HTTP 403/);
    assert.match(anonRun.out, /no credentials are configured/);

    const withToken = sandbox();
    const tokenFile = path.join(withToken.dir, "board-token");
    fs.writeFileSync(tokenFile, "test-board-token\n");
    fs.appendFileSync(withToken.config, `MYRMIDON_PREDEPLOY_TOKEN_FILE=${tokenFile}\n`);
    fs.writeFileSync(path.join(withToken.dir, "http-codes"), "attention 403\n");
    const tokenRun = full(withToken);
    assert.notEqual(tokenRun.code, 0, tokenRun.out);
    assert.match(tokenRun.out, /refused the configured credentials \(HTTP 403\)/);
  });

  it("a token file that is set but unusable stops the check before the first docker call", () => {
    // The token stays optional (without it a 401/403 is a warning), but a file
    // that IS configured is an input of this step: a missing, unreadable or
    // empty token file must fail with the other inputs — before Postgres is
    // started and the dump restored — and not in auth_header_args while waiting
    // for health, where the message never says the check's inputs were wrong.

    // set, but there is no such file
    const missing = sandbox();
    fs.appendFileSync(missing.config, `MYRMIDON_PREDEPLOY_TOKEN_FILE=${path.join(missing.dir, "absent-token")}\n`);
    const missingRun = full(missing);
    assert.notEqual(missingRun.code, 0, missingRun.out);
    assert.match(missingRun.out, /MYRMIDON_PREDEPLOY_TOKEN_FILE is set but is not a file/);
    assert.match(missingRun.out, /an input of the predeploy check/);
    assert.match(missingRun.out, /nothing was changed/);
    assert.equal(calls(missing), "");

    // set, but to a directory: not a usable file however the caller is privileged
    const directory = sandbox();
    const tokenDir = path.join(directory.dir, "tokens");
    fs.mkdirSync(tokenDir);
    fs.appendFileSync(directory.config, `MYRMIDON_PREDEPLOY_TOKEN_FILE=${tokenDir}\n`);
    const directoryRun = full(directory);
    assert.notEqual(directoryRun.code, 0, directoryRun.out);
    assert.match(directoryRun.out, /MYRMIDON_PREDEPLOY_TOKEN_FILE is set but is not a file/);
    assert.equal(calls(directory), "");

    // set, and the file exists, but it is empty: nothing to send
    const empty = sandbox();
    const emptyFile = path.join(empty.dir, "empty-token");
    fs.writeFileSync(emptyFile, "");
    fs.appendFileSync(empty.config, `MYRMIDON_PREDEPLOY_TOKEN_FILE=${emptyFile}\n`);
    const emptyRun = full(empty);
    assert.notEqual(emptyRun.code, 0, emptyRun.out);
    assert.match(emptyRun.out, /MYRMIDON_PREDEPLOY_TOKEN_FILE is set but is empty/);
    assert.match(emptyRun.out, /an input of the predeploy check/);
    assert.equal(calls(empty), "");

    // set, and the file exists but cannot be read. Mode bits only stop a read
    // for a non-root caller, so as root the case is skipped rather than faked.
    if (typeof process.getuid === "function" && process.getuid() !== 0) {
      const unreadable = sandbox();
      const unreadableFile = path.join(unreadable.dir, "unreadable-token");
      fs.writeFileSync(unreadableFile, "test-board-token\n", { mode: 0o000 });
      fs.appendFileSync(unreadable.config, `MYRMIDON_PREDEPLOY_TOKEN_FILE=${unreadableFile}\n`);
      const unreadableRun = full(unreadable);
      assert.notEqual(unreadableRun.code, 0, unreadableRun.out);
      assert.match(unreadableRun.out, /MYRMIDON_PREDEPLOY_TOKEN_FILE is set but is not readable/);
      assert.equal(calls(unreadable), "");
    }
  });

  it("refuses before any docker call when the Postgres image is not configured", () => {
    const sb = sandbox({ omit: ["MYRMIDON_PREDEPLOY_POSTGRES_IMAGE"] });
    const { code, out } = full(sb, "--dockergate-digest", DG);
    assert.notEqual(code, 0, out);
    assert.match(out, /MYRMIDON_PREDEPLOY_POSTGRES_IMAGE is required/);
    assert.equal(calls(sb), "");
  });

  it("refuses without the board's environment file (the copy would not start like production)", () => {
    const sb = sandbox({ omit: ["MYRMIDON_PREDEPLOY_BOARD_ENV_FILE"] });
    const { code, out } = full(sb);
    assert.notEqual(code, 0, out);
    assert.match(out, /MYRMIDON_PREDEPLOY_BOARD_ENV_FILE is required/);
    assert.equal(calls(sb), "");
  });

  it("refuses without BOARD_COMPANY_ID (the attention list cannot be walked)", () => {
    const sb = sandbox({ omit: ["BOARD_COMPANY_ID"] });
    const { code, out } = full(sb);
    assert.notEqual(code, 0, out);
    assert.match(out, /BOARD_COMPANY_ID is required/);
    assert.equal(calls(sb), "");
  });

  it("refuses an empty dump, changing nothing", () => {
    const sb = sandbox();
    fs.writeFileSync(sb.dump, "");
    const { code, out } = full(sb);
    assert.notEqual(code, 0, out);
    assert.match(out, /dump file missing or empty/);
    assert.equal(calls(sb), "");
  });

  it("MYRMIDON_PREDEPLOY_CHECK=0 skips with a loud warning and touches nothing", () => {
    const sb = sandbox({ extraConfig: "MYRMIDON_PREDEPLOY_CHECK=0\n" });
    const { code, out } = full(sb);
    assert.equal(code, 0, out);
    assert.match(out, /disabled \(MYRMIDON_PREDEPLOY_CHECK=0\)/);
    assert.match(out, /NOT proven against a copy of the production database/);
    assert.equal(calls(sb), "");
  });

  it("--dry-run changes nothing and prints the plan", () => {
    const sb = sandbox();
    const { code, out } = full(sb, "--dockergate-digest", DG, "--dry-run");
    assert.equal(code, 0, out);
    assert.match(out, /Predeploy check plan/);
    assert.match(out, /docker network create myr-predeploy-/);
    assert.match(out, /the NEW dockergate of this release/);
    assert.match(out, /status ok, version\/commit of ghcr\.io\/itkadr-git\/myrmidon@sha256:bbb/);
    assert.match(out, /any failure stops deploy\.sh BEFORE the maintenance window/);
    assert.equal(calls(sb), "");
    assert.ok(!fs.existsSync(path.join(sb.stateDir, "predeploy-board.env")));
  });

  it("a dump that cannot be restored stops the check before the board is started", () => {
    const sb = sandbox();
    fs.writeFileSync(path.join(sb.dir, "restore-fails"), "");
    const { code, out } = full(sb);
    assert.notEqual(code, 0, out);
    assert.match(out, /cannot restore .* into the throwaway database/);
    assert.doesNotMatch(calls(sb), /--name myr-predeploy-board-/);
  });

  it("a dump with GRANTs to production-only roles restores on the default command (OPE-4875)", () => {
    // The production dump carries grants to roles that exist only on the
    // production server (backup_ro, ...). The throwaway Postgres does not have
    // them: without --no-acl pg_restore aborts on the missing role and the
    // check dies before the board is ever started. The default must skip the
    // privileges and restore the data.
    const sb = sandbox();
    fs.writeFileSync(path.join(sb.dir, "grant-to-missing-role"), "");
    const { code, out } = full(sb);
    assert.equal(code, 0, out);
    assert.match(calls(sb), /pg_restore .*--no-owner --no-acl/);
    assert.doesNotMatch(out, /role "backup_ro" does not exist/);
    assert.match(out, /board ok on the copy/);
    assert.match(out, /passed: .* comes up ok on a copy of the production database/);
  });

  it("the old default (--no-owner without --no-acl) fails on such a dump: the fake models the real abort", () => {
    // Proof the previous test is not vacuous: an operator override that keeps
    // the pre-OPE-4875 flags hits exactly the production failure the incident
    // comment describes, and the check stops before the window.
    const sb = sandbox({
      extraConfig: 'MYRMIDON_PREDEPLOY_RESTORE_COMMAND=\'docker exec -i -e PGPASSWORD="$MYR_PREDEPLOY_DB_PASSWORD" "$MYR_PREDEPLOY_DB_CONTAINER" pg_restore -U "$MYR_PREDEPLOY_DB_USER" -d "$MYR_PREDEPLOY_DB_NAME" --no-owner < "$DUMP_FILE"\'\n',
    });
    fs.writeFileSync(path.join(sb.dir, "grant-to-missing-role"), "");
    const { code, out } = full(sb);
    assert.notEqual(code, 0, out);
    assert.match(out, /cannot restore .* into the throwaway database/);
    assert.doesNotMatch(calls(sb), /--name myr-predeploy-board-/);
  });

  it("an operator override of the restore command is used as given", () => {
    const sb = sandbox({ extraConfig: "MYRMIDON_PREDEPLOY_RESTORE_COMMAND='docker exec -i custom-db pg_restore -U custom --no-acl < \"$DUMP_FILE\"'\n" });
    const { code, out } = full(sb);
    assert.equal(code, 0, out);
    assert.match(calls(sb), /docker exec -i custom-db pg_restore -U custom --no-acl/);
  });

  it("MYRMIDON_PREDEPLOY_KEEP=1 keeps the stack and names it for the operator", () => {
    const sb = sandbox({ extraConfig: "MYRMIDON_PREDEPLOY_KEEP=1\n" });
    const { code, out } = full(sb, "--dockergate-digest", DG);
    assert.equal(code, 0, out);
    assert.match(out, /keeping the throwaway stack/);
    // DEPLOY-HYGIENE: the kept stack INCLUDES the volume, and its name is printed
    assert.match(out, /volume=myr-predeploy-dbvol-/);
    assert.doesNotMatch(calls(sb), /docker rm -f/);
    assert.doesNotMatch(calls(sb), /docker volume rm/);
  });
});