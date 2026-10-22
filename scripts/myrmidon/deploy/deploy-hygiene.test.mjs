import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// DEPLOY-HYGIENE (OPE-5107, the 06.10 disk incident): one deploy of rc.3 moved
// the root filesystem of the deploy host from 86 % to 92 % in an hour, because
// the deploy never checked the disk could hold the images and never removed
// the images of the releases before. These tests run the helpers of lib.sh
// (deploy_disk_precheck, deploy_image_retention) against a fake `df` and a
// fake `docker` placed first in PATH — the same fake-binary style as
// deploy.test.mjs and predeploy-board-check.test.mjs. Nothing touches a real
// docker daemon or filesystem.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, "lib.sh");

// Fake docker: every call is logged; the answers come from sandbox files.
//   images.txt     per-repository files images-<last-path-part>.txt with
//                  lines "created<TAB>id<TAB>tag" for
//                  `docker image ls <repo> --no-trunc`
//   containers.txt container ids for `docker ps -a -q`
//   used-images.txt the image id `docker inspect <cid>` answers (the images
//                   the containers use; never removed)
const FAKE_DOCKER = `#!/usr/bin/env bash
echo "docker $*" >> "$SANDBOX/calls.log"
last=""
for a in "$@"; do last="$a"; done
case "$1" in
  ps)
    cat "$SANDBOX/containers.txt" 2>/dev/null
    exit 0 ;;
  inspect)
    grep -m1 "^" "$SANDBOX/used-images.txt" 2>/dev/null
    exit 0 ;;
  image)
    case "$2" in
      ls)
        # the repository is the first bare argument after the ls subcommand
        repo=""
        for a in "$@"; do
          case "$a" in
            image|ls|--*) continue ;;
          esac
          repo="$a"; break
        done
        short=$(basename "$repo")
        cat "$SANDBOX/images-$short.txt" 2>/dev/null
        exit 0 ;;
      rm)
        # refuse to remove an image a container uses (docker would)
        for a in "$@"; do
          case "$a" in
            image|rm) continue ;;
          esac
          if [ -f "$SANDBOX/used-images.txt" ] && grep -qF "$a" "$SANDBOX/used-images.txt"; then
            echo "Error: conflict: unable to remove repository reference (must force) - container is using its referenced image" >&2
            exit 1
          fi
        done
        echo "deleted $last"
        exit 0 ;;
    esac
    exit 0 ;;
  system)
    echo "TYPE            TOTAL     ACTIVE    SIZE      RECLAIMABLE"
    echo "Images          8         3         33GB      20GB"
    exit 0 ;;
esac
exit 0
`;

const FAKE_DF = `#!/usr/bin/env bash
# Answers "df -Pk <path>" with the sandbox's free kibibytes (1 block = 1024).
free_kb=""
[ -f "$SANDBOX/free-kb" ] && free_kb="$(tr -d '[:space:]' < "$SANDBOX/free-kb")"
[ -n "$free_kb" ] || free_kb=104857600
printf 'Filesystem     1024-blocks        Used   Available Capacity Mounted on\\n'
printf '/dev/root        52428800   %s   %s    %s%% /\\n' \\
  "$((52428800 - free_kb))" "$free_kb" "$(( (52428800 - free_kb) * 100 / 52428800 ))"
`;

