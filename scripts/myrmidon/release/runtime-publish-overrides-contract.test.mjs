import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyToText, publishOverrides } from "../prod-runtime-exports.mjs";

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

describe("publishOverrides contract", () => {
  it("handles missing and null publishConfig without selecting bin", () => {
    for (const pkg of [{}, { publishConfig: null }, { publishConfig: { bin: "./bin.js" } }]) {
      deepFreeze(pkg);
      assert.deepEqual(publishOverrides(pkg), {});
    }
  });

  for (const [key, value] of [
    ["main", "./dist/index.js"],
    ["types", "./dist/index.d.ts"],
    ["exports", { ".": { import: { types: "./dist/index.d.ts", default: "./dist/index.js" }, require: "./dist/index.cjs" }, "./feature": null }],
  ]) {
    it(`selects ${key} independently, including explicit null but not undefined`, () => {
      for (const candidate of [value, null]) {
        const pkg = deepFreeze({ main: "original", types: "original", exports: "original", publishConfig: { [key]: candidate, bin: "./bin.js" } });
        const before = structuredClone(pkg);
        assert.deepEqual(publishOverrides(pkg), { [key]: candidate });
        assert.deepEqual(pkg, before);
      }
      assert.deepEqual(publishOverrides(deepFreeze({ publishConfig: { [key]: undefined, bin: "./bin.js" } })), {});
    });
  }

  it("keeps calls independent and preserves frozen input", () => {
    const pkg = deepFreeze({ publishConfig: { main: "./dist/a.js", types: null, exports: { ".": { default: "./dist/a.js" } }, bin: "./bin.js" } });
    const before = structuredClone(pkg);
    const first = publishOverrides(pkg);
    const second = publishOverrides(pkg);
    assert.deepEqual(first, { main: "./dist/a.js", types: null, exports: { ".": { default: "./dist/a.js" } } });
    assert.deepEqual(second, first);
    assert.notStrictEqual(first, second);
    first.main = "changed";
    assert.equal(second.main, "./dist/a.js");
    assert.deepEqual(pkg, before);
  });
});

describe("applyToText contract", () => {
  it("replaces only specified fields and serializes all other JSON values", () => {
    const text = '{"name":"example","main":"./src.js","types":"./src.d.ts","exports":{".":"./src.js"},"bin":{"example":"./cli.js"},"publishConfig":{"main":"./dist.js"},"extra":{"nil":null,"enabled":false,"count":0,"list":[1,"two",null]}}';
    const overrides = deepFreeze({ main: "./dist.js", exports: { ".": { import: "./dist.js", require: null } } });
    const before = structuredClone(overrides);
    const expected = `{
  "name": "example",
  "main": "./dist.js",
  "types": "./src.d.ts",
  "exports": {
    ".": {
      "import": "./dist.js",
      "require": null
    }
  },
  "bin": {
    "example": "./cli.js"
  },
  "publishConfig": {
    "main": "./dist.js"
  },
  "extra": {
    "nil": null,
    "enabled": false,
    "count": 0,
    "list": [
      1,
      "two",
      null
    ]
  }
}\n`;
    assert.equal(applyToText(text, overrides), expected);
    assert.deepEqual(overrides, before);
  });

  it("preserves explicit null and omits undefined under JSON serialization", () => {
    const text = '{"name":"example","main":"old","types":"old","exports":"old","other":null}';
    const overrides = deepFreeze({ main: null, types: undefined });
    const before = structuredClone(overrides);
    assert.equal(applyToText(text, overrides), '{\n  "name": "example",\n  "main": null,\n  "exports": "old",\n  "other": null\n}\n');
    assert.deepEqual(overrides, before);
    assert.equal(applyToText(text, deepFreeze({ exports: "new" })), '{\n  "name": "example",\n  "main": "old",\n  "types": "old",\n  "exports": "new",\n  "other": null\n}\n');
    assert.equal(applyToText(text, overrides), '{\n  "name": "example",\n  "main": null,\n  "exports": "old",\n  "other": null\n}\n');
  });

  it("rejects an empty-result substitute as a negative control", () => {
    const expected = '{\n  "main": "./dist.js"\n}\n';
    assert.equal(applyToText('{}', { main: "./dist.js" }), expected);
    assert.throws(() => assert.equal('', expected), assert.AssertionError);
    assert.throws(() => assert.deepEqual({}, { main: "./dist.js" }), assert.AssertionError);
  });
});
