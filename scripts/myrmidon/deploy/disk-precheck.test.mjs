import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, "lib.sh");

const FAKE_DF = `#!/usr/bin/env bash
free_kb="$(cat "$SANDBOX/free-kb")"
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n'
printf '/dev/root 52428800 %s %s 50%% /\n' "$((52428800-free_kb))" "$free_kb"
printf '\n'
`;

// Fake docker models local manifest presence and registry manifest responses.
const FAKE_DOCKER = `#!/usr/bin/env bash
echo "docker $*" >> "$SANDBOX/calls.log"
case "$1" in
  image)
    case "$2" in
      inspect)
        if [ "$#" -ge 4 ] && [ "$3" = "--format" ]; then
          case "$4" in *RootFS.Layers*) echo '["sha256:local-layer"]'; exit 0 ;; esac
        fi
        if [ -f "$SANDBOX/local-image" ]; then exit 0; fi
        exit 1 ;;
    esac ;;
  buildx)
    case "$*" in
      *'@sha256:amd64'*) echo '{"Config":{"size":1048576},"Layers":[{"size":2097152},{"size":4194304}]}' ;;
      *'{{json .Manifest}}'*)
        if [ -f "$SANDBOX/index-manifest" ]; then
          cat <<'EOF'
{"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[{"mediaType":"application/vnd.oci.image.manifest.v1+json","digest":"sha256:amd64","platform":{"architecture":"amd64","os":"linux"}},{"mediaType":"application/vnd.oci.image.manifest.v1+json","digest":"sha256:attestation","platform":{"architecture":"unknown","os":"unknown"}}]}
EOF
        elif [ -f "$SANDBOX/unknown-manifest" ]; then echo '{"Layers":[{"size":"unknown"}]}' ; elif [ -f "$SANDBOX/big-image" ]; then echo '{"Config":{"size":1048576},"Layers":[{"size":7516192768},{"size":6442450944}]}' ; else echo '{"Layers":[{"size":2097152},{"size":4194304}]}' ; fi ;;
      *) echo '{"Labels":{}}' ;;
    esac
    exit 0 ;;
esac
exit 0
`;

function fixture({ freeGb, localImage = "", unknownManifest = false, indexManifest = false, bigImage = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-disk-precheck-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "docker"), FAKE_DOCKER, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "df"), FAKE_DF, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "free-kb"), String(freeGb * 1024 * 1024));
  if (localImage) fs.writeFileSync(path.join(dir, "local-image"), localImage);
  if (unknownManifest) fs.writeFileSync(path.join(dir, "unknown-manifest"), "1");
  if (indexManifest) fs.writeFileSync(path.join(dir, "index-manifest"), "1");
  if (bigImage) fs.writeFileSync(path.join(dir, "big-image"), "1");
  fs.writeFileSync(path.join(dir, "calls.log"), "");
  return { dir, bin };
}

function run(sb, imageRefs, reserveGb = 5, minGb = 1) {
  const refs = imageRefs.map((ref) => JSON.stringify(ref)).join(" ");
  const script = ["set -euo pipefail", `source ${LIB}`, "DRY_RUN=0", `MYRMIDON_DEPLOY_IMAGE_REFS=(${refs})`, `MYRMIDON_DEPLOY_DB_DUMP_RESERVE_GB=${reserveGb}`, "deploy_disk_precheck /var/lib/docker"].join("\n");
  const result = spawnSync("bash", ["-c", script], { env: { ...process.env, PATH: `${sb.bin}:${process.env.PATH}`, SANDBOX: sb.dir, BASH_ENV: "", MYRMIDON_DEPLOY_MIN_FREE_GB: String(minGb) }, encoding: "utf8" });
  return { code: result.status, out: `${result.stdout}${result.stderr}`, calls: fs.readFileSync(path.join(sb.dir, "calls.log"), "utf8") };
}

describe("deploy_disk_precheck", () => {
  it("refuses before pull when free space is below missing-image bytes plus dump reserve", () => {
    const sb = fixture({ freeGb: 5 });
    const result = run(sb, ["registry.example/app@sha256:abc"]);
    assert.notEqual(result.code, 0, result.out);
    assert.match(result.out, /5 GiB free; requires 7 GiB including image layers and DB dump reserve/);
    assert.match(result.out, /cleanup/i);
    assert.doesNotMatch(result.calls, /docker pull/);
    assert.doesNotMatch(result.calls, /docker run/);
    assert.match(result.calls, /buildx imagetools inspect/);
  });

  it("refuses because of image size alone when free space covers min+reserve (incident 15.10 shape)", () => {
    // 25 GiB free, min 15 GiB, reserve 1 GiB: min+reserve (16) passes at 25,
    // but the missing release image needs ~13 GiB, so 25 < 29 and the deploy
    // is refused because of the image size itself — the 15.10 incident shape.
    const sb = fixture({ freeGb: 25, bigImage: true });
    const result = run(sb, ["registry.example/app@sha256:abc"], 1, 15);
    assert.notEqual(result.code, 0, result.out);
    assert.match(result.out, /25 GiB free; requires 29 GiB including image layers and DB dump reserve/);
    assert.doesNotMatch(result.calls, /docker pull/);
    assert.match(result.calls, /buildx imagetools inspect/);
  });

  it("continues with enough space for image and dump reserve", () => {
    const sb = fixture({ freeGb: 42 });
    const result = run(sb, ["registry.example/app@sha256:abc"]);
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /42 GiB free/);
  });

  it("skips registry lookup when the exact image digest is local", () => {
    const ref = "registry.example/app@sha256:abc";
    const sb = fixture({ freeGb: 20, localImage: ref });
    const result = run(sb, [ref]);
    assert.equal(result.code, 0, result.out);
    assert.doesNotMatch(result.calls, /buildx imagetools inspect/);
  });

  it("uses the linux/amd64 platform manifest from an OCI image index", () => {
    const sb = fixture({ freeGb: 20, indexManifest: true });
    const result = run(sb, ["registry.example/app@sha256:abc"]);
    assert.equal(result.code, 0, result.out);
    assert.match(result.calls, /@sha256:amd64/);
    assert.doesNotMatch(result.out, /invalid registry layer sizes/i);
  });

  it("warns and continues when registry size is unknown in dry-run", () => {
    const sb = fixture({ freeGb: 2, unknownManifest: true });
    const script = ["set -euo pipefail", `source ${LIB}`, "DRY_RUN=1", 'MYRMIDON_DEPLOY_IMAGE_REFS=("registry.example/app@sha256:abc")', "MYRMIDON_DEPLOY_DB_DUMP_RESERVE_GB=5", "deploy_disk_precheck /var/lib/docker"].join("\n");
    const result = spawnSync("bash", ["-c", script], { env: { ...process.env, PATH: `${sb.bin}:${process.env.PATH}`, SANDBOX: sb.dir, BASH_ENV: "", MYRMIDON_DEPLOY_MIN_FREE_GB: "1" }, encoding: "utf8" });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(`${result.stdout}${result.stderr}`, /WARNING:.*continuing dry run/i);
  });

  it("fails closed on unknown registry layer sizes", () => {
    const sb = fixture({ freeGb: 100, unknownManifest: true });
    const result = run(sb, ["registry.example/app@sha256:abc"]);
    assert.notEqual(result.code, 0, result.out);
    assert.match(result.out, /cannot determine|invalid registry layer sizes/i);
    assert.doesNotMatch(result.calls, /docker pull/);
    assert.doesNotMatch(result.calls, /docker run/);
  });
});