// Runs one helper of lib.sh in a sandbox. body is a bash snippet evaluated
// after the config was sourced and lib.sh loaded (its die() must not kill the
// harness, so MYRMIDON_DEPLOY_* values come from the config file).
function runHelper(sb, body, { dryRun = false, configExtra = "" } = {}) {
  const config = path.join(sb.dir, "deploy.env");
  fs.writeFileSync(
    config,
    [
      "MYRMIDON_IMAGE=ghcr.io/itkadr-git/myrmidon",
      `COMPOSE_DIR=${sb.dir}`,
      "COMPOSE_SERVICE=server",
      "HEALTH_URL=http://127.0.0.1:3100/api/health",
      configExtra,
      "",
    ].join("\n"),
  );
  const script = [
    'set -euo pipefail',
    `source ${LIB}`,
    `DRY_RUN=${dryRun ? 1 : 0}`,
    `load_config ${config}`,
    body,
    "",
  ].join("\n");
  const result = spawnSync("bash", ["-c", script], {
    env: { ...process.env, PATH: `${sb.bin}:${process.env.PATH}`, SANDBOX: sb.dir },
    encoding: "utf8",
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

function sandbox({ freeGb, images = [], containers = [], usedImages = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myrmidon-deploy-hygiene-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "docker"), FAKE_DOCKER, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "df"), FAKE_DF, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "calls.log"), "");
  if (freeGb !== undefined) fs.writeFileSync(path.join(dir, "free-kb"), String(freeGb * 1024 * 1024));
  const byRepo = new Map();
  for (const i of images) {
    const short = i.repo.split("/").pop();
    const line = [i.created, i.id, i.tag ?? "<none>"].join("\t");
    byRepo.set(short, [...(byRepo.get(short) ?? []), line]);
  }
  for (const [short, lines] of byRepo) {
    fs.writeFileSync(path.join(dir, `images-${short}.txt`), lines.join("\n") + "\n");
  }
  fs.writeFileSync(path.join(dir, "containers.txt"), containers.join("\n") + (containers.length ? "\n" : ""));
  fs.writeFileSync(path.join(dir, "used-images.txt"), usedImages.join("\n") + (usedImages.length ? "\n" : ""));
  return { dir, bin };
}

const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
const calls = (sb) => read(path.join(sb.dir, "calls.log"));

describe("log_script_version (myrmidon(F-05)): the deploy journal opens with the script version", () => {
  // The journal line of a deploy run is the fake-git answer below; the real
  // value is `git describe --tags --always` of the clone holding the scripts.
  const FAKE_GIT = `#!/usr/bin/env bash
for a in "$@"; do
  case "$a" in
    rev-parse) echo "$SANDBOX"; exit 0 ;;
    describe) echo "myr-v1.6.5-rc.7-3-gdeadbee"; exit 0 ;;
  esac
done
exit 0
`;
  const BROKEN_GIT = "#!/usr/bin/env bash\nexit 1\n";
  const NO_CLONE_GIT = `#!/usr/bin/env bash
for a in "$@"; do
  case "$a" in
    rev-parse) exit 1 ;;
    describe) echo "fallback-sha1"; exit 0 ;;
  esac
done
exit 0
`;

  // A PATH without git: symlinks of the core tools bash needs, no git.
  function noGitBin(dir) {
    const bin = path.join(dir, "no-git-bin");
    fs.mkdirSync(bin);
    for (const tool of ["bash", "sh", "sed", "dirname", "env", "pwd"]) {
      const real = spawnSync("/usr/bin/bash", ["-c", `command -v ${tool} || true`], { encoding: "utf8" }).stdout.trim();
      if (real && path.isAbsolute(real)) fs.symlinkSync(real, path.join(bin, tool));
    }
    return bin;
  }

  function versionSandbox(gitContent) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myrmidon-script-version-"));
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    if (gitContent === null) return { dir, bin: noGitBin(dir) };
    fs.writeFileSync(path.join(bin, "git"), gitContent, { mode: 0o755 });
    return { dir, bin };
  }
  // Runs deploy.sh up to its first argument check with the fake git first in
  // PATH; the run dies on "give --digest or --release", after the journal's
  // first line. The deploy journal is STDERR (deploy-from-job.sh captures it
  // as job-<id>.log), so the head assertions read stderr only — and each case
  // also proves the stamp never leaks into stdout.
  function runJournal(sb, exactPath = false) {
    return spawnSync("bash", [path.join(HERE, "deploy.sh")], {
      env: { ...process.env, PATH: exactPath ? sb.bin : `${sb.bin}:${process.env.PATH}`, SANDBOX: sb.dir },
      encoding: "utf8",
    });
  }
  function journalHead(sb, exactPath = false) {
    const r = runJournal(sb, exactPath);
    return r.stderr.split("\n")[0];
  }
  function assertNoStdoutStamp(r) {
    assert.ok(
      !(r.stdout || "").includes("deploy scripts at"),
      `the version stamp must go to stderr (the deploy journal), not stdout: ${JSON.stringify(r.stdout)}`,
    );
  }

  it("the journal's first line names the script version (git describe)", () => {
    const sb = versionSandbox(FAKE_GIT);
    const r = runJournal(sb);
    assert.equal(journalHead(sb), "deploy scripts at myr-v1.6.5-rc.7-3-gdeadbee");
    assertNoStdoutStamp(r);
  });

  it("falls back to unknown when git cannot answer", () => {
    const sb = versionSandbox(BROKEN_GIT);
    const r = runJournal(sb);
    assert.equal(journalHead(sb), "deploy scripts at unknown");
    assertNoStdoutStamp(r);
  });

  it("falls back to unknown when git itself is not installed", () => {
    const sb = versionSandbox(null);
    const r = runJournal(sb, true);
    assert.equal(journalHead(sb, true), "deploy scripts at unknown");
    assertNoStdoutStamp(r);
  });

  it("describes the scripts' directory when it is not inside a git clone", () => {
    const sb = versionSandbox(NO_CLONE_GIT);
    const r = runJournal(sb);
    assert.equal(journalHead(sb), "deploy scripts at fallback-sha1");
    assertNoStdoutStamp(r);
  });
});

