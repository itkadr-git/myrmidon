import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveTagSha } from "./tag-ci-reuse.mjs";

describe("resolveTagSha annotated tag chains", () => {
  it("follows three tag objects in order and stops at the commit", async () => {
    const calls = [];
    const answers = {
      "git/ref/tags/release": { object: { type: "tag", sha: "one" } },
      "git/tags/one": { object: { type: "tag", sha: "two" } },
      "git/tags/two": { object: { type: "tag", sha: "three" } },
      "git/tags/three": { object: { type: "commit", sha: "commit-sha" } },
    };
    const result = await resolveTagSha(async (path) => {
      calls.push(path);
      assert.ok(Object.hasOwn(answers, path), `unexpected request: ${path}`);
      return answers[path];
    }, "release");
    assert.equal(result, "commit-sha");
    assert.deepEqual(calls, ["git/ref/tags/release", "git/tags/one", "git/tags/two", "git/tags/three"]);
  });

  it("propagates the first request failure unchanged", async () => {
    const failure = new Error("reference unavailable");
    const calls = [];
    await assert.rejects(resolveTagSha(async (path) => {
      calls.push(path);
      throw failure;
    }, "release"), (error) => error === failure);
    assert.deepEqual(calls, ["git/ref/tags/release"]);
  });

  it("propagates an intermediate tag request failure unchanged", async () => {
    const failure = new Error("tag unavailable");
    const calls = [];
    await assert.rejects(resolveTagSha(async (path) => {
      calls.push(path);
      if (path === "git/ref/tags/release") return { object: { type: "tag", sha: "one" } };
      if (path === "git/tags/one") return { object: { type: "tag", sha: "two" } };
      throw failure;
    }, "release"), (error) => error === failure);
    assert.deepEqual(calls, ["git/ref/tags/release", "git/tags/one", "git/tags/two"]);
  });

  it("keeps sequential resolutions for different tags independent", async () => {
    const calls = [];
    const answers = {
      "git/ref/tags/first": { object: { type: "tag", sha: "first-object" } },
      "git/tags/first-object": { object: { type: "commit", sha: "first-commit" } },
      "git/ref/tags/second": { object: { type: "tag", sha: "second-object" } },
      "git/tags/second-object": { object: { type: "commit", sha: "second-commit" } },
    };
    const get = async (path) => {
      calls.push(path);
      assert.ok(Object.hasOwn(answers, path), `unexpected request: ${path}`);
      return answers[path];
    };
    assert.equal(await resolveTagSha(get, "first"), "first-commit");
    assert.equal(await resolveTagSha(get, "second"), "second-commit");
    assert.deepEqual(calls, ["git/ref/tags/first", "git/tags/first-object", "git/ref/tags/second", "git/tags/second-object"]);
  });
});
