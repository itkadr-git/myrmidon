import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyRuns, decide, resolveTagSha } from "./tag-ci-reuse.mjs";

// CI-TAG-REUSE-BRANCH-RUN: the decision of the tag workflow on a replaced runs API.

const SHA = "c78a6c9fde4992a98e5e76d3fd556e33bb87935a";
const run = (over = {}) => ({
  head_sha: SHA,
  path: ".github/workflows/myrmidon-ci.yml",
  head_branch: "rel/1.6.6-fixes",
  event: "push",
  status: "completed",
  conclusion: "success",
  ...over,
});

// A fake clock: sleep advances it, so no test waits for real.
function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

const opts = (fetchRuns, extra = {}) => ({ fetchRuns, sha: SHA, ...clock(), timeoutMs: 600_000, intervalMs: 30_000, graceMs: 90_000, ...extra });

describe("classifyRuns", () => {
  it("a green push run on a rel branch is success", () => {
    assert.equal(classifyRuns([run()], SHA), "success");
  });
  it("a green workflow_dispatch run on main is success", () => {
    assert.equal(classifyRuns([run({ event: "workflow_dispatch", head_branch: "main" })], SHA), "success");
  });
  it("a green pull_request run is not counted (fast tier)", () => {
    assert.equal(classifyRuns([run({ event: "pull_request" })], SHA), "none");
  });
  it("a run of another commit or another workflow is not counted", () => {
    assert.equal(classifyRuns([run({ head_sha: "deadbeef" }), run({ path: ".github/workflows/myrmidon-ci-tag.yml" })], SHA), "none");
  });
  it("an in-progress run is pending, a red one is failed, red plus green is success", () => {
    assert.equal(classifyRuns([run({ status: "in_progress", conclusion: null })], SHA), "pending");
    assert.equal(classifyRuns([run({ conclusion: "failure" })], SHA), "failed");
    assert.equal(classifyRuns([run({ conclusion: "failure" }), run()], SHA), "success");
  });
  it("a cancelled run is not a red verdict: it is its own state", () => {
    assert.equal(classifyRuns([run({ conclusion: "cancelled" })], SHA), "cancelled");
  });
  it("a cancelled run while another attempt is pending is pending", () => {
    assert.equal(classifyRuns([run({ conclusion: "cancelled" }), run({ status: "in_progress", conclusion: null })], SHA), "pending");
  });
  it("a cancelled run plus a green re-run is success", () => {
    assert.equal(classifyRuns([run({ conclusion: "cancelled" }), run()], SHA), "success");
  });
  it("a cancelled run plus a red one is failed (a red verdict exists)", () => {
    assert.equal(classifyRuns([run({ conclusion: "cancelled" }), run({ conclusion: "failure" })], SHA), "failed");
  });
});

describe("decide", () => {
  it("reuses a green branch run at once", async () => {
    const r = await decide(opts(async () => [run()]));
    assert.equal(r.mode, "reuse");
  });

  it("waits for a running branch run and reuses it when it turns green", async () => {
    let n = 0;
    const r = await decide(opts(async () => [n++ < 3 ? run({ status: "in_progress", conclusion: null }) : run()]));
    assert.equal(r.mode, "reuse");
    assert.equal(n, 4);
  });

  it("waits for the re-run of a cancelled branch run and reuses it when it turns green (rc.12/rc.13 of 1.6.9)", async () => {
    let n = 0;
    // The first poll sees the cancelled attempt (the state at the tag cut on
    // 16.11); the re-run then starts and goes green.
    const r = await decide(opts(async () => {
      n++;
      if (n === 1) return [run({ conclusion: "cancelled" })];
      if (n < 4) return [run({ status: "in_progress", conclusion: null })];
      return [run()];
    }));
    assert.equal(r.mode, "reuse");
    assert.ok(n > 1, "polled past the cancelled state instead of falling to the full pipeline");
  });

  it("waits for the re-run of a cancelled branch run and goes full when the re-run is red", async () => {
    let n = 0;
    const r = await decide(opts(async () => {
      n++;
      return n === 1 ? [run({ conclusion: "cancelled" })] : [run({ conclusion: "failure" })];
    }));
    assert.equal(r.mode, "full");
    assert.match(r.reason, /did not succeed/);
  });

  it("runs the full pipeline when the cancelled branch run is never re-run within the timeout", async () => {
    const r = await decide(opts(async () => [run({ conclusion: "cancelled" })], { timeoutMs: 120_000 }));
    assert.equal(r.mode, "full");
    assert.match(r.reason, /timed out/);
    assert.match(r.reason, /cancelled/);
  });

  it("runs the full pipeline when the waited run turns red", async () => {
    let n = 0;
    const r = await decide(opts(async () => [n++ < 1 ? run({ status: "queued", conclusion: null }) : run({ conclusion: "failure" })]));
    assert.equal(r.mode, "full");
    assert.match(r.reason, /did not succeed/);
  });

  it("runs the full pipeline when the branch run never finishes within the timeout", async () => {
    const r = await decide(opts(async () => [run({ status: "in_progress", conclusion: null })], { timeoutMs: 120_000 }));
    assert.equal(r.mode, "full");
    assert.match(r.reason, /timed out/);
  });

  it("runs the full pipeline when no branch run exists, after the grace for a run that is just starting", async () => {
    let reads = 0;
    const r = await decide(opts(async () => { reads++; return []; }));
    assert.equal(r.mode, "full");
    assert.match(r.reason, /no branch run/);
    assert.ok(reads > 1, "polled during the grace");
  });

  it("picks up a branch run that appears within the grace", async () => {
    let n = 0;
    const r = await decide(opts(async () => (n++ < 1 ? [] : [run()])));
    assert.equal(r.mode, "reuse");
  });

  it("ignores a pull_request run: full pipeline", async () => {
    const r = await decide(opts(async () => [run({ event: "pull_request" })]));
    assert.equal(r.mode, "full");
  });

  it("survives a transient API error and still reuses", async () => {
    let n = 0;
    const r = await decide(opts(async () => { if (n++ < 1) throw new Error("HTTP 502"); return [run()]; }));
    assert.equal(r.mode, "reuse");
  });

  it("a persistently failing API means the full pipeline, never a free pass", async () => {
    const r = await decide(opts(async () => { throw new Error("HTTP 500"); }));
    assert.equal(r.mode, "full");
    assert.match(r.reason, /API kept failing/);
  });
});

describe("resolveTagSha", () => {
  it("dereferences an annotated tag", async () => {
    const answers = {
      "git/ref/tags/myr-v1.6.9-rc.1": { object: { type: "tag", sha: "tagobj" } },
      "git/tags/tagobj": { object: { type: "commit", sha: SHA } },
    };
    assert.equal(await resolveTagSha(async (p) => answers[p], "myr-v1.6.9-rc.1"), SHA);
  });
  it("takes the commit of a lightweight tag", async () => {
    assert.equal(await resolveTagSha(async () => ({ object: { type: "commit", sha: SHA } }), "t"), SHA);
  });
});