// An image entry of one repository; created is RFC3339-ish (sort order is the
// image creation date).
function img(repo, id, created, tag = "<none>") {
  return { repo, id, created, tag };
}

describe("deploy_disk_precheck (DEPLOY-HYGIENE, OPE-5107)", () => {
  it("stops BEFORE the first pull when the disk cannot hold the images", () => {
    const sb = sandbox({ freeGb: 4 });
    const { code, out } = runHelper(sb, "deploy_disk_precheck test-place");
    assert.notEqual(code, 0, out);
    assert.match(out, /4 GiB free on the filesystem of \/var\/lib\/docker, less than the required 15 GiB/);
    assert.match(out, /NOT started: no image was pulled, no dump was taken, nothing was changed/);
    assert.match(out, /docker system df/);
    // the candidates are printed, the deploy refused
    assert.match(calls(sb), /docker system df/);
  });

  it("passes with enough space and logs the current value", () => {
    const sb = sandbox({ freeGb: 42 });
    const { code, out } = runHelper(sb, "deploy_disk_precheck test-place");
    assert.equal(code, 0, out);
    assert.match(out, /42 GiB free on the filesystem of \/var\/lib\/docker \(>= 15 GiB required\)/);
  });

  it("honours MYRMIDON_DEPLOY_MIN_FREE_GB and 0 switches the check off", () => {
    const tight = sandbox({ freeGb: 9 });
    const low = runHelper(tight, "deploy_disk_precheck test-place", { configExtra: "MYRMIDON_DEPLOY_MIN_FREE_GB=10" });
    assert.notEqual(low.code, 0, low.out);
    assert.match(low.out, /9 GiB free .* less than the required 10 GiB/);

    const off = sandbox({ freeGb: 1 });
    const offRun = runHelper(off, "deploy_disk_precheck test-place", { configExtra: "MYRMIDON_DEPLOY_MIN_FREE_GB=0" });
    assert.equal(offRun.code, 0, offRun.out);
    assert.match(offRun.out, /MYRMIDON_DEPLOY_MIN_FREE_GB=0, the check is off/);
  });

  it("in a dry run the check is reported with the current value and nothing is refused", () => {
    const sb = sandbox({ freeGb: 4 });
    const { code, out } = runHelper(sb, "deploy_disk_precheck test-place", { dryRun: true });
    assert.equal(code, 0, out);
    assert.match(out, /dry run, nothing refused; the real run needs 15 GiB free .* \(now: 4 GiB\)/);
  });
});

