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
//   used-images.txt the image ids `docker inspect <cid>` answers, one per line
//                   (the images the containers use; never removed)
const FAKE_DOCKER = `#!/usr/bin/env bash
echo "docker $*" >> "$SANDBOX/calls.log"
last=""
for a in "$@"; do last="$a"; done
case "$1" in
  ps)
    cat "$SANDBOX/containers.txt" 2>/dev/null
    exit 0 ;;
  inspect)
    cat "$SANDBOX/used-images.txt" 2>/dev/null
    exit 0 ;;
  image)
    case "$2" in
      inspect)
        if [ "$#" -ge 4 ] && [ "$3" = "--format" ]; then
          case "$4" in *RootFS.Layers*) echo '["sha256:local-layer"]'; exit 0 ;; esac
        fi
        if [ -n "\${FAKE_LOCAL_IMAGE:-}" ] && [ "$last" = "$FAKE_LOCAL_IMAGE" ]; then exit 0; fi
        echo "Error: No such image: $last" >&2
        exit 1 ;;
      ls)
        repo=""
        for a in "$@"; do
          # the repository is the first bare argument after the ls subcommand
          case "$a" in
            image|ls|--*) continue ;;
          esac
          repo="$a"; break
        done
        short=$(basename "$repo")
        cat "$SANDBOX/images-$short.txt" 2>/dev/null
        exit 0 ;;
      rm)
        for a in "$@"; do
          case "$a" in
            image|rm) continue ;;
          esac
          # refuse to remove an image a container uses (docker would)
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
  buildx)
    case "$*" in
      *imagetools*inspect*)
        case "$*" in
          *'{{json .Manifest}}'*) echo '{"Layers":[{"size":2097152},{"size":4194304}]}' ;;
          *'{{json .Manifest.Layers}}'*) echo '[{"size":2097152},{"size":4194304}]' ;;
          *'{{json .Manifest.Digest}}'*) echo '"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"' ;;
          *) echo '{"architecture":"amd64","os":"linux","config":{"Labels":{}},"manifest":{"digest":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}}' ;;
        esac
        exit 0 ;;
    esac
    exit 0 ;;
  run)
    echo "cid-x"
    exit 0 ;;
esac
exit 0
`;
const FAKE_DF = `#!/usr/bin/env bash
free_kb="$(cat "$SANDBOX/free-kb")"
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n'
printf '/dev/root 52428800 %s %s 50%% /\n' "$((52428800-free_kb))" "$free_kb"
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
    env: { ...process.env, BASH_ENV: "", PATH: `${sb.bin}:${process.env.PATH}`, SANDBOX: sb.dir },
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
  // Keep the fake invocation environment isolated from a host BASH_ENV. A host
  // startup file can otherwise override the fake git and hide the fixture's
  // fallback/error branches.
  function runJournal(sb, exactPath = false) {
    return spawnSync("bash", [path.join(HERE, "deploy.sh")], {
      env: { ...process.env, BASH_ENV: "", PATH: exactPath ? sb.bin : `${sb.bin}:${process.env.PATH}`, SANDBOX: sb.dir },
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
    assert.match(out, /4 GiB free; requires 15 GiB including image layers and DB dump reserve/);
    assert.match(out, /refusing before pull, DB dump, or maintenance; cleanup candidates:/);
    assert.doesNotMatch(calls(sb), /docker pull|dump|maintenance/);
    // the candidates are printed, the deploy refused
    assert.match(calls(sb), /docker system df/);
  });

  it("passes with enough space and logs the current value", () => {
    const sb = sandbox({ freeGb: 42 });
    const { code, out } = runHelper(sb, "deploy_disk_precheck test-place");
    assert.equal(code, 0, out);
    assert.match(out, /42 GiB free; requires 15 GiB including image layers and DB dump reserve/);
  });

  it("honours MYRMIDON_DEPLOY_MIN_FREE_GB and 0 switches the check off", () => {
    const tight = sandbox({ freeGb: 9 });
    const low = runHelper(tight, "deploy_disk_precheck test-place", { configExtra: "MYRMIDON_DEPLOY_MIN_FREE_GB=10" });
    assert.notEqual(low.code, 0, low.out);
    assert.match(low.out, /9 GiB free; requires 10 GiB including image layers and DB dump reserve/);

    const off = sandbox({ freeGb: 1 });
    const offRun = runHelper(off, "deploy_disk_precheck test-place", { configExtra: "MYRMIDON_DEPLOY_MIN_FREE_GB=0" });
    assert.equal(offRun.code, 0, offRun.out);
    assert.match(offRun.out, /MYRMIDON_DEPLOY_MIN_FREE_GB=0, the check is off/);
  });

  it("in a dry run the check is reported with the current value and nothing is refused", () => {
    const sb = sandbox({ freeGb: 4 });
    const { code, out } = runHelper(sb, "deploy_disk_precheck test-place", { dryRun: true });
    assert.equal(code, 0, out);
    assert.match(out, /dry run; requires 15 GiB including image layers and DB dump reserve .*free: 4 GiB/);
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
    // the board's only used image is its OLDEST: every image newer than the
    // running release was pulled for the next one and stays (rc.1 included),
    // whatever the keep. dockergate has no used image, so its keep+1 = 2
    // newest stay and the old untagged image is removed.
    assert.doesNotMatch(log, /docker image rm ghcr\.io\/itkadr-git\/myrmidon:/);
    assert.match(log, /docker image rm sha256:8{64}/);
    assert.match(out, /1 image\(s\) removed, 1 in use and kept, 3 newer than the running release kept/);
  });

  // `docker image rm <ref>` targets of the run, in call order.
  const removedRefs = (sb) =>
    calls(sb)
      .split("\n")
      .filter((l) => l.startsWith("docker image rm "))
      .map((l) => l.slice("docker image rm ".length));
  const sha = (c) => "sha256:" + c.repeat(64);

  it("keeps a freshly pulled image, the running one and ONE previous (keep=1); older unused go", () => {
    const fresh = sha("a");
    const current = sha("b");
    const sb = sandbox({
      freeGb: 42,
      images: [
        img(BOARD, fresh, "2026-11-06 10:00:00 +0000 UTC"),
        img(BOARD, current, "2026-11-05 10:00:00 +0000 UTC"),
        img(BOARD, sha("c"), "2026-11-04 10:00:00 +0000 UTC"),
        img(BOARD, sha("d"), "2026-11-03 10:00:00 +0000 UTC"),
        img(BOARD, sha("e"), "2026-11-02 10:00:00 +0000 UTC"),
      ],
      containers: ["cid-current"],
      usedImages: [current],
    });
    const { code, out } = runHelper(sb, "deploy_image_retention", {
      configExtra: `MYRMIDON_DEPLOY_IMAGE_REPOS=${BOARD}\nMYRMIDON_DEPLOY_IMAGE_KEEP=1`,
    });
    assert.equal(code, 0, out);
    // the two oldest unused images are removed; the fresh one (not started
    // yet), the running one and the newest previous one stay
    assert.deepEqual(removedRefs(sb), [sha("d"), sha("e")]);
    assert.match(out, /2 image\(s\) removed, 1 in use and kept, 1 newer than the running release kept/);
  });

  it("keeps the running image and ONE previous (keep=1) when nothing newer was pulled", () => {
    const current = sha("a");
    const sb = sandbox({
      freeGb: 42,
      images: [
        img(BOARD, current, "2026-11-05 10:00:00 +0000 UTC"),
        img(BOARD, sha("b"), "2026-11-04 10:00:00 +0000 UTC"),
        img(BOARD, sha("c"), "2026-11-03 10:00:00 +0000 UTC"),
        img(BOARD, sha("d"), "2026-11-02 10:00:00 +0000 UTC"),
      ],
      containers: ["cid-current"],
      usedImages: [current],
    });
    const { code, out } = runHelper(sb, "deploy_image_retention", {
      configExtra: `MYRMIDON_DEPLOY_IMAGE_REPOS=${BOARD}\nMYRMIDON_DEPLOY_IMAGE_KEEP=1`,
    });
    assert.equal(code, 0, out);
    assert.deepEqual(removedRefs(sb), [sha("c"), sha("d")]);
    assert.match(out, /2 image\(s\) removed, 1 in use and kept, 0 newer than the running release kept/);
  });

  it("without any used image the N+1 newest stay (keep=1: two), the rest go", () => {
    const sb = sandbox({
      freeGb: 42,
      images: [
        img(BOARD, sha("a"), "2026-11-05 10:00:00 +0000 UTC"),
        img(BOARD, sha("b"), "2026-11-04 10:00:00 +0000 UTC"),
        img(BOARD, sha("c"), "2026-11-03 10:00:00 +0000 UTC"),
        img(BOARD, sha("d"), "2026-11-02 10:00:00 +0000 UTC"),
      ],
    });
    const { code, out } = runHelper(sb, "deploy_image_retention", {
      configExtra: `MYRMIDON_DEPLOY_IMAGE_REPOS=${BOARD}\nMYRMIDON_DEPLOY_IMAGE_KEEP=1`,
    });
    assert.equal(code, 0, out);
    assert.deepEqual(removedRefs(sb), [sha("c"), sha("d")]);
    assert.match(out, /2 image\(s\) removed, 0 in use and kept, 0 newer than the running release kept/);
  });

  it("keep=2 keeps the running image and TWO previous ones; a second used image is skipped and not counted", () => {
    const current = sha("a");
    const rollback = sha("d");
    const sb = sandbox({
      freeGb: 42,
      images: [
        img(BOARD, current, "2026-11-05 10:00:00 +0000 UTC"),
        img(BOARD, sha("b"), "2026-11-04 10:00:00 +0000 UTC"),
        img(BOARD, sha("c"), "2026-11-03 10:00:00 +0000 UTC"),
        // an older image a (stopped) container still uses: never removed and
        // does not take a place of the previous releases
        img(BOARD, rollback, "2026-11-02 10:00:00 +0000 UTC"),
        img(BOARD, sha("e"), "2026-11-01 10:00:00 +0000 UTC"),
        img(BOARD, sha("f"), "2026-10-31 10:00:00 +0000 UTC"),
      ],
      containers: ["cid-current", "cid-stopped"],
      usedImages: [current, rollback],
    });
    const { code, out } = runHelper(sb, "deploy_image_retention", {
      configExtra: `MYRMIDON_DEPLOY_IMAGE_REPOS=${BOARD}\nMYRMIDON_DEPLOY_IMAGE_KEEP=2`,
    });
    assert.equal(code, 0, out);
    assert.deepEqual(removedRefs(sb), [sha("e"), sha("f")]);
    assert.match(out, /2 image\(s\) removed, 2 in use/);
  });

  it("untagged bot images pulled by digest: four generations shrink to the running one plus one (06.11)", () => {
    const BOT_REPOS = ["myrmidon-hermes", "myrmidon-hermes-dev", "myrmidon-hermes-node"].map((n) => `ghcr.io/itkadr-git/${n}`);
    // distinct 64-hex ids per repository and generation
    const idOf = (r, g) => "sha256:" + String(r * 4 + g + 1).padStart(2, "0").repeat(32);
    const imgs = [];
    const used = [];
    // generation 0 is the current release (used by the bot containers), 1..3
    // are superseded and unused; nothing was pulled after the current one
    BOT_REPOS.forEach((repo, r) => {
      for (let g = 0; g < 4; g++) {
        imgs.push(img(repo, idOf(r, g), `2026-11-0${5 - g} 10:00:00 +0000 UTC`));
      }
      used.push(idOf(r, 0));
    });
    const sb = sandbox({ freeGb: 42, images: imgs, containers: ["cid-bot-1", "cid-bot-2"], usedImages: used });
    const { code, out } = runHelper(sb, "deploy_image_retention", {
      configExtra: `MYRMIDON_DEPLOY_IMAGE_REPOS=${BOT_REPOS.join(",")}\nMYRMIDON_DEPLOY_IMAGE_KEEP=1`,
    });
    assert.equal(code, 0, out);
    // per repository: generation 0 (used) and generation 1 stay, 2 and 3 go
    const expected = [];
    BOT_REPOS.forEach((_, r) => expected.push(idOf(r, 2), idOf(r, 3)));
    assert.deepEqual(removedRefs(sb), expected);
    assert.match(out, /6 image\(s\) removed, 3 in use/);
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
