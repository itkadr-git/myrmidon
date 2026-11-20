import assert from "node:assert/strict";
import { test } from "node:test";
import { componentDigest } from "./release-body.mjs";

const repository = "myrmidon-dockergate";
const version = "1.7.0-rc.3";
const digest = `sha256:${"a".repeat(64)}`;
const token = "example-test-token";
const tokenUrl = `https://ghcr.io/token?scope=${encodeURIComponent(`repository:itkadr-git/${repository}:pull`)}`;
const manifestUrl = `https://ghcr.io/v2/itkadr-git/${repository}/manifests/${version}`;

function successfulManifest(events) {
  return { ok: true, headers: { get(name) { events.push(["get", name]); return digest; } } };
}

function transport(failure) {
  const calls = [];
  const events = [];
  let request = 0;
  const fetchImpl = async (url, options) => {
    calls.push([url, options]);
    const current = request++;
    if (current === 0) {
      if (failure === "token fetch throws") throw new Error("token transport");
      if (failure === "token non-ok") return { ok: false };
      return { ok: true, async json() {
        events.push(["json"]);
        if (failure === "token json rejects") throw new Error("token json");
        return { token };
      } };
    }
    if (current === 1) {
      if (failure === "manifest fetch throws") throw new Error("manifest transport");
      if (failure === "manifest non-ok") return { ok: false };
      if (failure === "headers.get throws") return { ok: true, headers: { get(name) {
        events.push(["get", name]);
        throw new Error("headers");
      } } };
      return successfulManifest(events);
    }
    throw new Error("unexpected retry");
  };
  return { calls, events, fetchImpl };
}

function assertRequests(calls, count) {
  assert.equal(calls.length, count);
  assert.deepEqual(calls[0], [tokenUrl, undefined]);
  if (count === 2) {
    assert.equal(calls[1][0], manifestUrl);
    assert.equal(calls[1][1].headers.Authorization, `Bearer ${token}`);
    assert.ok(calls[1][1].headers.Accept.includes("application/vnd.oci.image.index.v1+json"));
  }
}

for (const [failure, count, expectedEvents] of [
  ["token non-ok", 1, []],
  ["token json rejects", 1, [["json"]]],
  ["token fetch throws", 1, []],
  ["manifest non-ok", 2, [["json"]]],
  ["manifest fetch throws", 2, [["json"]]],
  ["headers.get throws", 2, [["json"], ["get", "docker-content-digest"]]],
]) {
  test(`${failure} fails closed and the next independent request succeeds`, async () => {
    const failed = transport(failure);
    assert.equal(await componentDigest(repository, version, { fetchImpl: failed.fetchImpl }), null);
    assertRequests(failed.calls, count);
    assert.deepEqual(failed.events, expectedEvents);

    const next = transport();
    assert.equal(await componentDigest(repository, version, { fetchImpl: next.fetchImpl }), digest);
    assertRequests(next.calls, 2);
    assert.deepEqual(next.events, [["json"], ["get", "docker-content-digest"]]);
  });
}

test("successful token and manifest resolve the digest", async () => {
  const mock = transport();
  assert.equal(await componentDigest(repository, version, { fetchImpl: mock.fetchImpl }), digest);
  assertRequests(mock.calls, 2);
  assert.deepEqual(mock.events, [["json"], ["get", "docker-content-digest"]]);
});
