import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { patchOmpCliText } from "./patch-omp-cli.mjs";

const TARGET_NEEDLE =
  "RFC 2119 keywords: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL.";
const REPLACEMENT_TEXT =
  "Keywords MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL follow their usual meaning.";

describe("patchOmpCliText", () => {
  it("replaces RFC 2119 keywords line when present", () => {
    const input = `preamble\n${TARGET_NEEDLE} Extra rules.\npostscript`;
    const result = patchOmpCliText(input);
    assert.ok(!result.includes(TARGET_NEEDLE), "Must not include old needle");
    assert.ok(result.includes(REPLACEMENT_TEXT), "Must include replacement text");
    assert.equal(
      result,
      `preamble\n${REPLACEMENT_TEXT} Extra rules.\npostscript`,
    );
  });

  it("replaces all occurrences in bundled cli.js", () => {
    const input = `A ${TARGET_NEEDLE} B ${TARGET_NEEDLE} C`;
    const result = patchOmpCliText(input);
    assert.equal(
      result,
      `A ${REPLACEMENT_TEXT} B ${REPLACEMENT_TEXT} C`,
    );
  });

  it("fails fast with explicit error when target needle is missing", () => {
    const input = "some code without that line";
    assert.throws(
      () => patchOmpCliText(input),
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(
          err.message,
          /Target RFC 2119 pattern not found in cli\.js/i,
        );
        return true;
      },
    );
  });
});

describe("Dockerfile omp runner patch integration", () => {
  it("Dockerfile and Dockerfile.omp-ssh apply patch-omp-cli and verify replacement", () => {
    const dockerfileRoot = fs.readFileSync("Dockerfile", "utf8");
    const dockerfileOmpSsh = fs.readFileSync(
      "docker/agent-runtime/Dockerfile.omp-ssh",
      "utf8",
    );
    const dockerfileOmp = fs.readFileSync(
      "docker/agent-runtime/Dockerfile.omp",
      "utf8",
    );

    for (const [name, df] of [
      ["Dockerfile", dockerfileRoot],
      ["Dockerfile.omp-ssh", dockerfileOmpSsh],
      ["Dockerfile.omp", dockerfileOmp],
    ]) {
      assert.match(
        df,
        /patch-omp-cli\.mjs/,
        `${name} must invoke patch-omp-cli.mjs during image build`,
      );
      assert.match(
        df,
        /RFC 2119 keywords:/,
        `${name} must verify RFC 2119 keywords: is absent after patching`,
      );
      assert.match(
        df,
        /Keywords MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL follow their usual meaning\./,
        `${name} must verify replacement text is present after patching`,
      );
    }
  });
});
