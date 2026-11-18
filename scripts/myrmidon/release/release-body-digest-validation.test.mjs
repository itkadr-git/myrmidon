import test from "node:test";
import assert from "node:assert/strict";
import { COMPONENTS, OPTIONAL_COMPONENTS, componentDigests, buildManifest } from "./release-body.mjs";

const valid = `sha256:${"aB012345".repeat(8)}`;
const invalid = ["", "sha256:short", `sha512:${"a".repeat(64)}`, ` ${valid}`, `${valid}\n`, "latest"];
const all = [...COMPONENTS, ...OPTIONAL_COMPONENTS];

function fetchFor(values) {
  return async (url) => {
    if (url.includes("/token?")) return { ok: true, json: async () => ({ token: "test" }) };
    const repository = url.match(/\/v2\/itkadr-git\/([^/]+)\/manifests\//)[1];
    return { ok: true, headers: { get: () => values[repository] ?? null } };
  };
}

for (const source of ["registryState", "http"]) {
  for (const value of invalid) {
    test(`${source} rejects ${JSON.stringify(value)} without publishing a pinned image`, async () => {
      const values = Object.fromEntries(all.map(({ repository }) => [repository, valid]));
      values[COMPONENTS[0].repository] = value;
      values[OPTIONAL_COMPONENTS[0].repository] = value;
      const options = source === "registryState" ? { registryState: values } : { fetchImpl: fetchFor(values) };
      const result = await componentDigests("1.2.3", options);
      assert.deepEqual(result.missing, ["board"]);
      assert.equal(result.digests.board, undefined);
      assert.equal(result.digests[OPTIONAL_COMPONENTS[0].label], undefined);
      assert.equal(result.rows.length, all.length - 2);
      assert.ok(result.rows.every((row) => !row.startsWith("| board |") && !row.startsWith(`| ${OPTIONAL_COMPONENTS[0].label} |`)));
      const manifest = buildManifest({ version: "1.2.3", digests: result.digests });
      assert.equal(manifest.components.board, undefined);
      assert.equal(manifest.components[OPTIONAL_COMPONENTS[0].label], undefined);
      assert.equal(manifest.components.dockergate.digest, valid);
    });
  }

  test(`${source} accepts valid digests for all components`, async () => {
    const values = Object.fromEntries(all.map(({ repository }) => [repository, valid]));
    const options = source === "registryState" ? { registryState: values } : { fetchImpl: fetchFor(values) };
    const result = await componentDigests("1.2.3", options);
    assert.deepEqual(result.missing, []);
    assert.equal(result.rows.length, all.length);
    assert.ok(result.rows.every((row) => row.includes(`@${valid}`)));
    const manifest = buildManifest({ version: "1.2.3", digests: result.digests });
    assert.equal(Object.keys(manifest.components).length, all.length);
    assert.equal(manifest.components.hermes.digest, valid);
  });
}
