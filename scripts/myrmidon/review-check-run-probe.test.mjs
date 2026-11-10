import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PROBE_CHECK_NAME,
  ProbeError,
  createProbeCheckRun,
  fetchRefHead,
  main,
  parseArgs,
  runProbe,
  toProbeError,
} from "./review-check-run-probe.mjs";

const REPO = "owner/name";
const HEAD = "bd4b5f8924df56595fde8268885f8f912ff6b262";
const TOKEN = "ghs_secret_token_value_do_not_print";

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

/**
 * Fake fetch for the two GitHub calls the probe makes: the ref head lookup
 * (GET /commits/:ref) and the check run creation (POST /repos/:repo/check-runs).
 * Records every request so the tests assert on the payload and never leak the
 * token into a failure path.
 */
function fakeFetch({ headStatus = 200, createStatus = 201 } = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", body: init.body ?? null, headers: init.headers ?? {} });
    if (String(url).includes("/commits/")) {
      if (headStatus !== 200) return jsonResponse(headStatus, { message: "No commit found" });
      return jsonResponse(200, { sha: HEAD });
    }
    if (createStatus !== 201) return jsonResponse(createStatus, { message: "Resource not accessible" });
    return jsonResponse(201, { id: 424242 });
  };
  impl.calls = calls;
  return impl;
}

/** Assert the token appears in none of the captured outputs. */
function assertNoToken(outputs) {
  for (const text of outputs) assert.ok(!text.includes(TOKEN), `token leaked: ${text}`);
}

describe("parseArgs", () => {
  it("reads --repo, --ref and --json", () => {
    const args = parseArgs(["--repo", REPO, "--ref", "feature/x", "--json"]);
    assert.deepEqual(args, { repo: REPO, ref: "feature/x", json: true });
  });
  it("rejects a missing or malformed repo and a missing ref", () => {
    assert.throws(() => parseArgs([]), /--repo/);
    assert.throws(() => parseArgs(["--repo", "bad..repo", "--ref", "x"]), /--repo/);
    assert.throws(() => parseArgs(["--repo", REPO]), /--ref/);
    assert.throws(() => parseArgs(["--repo", REPO, "--nope"]), /Unknown argument/);
  });
});

describe("toProbeError", () => {
  it("maps 403 to the checks:write operator message", async () => {
    const err = await toProbeError(jsonResponse(403, {}));
    assert.equal(err.kind, "forbidden");
    assert.match(err.message, /checks:write/);
    assert.match(err.message, /оператору доски/);
  });
  it("maps 404 to repository/ref not found and 401 to a rejected token", async () => {
    assert.equal((await toProbeError(jsonResponse(404, {}))).kind, "not-found");
    assert.equal((await toProbeError(jsonResponse(401, {}))).kind, "unauthorized");
    assert.match((await toProbeError(jsonResponse(401, {}))).message, /токен не принят/);
  });
  it("keeps other statuses as generic http", async () => {
    const err = await toProbeError(jsonResponse(500, {}));
    assert.equal(err.kind, "http");
    assert.match(err.message, /HTTP 500/);
  });
});

describe("fetchRefHead", () => {
  it("GETs the ref commit and returns its sha", async () => {
    const impl = fakeFetch();
    const sha = await fetchRefHead(REPO, "feature/x", TOKEN, impl);
    assert.equal(sha, HEAD);
    assert.equal(impl.calls.length, 1);
    assert.ok(impl.calls[0].url.endsWith(`/repos/${REPO}/commits/feature%2Fx`));
    assert.equal(impl.calls[0].headers.Authorization, `Bearer ${TOKEN}`);
  });
  it("surfaces mapped ref errors and never the token", async () => {
    const impl = fakeFetch({ headStatus: 404 });
    await assert.rejects(() => fetchRefHead(REPO, "nope", TOKEN, impl), (err) => {
      assert.ok(err instanceof ProbeError);
      assert.equal(err.kind, "not-found");
      assertNoToken([err.message]);
      return true;
    });
  });
});

describe("createProbeCheckRun", () => {
  it("POSTs a completed neutral run named Board review probe, never the production name", async () => {
    const impl = fakeFetch();
    const id = await createProbeCheckRun(REPO, HEAD, TOKEN, impl);
    assert.equal(id, 424242);
    assert.equal(impl.calls.length, 1);
    assert.ok(impl.calls[0].url.endsWith(`/repos/${REPO}/check-runs`));
    assert.equal(impl.calls[0].method, "POST");
    const body = JSON.parse(impl.calls[0].body);
    assert.equal(body.name, "Board review probe");
    assert.notEqual(body.name, "Board review");
    assert.equal(body.head_sha, HEAD);
    assert.equal(body.status, "completed");
    assert.equal(body.conclusion, "neutral");
  });
  it("maps a 403 creation failure to the forbidden probe error", async () => {
    const impl = fakeFetch({ createStatus: 403 });
    await assert.rejects(() => createProbeCheckRun(REPO, HEAD, TOKEN, impl), (err) => {
      assert.equal(err.kind, "forbidden");
      assertNoToken([err.message]);
      return true;
    });
  });
});

