import assert from "node:assert/strict";
import test from "node:test";
import { buildManifest } from "./release-body.mjs";

const components = Object.freeze({
  board: Object.freeze({ repository: "ghcr.io/example/board", digest: `sha256:${"1".repeat(64)}` }),
  dockergate: Object.freeze({ repository: "ghcr.io/example/dockergate", digest: `sha256:${"2".repeat(64)}` }),
  fleetd: Object.freeze({ repository: "ghcr.io/example/fleetd", digest: `sha256:${"3".repeat(64)}` }),
  bot: Object.freeze({ repository: "ghcr.io/example/bot", digest: `sha256:${"4".repeat(64)}` }),
  "hermes-dev": Object.freeze({ repository: "ghcr.io/example/dev", digest: `sha256:${"5".repeat(64)}` }),
  "hermes-node": Object.freeze({ repository: "ghcr.io/example/node", digest: `sha256:${"6".repeat(64)}` }),
});

for (const version of ["1.7.0", "1.7.0-rc.1"]) {
  for (const optional of [[], ["hermes-dev"], ["hermes-node"], ["hermes-dev", "hermes-node"]]) {
    test(`${version}: manifest preserves digests with optional components ${optional.join(", ") || "absent"}`, () => {
      const digests = Object.freeze(Object.fromEntries(
        ["board", "dockergate", "fleetd", "bot", ...optional].map((key) => [key, components[key]]),
      ));
      const input = Object.freeze({ version, digests });
      const before = structuredClone(input);
      const expectedComponents = {
        board: components.board,
        dockergate: components.dockergate,
        fleetd: components.fleetd,
        hermes: components.bot,
        ...Object.fromEntries(optional.map((key) => [key, components[key]])),
      };
      const expected = { schema: 1, version, tag: `myr-v${version}`, components: expectedComponents };
      const manifest = buildManifest(input);
      assert.deepStrictEqual(manifest, expected);
      assert.deepStrictEqual(buildManifest(input), expected);
      assert.deepStrictEqual(JSON.parse(JSON.stringify(manifest)), expected);
      assert.deepStrictEqual(input, before);
    });
  }
}
