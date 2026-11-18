import test from "node:test";
import assert from "node:assert/strict";
import { imageExists } from "../../preview-artifacts.mjs";

const sha = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
const tokenUrl = "https://ghcr.io/token?service=ghcr.io&scope=repository:paperclipai/paperclip:pull";
const base = "https://ghcr.io/v2/paperclipai/paperclip";
const signedUrl = "https://storage.example.test/config?signature=fixture";
const headers = {
  Authorization: "Bearer test-pull-token",
  Accept: "application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json",
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const config = (revision = sha) => json({ config: { Labels: { "org.opencontainers.image.revision": revision } } });

function fixture(blob, final) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, headers: options.headers, redirect: options.redirect });
    switch (calls.length) {
      case 1: return json({ token: "test-pull-token" });
      case 2: return json({ config: { digest } });
      case 3: return blob;
      case 4: return final;
      default: throw new Error("Unexpected fetch");
    }
  };
  return { calls, fetchImpl };
}

function expectedCalls(follow = false) {
  const calls = [
    { url: tokenUrl, headers: undefined, redirect: undefined },
    { url: `${base}/manifests/sha-${sha}-cloud`, headers, redirect: "error" },
    { url: `${base}/blobs/${digest}`, headers, redirect: "manual" },
  ];
  if (follow) calls.push({ url: signedUrl, headers: undefined, redirect: "error" });
  return calls;
}

for (const status of [301, 302, 307, 308]) {
  test(`blob ${status} follows signed HTTPS without registry credentials`, async () => {
    const f = fixture(new Response(null, { status, headers: { location: signedUrl } }), config());
    assert.equal(await imageExists(sha, f.fetchImpl), true);
    assert.deepEqual(f.calls, expectedCalls(true));
  });
}

for (const [name, location] of [
  ["HTTP", "http://storage.example.test/config"],
  ["username", "https://user@storage.example.test/config"],
  ["password", "https://user:password@storage.example.test/config"],
  ["missing location", null],
]) {
  test(`blob redirect rejects ${name} before following`, async () => {
    const f = fixture(new Response(null, { status: 302, headers: location ? { location } : {} }));
    await assert.rejects(imageExists(sha, f.fetchImpl), /Invalid registry blob redirect|Invalid URL/);
    assert.deepEqual(f.calls, expectedCalls());
  });
}

test("redirected non-ok config is rejected", async () => {
  const f = fixture(new Response(null, { status: 302, headers: { location: signedUrl } }), json({}, 503));
  await assert.rejects(imageExists(sha, f.fetchImpl), /GHCR config lookup failed: HTTP 503/);
  assert.deepEqual(f.calls, expectedCalls(true));
});

test("redirected config with wrong revision is rejected", async () => {
  const f = fixture(new Response(null, { status: 302, headers: { location: signedUrl } }), config("c".repeat(40)));
  await assert.rejects(imageExists(sha, f.fetchImpl), /does not match the requested full commit/);
  assert.deepEqual(f.calls, expectedCalls(true));
});

test("direct config with matching revision is reused without a follow-up", async () => {
  const f = fixture(config());
  assert.equal(await imageExists(sha, f.fetchImpl), true);
  assert.deepEqual(f.calls, expectedCalls());
});
