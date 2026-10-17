import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, "lib.sh");

// Fake docker models local manifest presence and registry manifest responses.
const FAKE_DOCKER = `#!/usr/bin/env bash
exit 0
`;

function fixture({ freeGb, localImage = "", unknownManifest = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-disk-precheck-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "docker"), FAKE_DOCKER, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "df"), FAKE_DF, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "free-kb"), String(freeGb * 1024 * 1024));
  if (localImage) fs.writeFileSync(path.join(dir, "local-image"), localImage);
  if (unknownManifest) fs.writeFileSync(path.join(dir, "unknown-manifest"), "1");
  fs.writeFileSync(path.join(dir, "calls.log"), "");
  return { dir, bin };
}

function run(sb, imageRefs, reserveGb = 5) {
  const refs = imageRefs.map((ref) => JSON.stringify(ref)).join(" ");
  const script = ["set -euo pipefail", `source ${LIB}`, `MYRMIDON_DEPLOY_IMAGE_REFS=(${refs})`, `MYRMIDON_DEPLOY_DB_DUMP_RESERVE_GB=${reserveGb}`, "deploy_disk_precheck /var/lib/docker"].join("\n");
  const result = spawnSync("bash", ["-c", script], { env: { ...process.env, PATH: `${sb.bin}:${process.env.PATH}`, SANDBOX: sb.dir }, encoding: "utf8" });
  return { code: result.status, out: `${result.stdout}${result.stderr}`, calls: fs.readFileSync(path.join(sb.dir, "calls.log"), "utf8") };
}

describe("deploy_disk_precheck", () => {
  it("refuses before pull when free space is below missing-image bytes plus dump reserve", () => {
    const sb = fixture({ freeGb: 10 });
    const result = run(sb, ["registry.example/app@sha256:abc"]);
    assert.notEqual(result.code, 0, result.out);
    assert.match(result.out, /NOT started/);
    assert.match(result.out, /cleanup/i);
    assert.doesNotMatch(result.calls, /docker pull/);
    assert.doesNotMatch(result.calls, /docker run/);
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

  it("fails closed on unknown registry layer sizes", () => {
    const sb = fixture({ freeGb: 100, unknownManifest: true });
    const result = run(sb, ["registry.example/app@sha256:abc"]);
    assert.notEqual(result.code, 0, result.out);
    assert.match(result.out, /cannot determine|invalid registry layer sizes/i);
    assert.doesNotMatch(result.calls, /docker pull/);
    assert.doesNotMatch(result.calls, /docker run/);
  });
});
