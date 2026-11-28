import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { verifyManifestProvenance } from "./cloud-readiness.mjs";

const sha = "a".repeat(40);
const manifest = Buffer.from('{"name":"caf\u00e9 \u96ea"}\n', "utf8");

for (const failure of [false, true]) {
  test(`attestation receives exact bytes and arguments and cleans scratch on ${failure ? "throw" : "return"}`, () => {
    const original = Buffer.from(manifest);
    const expectedError = new Error("attestation failed");
    let calls = 0;
    let scratch;
    const exec = (command, args, options) => {
      calls++;
      const file = args[2];
      scratch = path.dirname(file);
      assert.equal(command, "gh");
      assert.equal(path.basename(file), "manifest.json");
      assert.deepEqual(readFileSync(file), original);
      assert.deepEqual(args, [
        "attestation", "verify", file, "--repo", "paperclipai/paperclip",
        "--source-digest", sha, "--source-ref", "refs/heads/master",
        "--cert-identity", "https://github.com/paperclipai/paperclip/.github/workflows/cloud-migrator-artifacts.yml@refs/heads/master",
        "--deny-self-hosted-runners",
      ]);
      assert.deepEqual(options, { stdio: "inherit", timeout: 60_000 });
      if (failure) throw expectedError;
    };
    if (failure) assert.throws(() => verifyManifestProvenance(manifest, sha, { exec }), (error) => error === expectedError);
    else assert.equal(verifyManifestProvenance(manifest, sha, { exec }), undefined);
    assert.equal(calls, 1);
    assert.equal(existsSync(scratch), false);
    assert.deepEqual(manifest, original);
  });
}

test("invalid source SHA is rejected before invoking attestation", () => {
  for (const invalid of ["master", "a".repeat(7), "A".repeat(40), undefined]) {
    let calls = 0;
    assert.throws(() => verifyManifestProvenance(manifest, invalid, { exec: () => { calls++; } }), /full immutable commit SHA/);
    assert.equal(calls, 0);
  }
});
