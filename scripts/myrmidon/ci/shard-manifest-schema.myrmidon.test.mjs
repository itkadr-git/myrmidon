import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadShardDurations } from "../../general-server-shard.mjs";

const scratchRoot = process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? path.join(os.homedir(), "cache", "scratch");
mkdirSync(scratchRoot, { recursive: true });

function withManifest(contents, callback) {
  const directory = mkdtempSync(path.join(scratchRoot, "shard-manifest-schema-"));
  const manifestPath = path.join(directory, "durations.json");
  try {
    writeFileSync(manifestPath, contents);
    return callback(manifestPath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("missing manifest returns an empty object", () => {
  const directory = mkdtempSync(path.join(scratchRoot, "shard-manifest-missing-"));
  try {
    assert.deepEqual(loadShardDurations(path.join(directory, "missing.json")), {});
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("malformed JSON returns an empty object", () => {
  withManifest('{ "durations": ', (manifestPath) => {
    assert.deepEqual(loadShardDurations(manifestPath), {});
  });
});

test("null root returns an empty object", () => {
  withManifest("null", (manifestPath) => assert.deepEqual(loadShardDurations(manifestPath), {}));
});

test("string root returns an empty object", () => {
  withManifest('"manifest"', (manifestPath) => assert.deepEqual(loadShardDurations(manifestPath), {}));
});

test("number root returns an empty object", () => {
  withManifest("42", (manifestPath) => assert.deepEqual(loadShardDurations(manifestPath), {}));
});

test("boolean root returns an empty object", () => {
  withManifest("true", (manifestPath) => assert.deepEqual(loadShardDurations(manifestPath), {}));
});

test("root without durations returns an empty object", () => {
  withManifest('{ "version": 1 }', (manifestPath) => assert.deepEqual(loadShardDurations(manifestPath), {}));
});

test("null durations returns an empty object", () => {
  withManifest('{ "durations": null }', (manifestPath) => assert.deepEqual(loadShardDurations(manifestPath), {}));
});

test("array durations returns an empty object", () => {
  withManifest('{ "durations": [1, 2] }', (manifestPath) => assert.deepEqual(loadShardDurations(manifestPath), {}));
});

test("string durations returns an empty object", () => {
  withManifest('{ "durations": "not-a-map" }', (manifestPath) => assert.deepEqual(loadShardDurations(manifestPath), {}));
});

test("empty durations object returns an empty object", () => {
  withManifest('{ "durations": {} }', (manifestPath) => assert.deepEqual(loadShardDurations(manifestPath), {}));
});

test("zero and fractional durations retain their exact keys and values", () => {
  withManifest(JSON.stringify({ durations: { "zero.test.mjs": 0, "fraction.test.mjs": 12.5 } }), (manifestPath) => {
    assert.deepEqual(loadShardDurations(manifestPath), {
      "zero.test.mjs": 0,
      "fraction.test.mjs": 12.5,
    });
  });
});

test("negative durations are filtered while valid values remain", () => {
  withManifest(JSON.stringify({ durations: { "negative.test.mjs": -1, "valid.test.mjs": 7 } }), (manifestPath) => {
    assert.deepEqual(loadShardDurations(manifestPath), { "valid.test.mjs": 7 });
  });
});

test("string, null, and object durations are filtered", () => {
  withManifest(JSON.stringify({ durations: {
    "string.test.mjs": "8",
    "null.test.mjs": null,
    "object.test.mjs": { milliseconds: 9 },
    "valid.test.mjs": 11,
  } }), (manifestPath) => {
    assert.deepEqual(loadShardDurations(manifestPath), { "valid.test.mjs": 11 });
  });
});

test("mixed boundaries preserve only non-negative numeric durations", () => {
  withManifest(JSON.stringify({ durations: {
    "zero.test.mjs": 0,
    "fraction.test.mjs": 0.25,
    "negative.test.mjs": -0.25,
    "string.test.mjs": "0.5",
    "null.test.mjs": null,
    "object.test.mjs": {},
    "whole.test.mjs": 100,
  } }), (manifestPath) => {
    assert.deepEqual(loadShardDurations(manifestPath), {
      "zero.test.mjs": 0,
      "fraction.test.mjs": 0.25,
      "whole.test.mjs": 100,
    });
  });
});

test("re-reading a changed manifest does not use a cached result", () => {
  withManifest(JSON.stringify({ durations: { "first.test.mjs": 1 } }), (manifestPath) => {
    assert.deepEqual(loadShardDurations(manifestPath), { "first.test.mjs": 1 });
    writeFileSync(manifestPath, JSON.stringify({ durations: { "second.test.mjs": 2 } }));
    assert.deepEqual(loadShardDurations(manifestPath), { "second.test.mjs": 2 });
  });
});
