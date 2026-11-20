import test from "node:test";
import assert from "node:assert/strict";
import { imageExists } from "../../preview-artifacts.mjs";

const sha = "a".repeat(40);
const base = "https://ghcr.io/v2/paperclipai/paperclip";
const tokenUrl = "https://ghcr.io/token?service=ghcr.io&scope=repository:paperclipai/paperclip:pull";
const tagUrl = `${base}/manifests/sha-${sha}-cloud`;
const digest = (letter) => `sha256:${letter.repeat(64)}`;
const arm = digest("b"), windows = digest("c"), first = digest("d"), second = digest("e"), config = digest("f");
const entry = (os, architecture, value) => ({ platform: { os, architecture }, digest: value });
const manifestUrl = (value) => `${base}/manifests/${value}`;
const blobUrl = (value) => `${base}/blobs/${value}`;
const json = (body) => new Response(JSON.stringify(body), { status: 200 });

function registry(indexOrManifest, selectedManifest) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url === tokenUrl) return json({ token: "fixture-token" });
    if (url === tagUrl) return json(indexOrManifest);
    if (url === manifestUrl(first)) return json(selectedManifest);
    if (url === blobUrl(config)) return json({ config: { Labels: { "org.opencontainers.image.revision": sha } } });
    assert.fail(`Unexpected registry request: ${url}`);
  };
  return { calls, fetchImpl };
}

const imageManifest = { config: { digest: config } };

test("selects linux amd64 after arm64 and ignores windows amd64", async () => {
  const r = registry({ manifests: [entry("linux", "arm64", arm), entry("windows", "amd64", windows), entry("linux", "amd64", first)] }, imageManifest);
  assert.equal(await imageExists(sha, r.fetchImpl), true);
  assert.deepEqual(r.calls, [tokenUrl, tagUrl, manifestUrl(first), blobUrl(config)]);
});

test("rejects an index without linux amd64 before requesting a manifest or blob", async () => {
  const r = registry({ manifests: [entry("linux", "arm64", arm), entry("windows", "amd64", windows)] });
  await assert.rejects(imageExists(sha, r.fetchImpl), /no Linux amd64 manifest/);
  assert.deepEqual(r.calls, [tokenUrl, tagUrl]);
});

test("selects the first of two linux amd64 entries", async () => {
  const r = registry({ manifests: [entry("linux", "amd64", first), entry("linux", "amd64", second)] }, imageManifest);
  assert.equal(await imageExists(sha, r.fetchImpl), true);
  assert.deepEqual(r.calls, [tokenUrl, tagUrl, manifestUrl(first), blobUrl(config)]);
});

test("rejects invalid selected entry digest before manifest fetch", async () => {
  const r = registry({ manifests: [entry("linux", "arm64", arm), entry("linux", "amd64", "sha256:invalid"), entry("linux", "amd64", second)] });
  await assert.rejects(imageExists(sha, r.fetchImpl), /Invalid image digest/);
  assert.deepEqual(r.calls, [tokenUrl, tagUrl]);
});

test("rejects invalid selected manifest config digest before blob fetch", async () => {
  const r = registry({ manifests: [entry("linux", "amd64", first)] }, { config: { digest: "sha256:invalid" } });
  await assert.rejects(imageExists(sha, r.fetchImpl), /Invalid image digest/);
  assert.deepEqual(r.calls, [tokenUrl, tagUrl, manifestUrl(first)]);
});

test("accepts a direct manifest without fetching another manifest", async () => {
  const r = registry(imageManifest);
  assert.equal(await imageExists(sha, r.fetchImpl), true);
  assert.deepEqual(r.calls, [tokenUrl, tagUrl, blobUrl(config)]);
});