describe("runProbe", () => {
  it("makes exactly two calls (commit lookup + create) and returns id and head", async () => {
    const impl = fakeFetch();
    const result = await runProbe({ repo: REPO, ref: "feature/x", fetchImpl: impl, env: { GH_TOKEN: TOKEN } });
    assert.deepEqual(result, { ok: true, checkRunId: 424242, headSha: HEAD, checkName: PROBE_CHECK_NAME });
    assert.equal(impl.calls.length, 2);
    assert.deepEqual(impl.calls.map((c) => c.method), ["GET", "POST"]);
  });
  it("fails without a token before any GitHub call", async () => {
    const impl = fakeFetch();
    await assert.rejects(() => runProbe({ repo: REPO, ref: "x", fetchImpl: impl, env: {} }), (err) => {
      assert.equal(err.kind, "usage");
      assert.equal(impl.calls.length, 0);
      return true;
    });
  });
  it("prefers GH_TOKEN over GITHUB_TOKEN and maps a 401 to unauthorized", async () => {
    const impl = fakeFetch({ headStatus: 401 });
    await assert.rejects(() => runProbe({ repo: REPO, ref: "x", fetchImpl: impl, env: { GH_TOKEN: TOKEN, GITHUB_TOKEN: "other" } }), (err) => {
      assert.equal(err.kind, "unauthorized");
      assertNoToken([err.message]);
      return true;
    });
  });
});

describe("main", () => {
  const quiet = { log: (line) => outputs.push(String(line)), error: (line) => outputs.push(String(line)) };
  let outputs;
  it("prints ok with the check run id and exits 0", async () => {
    outputs = [];
    const code = await main(["--repo", REPO, "--ref", "feature/x"], { ...quiet, fetchImpl: fakeFetch(), env: { GH_TOKEN: TOKEN } });
    assert.equal(code, 0);
    assert.match(outputs.join("\n"), /^ok: check run "Board review probe" id=424242/);
    assert.match(outputs.join("\n"), new RegExp(HEAD.slice(0, 12)));
    assertNoToken(outputs);
  });
  it("prints JSON with --json", async () => {
    outputs = [];
    const code = await main(["--repo", REPO, "--ref", "feature/x", "--json"], { ...quiet, fetchImpl: fakeFetch(), env: { GH_TOKEN: TOKEN } });
    assert.equal(code, 0);
    const parsed = JSON.parse(outputs[0]);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.checkRunId, 424242);
    assertNoToken(outputs);
  });
  it("answers 403 with the operator message and exit 1, never success", async () => {
    outputs = [];
    const code = await main(["--repo", REPO, "--ref", "x"], { ...quiet, fetchImpl: fakeFetch({ createStatus: 403 }), env: { GH_TOKEN: TOKEN } });
    assert.equal(code, 1);
    assert.match(outputs.join("\n"), /нет права checks:write/);
    assert.doesNotMatch(outputs.join("\n"), /^ok/);
    assertNoToken(outputs);
  });
  it("answers 404 with the not-found message", async () => {
    outputs = [];
    const code = await main(["--repo", REPO, "--ref", "ghost"], { ...quiet, fetchImpl: fakeFetch({ headStatus: 404 }), env: { GH_TOKEN: TOKEN } });
    assert.equal(code, 1);
    assert.match(outputs.join("\n"), /репозиторий или ветка не найдены/);
    assertNoToken(outputs);
  });
  it("answers 401 with the rejected-token message", async () => {
    outputs = [];
    const code = await main(["--repo", REPO, "--ref", "x"], { ...quiet, fetchImpl: fakeFetch({ headStatus: 401 }), env: { GH_TOKEN: TOKEN } });
    assert.equal(code, 1);
    assert.match(outputs.join("\n"), /токен не принят/);
    assertNoToken(outputs);
  });
  it("answers a missing token with usage exit 2", async () => {
    outputs = [];
    const impl = fakeFetch();
    const code = await main(["--repo", REPO, "--ref", "x"], { ...quiet, fetchImpl: impl, env: {} });
    assert.equal(code, 2);
    assert.equal(impl.calls.length, 0);
    assertNoToken(outputs);
  });
  it("rejects a bad repo as usage exit 2 without any call", async () => {
    outputs = [];
    const impl = fakeFetch();
    const code = await main(["--repo", "bad", "--ref", "x"], { ...quiet, fetchImpl: impl, env: { GH_TOKEN: TOKEN } });
    assert.equal(code, 2);
    assert.equal(impl.calls.length, 0);
  });
});