describe("deploy_image_retention (DEPLOY-HYGIENE, OPE-5107)", () => {
  const BOARD = "ghcr.io/itkadr-git/myrmidon";
  const DG = "ghcr.io/itkadr-git/myrmidon-dockergate";

  it("removes the images older than N previous releases, newest kept", () => {
    const sb = sandbox({
      freeGb: 42,
      images: [
        img(BOARD, "sha256:" + "1".repeat(64), "2026-10-06 10:00:00 +0000 UTC", "1.6.5-rc.3"),
        img(BOARD, "sha256:" + "2".repeat(64), "2026-10-05 10:00:00 +0000 UTC", "1.6.5-rc.2"),
        img(BOARD, "sha256:" + "3".repeat(64), "2026-10-04 10:00:00 +0000 UTC", "1.6.5-rc.1"),
        img(BOARD, "sha256:" + "4".repeat(64), "2026-10-03 10:00:00 +0000 UTC"),
      ],
    });
    const { code, out } = runHelper(sb, "deploy_image_retention", {
      configExtra: `MYRMIDON_DEPLOY_IMAGE_REPOS=${BOARD}`,
    });
    assert.equal(code, 0, out);
    const log = calls(sb);
    // keep=1: the newest two images stay, the older two are removed
    assert.doesNotMatch(log, /image rm .*1{16}/);
    assert.doesNotMatch(log, /image rm .*2{16}/);
    assert.match(log, new RegExp(`docker image rm ${BOARD}:1\\.6\\.5-rc\\.1`));
    assert.match(log, /docker image rm sha256:4{64}/);
    assert.match(out, /2 image\(s\) removed, 0 in use/);
  });

  it("never removes an image a container uses, whatever its age", () => {
    const old = "sha256:" + "5".repeat(64);
    const sb = sandbox({
      freeGb: 42,
      images: [
        img(BOARD, "sha256:" + "1".repeat(64), "2026-10-06 10:00:00 +0000 UTC", "1.6.5-rc.3"),
        img(BOARD, "sha256:" + "2".repeat(64), "2026-10-05 10:00:00 +0000 UTC", "1.6.5-rc.2"),
        img(BOARD, "sha256:" + "3".repeat(64), "2026-10-04 10:00:00 +0000 UTC", "1.6.5-rc.1"),
        img(BOARD, old, "2026-10-01 10:00:00 +0000 UTC", "1.6.4"),
        img(DG, "sha256:" + "6".repeat(64), "2026-10-06 09:00:00 +0000 UTC", "1.6.5-rc.3"),
        img(DG, "sha256:" + "7".repeat(64), "2026-10-05 09:00:00 +0000 UTC", "1.6.5-rc.2"),
        img(DG, "sha256:" + "8".repeat(64), "2026-09-30 09:00:00 +0000 UTC"),
      ],
      containers: ["cid-board-old"],
      usedImages: [old],
    });
    const { code, out } = runHelper(sb, "deploy_image_retention", {
      configExtra: `MYRMIDON_DEPLOY_IMAGE_REPOS=${BOARD},${DG}`,
    });
    assert.equal(code, 0, out);
    const log = calls(sb);
    assert.doesNotMatch(log, /docker image rm .*5{64}/);
    assert.match(out, /used by a container: skipped/);
    // per repository the current release plus one previous stay (keep=1, for
    // a rollback): the board's used old image is skipped (it does not eat the
    // keep budget), its unused older image and dockergate's old untagged
    // image are removed
    assert.match(log, /docker image rm ghcr\.io\/itkadr-git\/myrmidon:1\.6\.5-rc\.1/);
    assert.match(log, /docker image rm sha256:8{64}/);
    assert.match(out, /2 image\(s\) removed, 1 in use/);
  });

  it("keep=0 switches the cleanup off", () => {
    const sb = sandbox({
      freeGb: 42,
      images: [img(BOARD, "sha256:" + "9".repeat(64), "2026-10-01 10:00:00 +0000 UTC")],
    });
    const { code, out } = runHelper(sb, "deploy_image_retention", { configExtra: "MYRMIDON_DEPLOY_IMAGE_KEEP=0" });
    assert.equal(code, 0, out);
    assert.match(out, /MYRMIDON_DEPLOY_IMAGE_KEEP=0, the cleanup is off/);
    assert.doesNotMatch(calls(sb), /docker image rm/);
  });

  it("the default repository list covers the board and every release component", () => {
    const sb = sandbox({ freeGb: 42, images: [] });
    const { code, out } = runHelper(sb, 'printf "%s\\n" "$MYRMIDON_DEPLOY_IMAGE_REPOS"');
    assert.equal(code, 0, out);
    for (const repo of [
      "ghcr.io/itkadr-git/myrmidon",
      "ghcr.io/itkadr-git/myrmidon-dockergate",
      "ghcr.io/itkadr-git/myrmidon-fleetd",
      "ghcr.io/itkadr-git/myrmidon-hermes",
      "ghcr.io/itkadr-git/myrmidon-hermes-dev",
      "ghcr.io/itkadr-git/myrmidon-hermes-node",
    ]) {
      assert.ok(out.includes(repo), `default MYRMIDON_DEPLOY_IMAGE_REPOS misses ${repo}`);
    }
  });
});
