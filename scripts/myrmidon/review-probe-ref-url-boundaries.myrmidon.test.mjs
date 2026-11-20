import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchRefHead, ProbeError } from "./review-check-run-probe.mjs";

const repo = "owner-name/project.name";
const token = "synthetic-test-credential";
const sha = "AbC123-exact-head";

function recorder(body) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, json: async () => body };
    },
  };
}

describe("fetchRefHead URL boundaries", () => {
  const refs = [
    ["feature/topic", "feature%2Ftopic"],
    ["with space", "with%20space"],
    ["100%done", "100%25done"],
    ["branch#fragment", "branch%23fragment"],
    ["branch?query=yes", "branch%3Fquery%3Dyes"],
    ["\u96ea/\u00e9", "%E9%9B%AA%2F%C3%A9"],
    ["a/b %?#\u96ea", "a%2Fb%20%25%3F%23%E9%9B%AA"],
  ];
  for (const [ref, encoded] of refs) {
    it(`encodes ${JSON.stringify(ref)} as one path segment`, async () => {
      const fake = recorder({ sha });
      assert.equal(await fetchRefHead(repo, ref, token, fake.fetchImpl), sha);
      assert.equal(fake.calls.length, 1);
      const { url, init } = fake.calls[0];
      assert.equal(url, `https://api.github.com/repos/${repo}/commits/${encoded}`);
      const parsed = new URL(url);
      assert.equal(parsed.search, "");
      assert.equal(parsed.hash, "");
      assert.equal(init.method ?? "GET", "GET");
      assert.equal(init.body, undefined);
      assert.deepEqual(init.headers, {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "myrmidon-review-check-run-probe",
        "X-GitHub-Api-Version": "2022-11-28",
      });
      assert.ok(!url.includes(token));
      assert.ok(!JSON.stringify({ ...init, headers: { ...init.headers, Authorization: undefined } }).includes(token));
    });
  }

  for (const [label, body] of [["missing", {}], ["null", { sha: null }], ["number", { sha: 123 }], ["empty", { sha: "" }]]) {
    it(`rejects ${label} sha`, async () => {
      const fake = recorder(body);
      await assert.rejects(fetchRefHead(repo, "main", token, fake.fetchImpl), (error) => {
        assert.ok(error instanceof ProbeError);
        assert.equal(error.kind, "http");
        assert.equal(error.message, "GitHub \u043d\u0435 \u0432\u0435\u0440\u043d\u0443\u043b sha \u0433\u043e\u043b\u043e\u0432\u044b ref");
        return true;
      });
      assert.equal(fake.calls.length, 1);
    });
  }

  it("does not contaminate arguments or subsequent calls", async () => {
    const args = Object.freeze([repo, "first/#? %", token]);
    const fake = recorder({ sha });
    assert.equal(await fetchRefHead(...args, fake.fetchImpl), sha);
    const first = structuredClone(fake.calls[0]);
    fake.calls[0].init.headers.Accept = "changed by caller";
    const next = recorder({ sha: "second-head" });
    assert.equal(await fetchRefHead("other/repo", "next/ref", "another-credential", next.fetchImpl), "second-head");
    assert.deepEqual(args, [repo, "first/#? %", token]);
    assert.equal(first.url, "https://api.github.com/repos/owner-name/project.name/commits/first%2F%23%3F%20%25");
    assert.equal(next.calls.length, 1);
    assert.equal(next.calls[0].url, "https://api.github.com/repos/other/repo/commits/next%2Fref");
    assert.equal(next.calls[0].init.headers.Accept, "application/vnd.github+json");
    assert.equal(next.calls[0].init.headers.Authorization, "Bearer another-credential");
    assert.ok(!JSON.stringify(next.calls).includes(token));
  });
});
