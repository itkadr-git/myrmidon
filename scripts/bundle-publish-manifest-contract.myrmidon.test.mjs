import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { materializePublishManifest } from "./prepare-bundled-package.mjs";

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

describe("materializePublishManifest contract", () => {
  it("materializes publish fields and workspace ranges without mutating the input", () => {
    const source = {
      name: "fixture",
      version: "2.3.4",
      main: "./src/index.js",
      types: "./src/index.d.ts",
      exports: { ".": "./src/index.js" },
      bin: { fixture: "./src/cli.js" },
      publishConfig: {
        main: "./dist/index.js",
        types: "./dist/index.d.ts",
        exports: { ".": { import: "./dist/index.js", types: "./dist/index.d.ts" } },
        bin: { fixture: "./dist/cli.js" },
        access: "public",
      },
      dependencies: { star: "workspace:*", caret: "workspace:^", tilde: "workspace:~", external: "^5.6.0" },
      optionalDependencies: { star: "workspace:*", caret: "workspace:^", tilde: "workspace:~", external: "~7.8.0" },
      peerDependencies: { star: "workspace:*", caret: "workspace:^", tilde: "workspace:~", external: ">=1.0.0" },
      devDependencies: { local: "workspace:*" },
    };
    const original = structuredClone(source);
    deepFreeze(source);

    const expected = {
      name: "fixture",
      version: "2.3.4",
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
      exports: { ".": { import: "./dist/index.js", types: "./dist/index.d.ts" } },
      bin: { fixture: "./dist/cli.js" },
      dependencies: { star: "2.3.4", caret: "^2.3.4", tilde: "~2.3.4", external: "^5.6.0" },
      optionalDependencies: { star: "2.3.4", caret: "^2.3.4", tilde: "~2.3.4", external: "~7.8.0" },
      peerDependencies: { star: "2.3.4", caret: "^2.3.4", tilde: "~2.3.4", external: ">=1.0.0" },
      devDependencies: { local: "workspace:*" },
    };
    const first = materializePublishManifest(source);
    const second = materializePublishManifest(source);
    assert.deepStrictEqual(first, expected);
    assert.deepStrictEqual(second, expected);
    assert.deepStrictEqual(first, second);
    assert.deepStrictEqual(source, original);
    assert.equal(Object.hasOwn(first, "publishConfig"), false);
  });

  it("preserves existing entry points when publishConfig is absent or partial", () => {
    const source = deepFreeze({
      name: "fixture",
      version: "1.0.0",
      main: "./index.js",
      types: "./index.d.ts",
      exports: { ".": "./index.js" },
      bin: "./cli.js",
    });
    assert.deepStrictEqual(materializePublishManifest(source), source);
    assert.deepStrictEqual(materializePublishManifest({ ...source, publishConfig: { main: "./dist.js" } }), {
      ...source,
      main: "./dist.js",
    });
  });
});
