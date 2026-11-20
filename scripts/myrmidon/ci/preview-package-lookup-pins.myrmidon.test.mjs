import assert from "node:assert/strict";
import test from "node:test";

import { packageExists } from "../../preview-artifacts.mjs";

const sha = "a".repeat(40);
const packageName = "@myrmidon/shared";
const previewVersion = `0.0.0-preview.g${sha}`;

function response(body, status = 200) {
  let jsonCalls = 0;
  return {
    status,
    ok: status >= 200 && status < 300,
    get jsonCalls() {
      return jsonCalls;
    },
    async json() {
      jsonCalls += 1;
      if (body instanceof Error) throw body;
      return body;
    },
  };
}

function packageMetadata(overrides = {}) {
  return {
    name: packageName,
    version: previewVersion,
    gitHead: sha,
    paperclipPreviewCommit: sha,
    dist: {
      integrity: "sha512-immutable-integrity-pin",
      tarball: `https://registry.npmjs.org/${encodeURIComponent(packageName)}/-/${packageName.slice(1)}-${previewVersion}.tgz`,
    },
    ...overrides,
  };
}

test("uses the exact encoded scoped package URL and an immutable SHA timeout signal", async () => {
  const calls = [];
  const result = await packageExists(packageName, sha, async (url, options) => {
    calls.push({ url, options });
    return response(packageMetadata());
  });

  assert.equal(result, true);
  assert.deepEqual(calls.map(({ url }) => url), [
    `https://registry.npmjs.org/%40myrmidon%2Fshared/0.0.0-preview.g${sha}`,
  ]);
  assert.equal(calls[0].options.signal instanceof AbortSignal, true);
});

test("accepts only complete package identity and both distribution pins", async () => {
  await assert.doesNotReject(packageExists(packageName, sha, async () => response(packageMetadata())));

  for (const missing of [
    ["dist", undefined],
    ["dist.integrity", { ...packageMetadata(), dist: { tarball: "https://example.test/package.tgz" } }],
    ["dist.tarball", { ...packageMetadata(), dist: { integrity: "sha512-pin" } }],
  ]) {
    const metadata = missing[1] === undefined
      ? { ...packageMetadata(), dist: undefined }
      : missing[1];
    await assert.rejects(
      packageExists(packageName, sha, async () => response(metadata)),
      /immutable distribution pin/,
      `missing ${missing[0]} must be rejected`,
    );
  }
});

test("does not turn malformed JSON or a rejected fetch into a missing package", async () => {
  await assert.rejects(
    packageExists(packageName, sha, async () => response(new SyntaxError("malformed JSON"))),
    /malformed JSON/,
  );
  await assert.rejects(
    packageExists(packageName, sha, async () => { throw new Error("network failed"); }),
    /network failed/,
  );
});

test("treats only 404 as missing and never parses its response body", async () => {
  const missing = response(new Error("404 body must not be parsed"), 404);
  assert.equal(await packageExists(packageName, sha, async () => missing), false);
  assert.equal(missing.jsonCalls, 0);

  for (const status of [401, 403, 429, 500, 503]) {
    const outage = response(new Error(`HTTP ${status} body must not be parsed`), status);
    await assert.rejects(
      packageExists(packageName, sha, async () => outage),
      new RegExp(`HTTP ${status}`),
    );
    assert.equal(outage.jsonCalls, 0, `HTTP ${status} body must not be parsed`);
  }
});

test("rejects an invalid SHA before invoking fetch", async () => {
  let fetchCalls = 0;
  await assert.rejects(
    packageExists(packageName, "not-a-full-sha", async () => {
      fetchCalls += 1;
      return response(packageMetadata());
    }),
    /full immutable commit SHA/,
  );
  assert.equal(fetchCalls, 0);
});

test("does not retain failed lookup state across independent calls", async () => {
  const calls = [];
  await assert.rejects(
    packageExists(packageName, sha, async () => {
      calls.push("failed");
      throw new Error("transient failure");
    }),
    /transient failure/,
  );

  const result = await packageExists(packageName, sha, async () => {
    calls.push("successful");
    return response(packageMetadata());
  });

  assert.equal(result, true);
  assert.deepEqual(calls, ["failed", "successful"]);
});
