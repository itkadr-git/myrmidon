import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeStatus, main, safeErrorText } from "./review-check-run-probe.mjs";

const REPO = "owner/name";
const SHA = "bd4b5f8924df56595fde8268885f8f912ff6b262";

/** A fetch double that counts calls and serves scripted responses. */
function scriptedFetch(responses) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra fetch call");
    return typeof next === "function" ? next(url, init, calls) : next;
  };
  impl.calls = calls;
  return impl;
}

const json = (status, payload) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(payload),
});

const capture = () => {
  const lines = { out: [], err: [] };
  return {
    lines,
    log: (...xs) => lines.out.push(xs.join(" ")),
    error: (...xs) => lines.err.push(xs.join(" ")),
  };
};

const argvOk = ["--repo", REPO, "--ref", "feature"];

function assertNoTokenLeak(io, token) {
  const everything = [...io.lines.out, ...io.lines.err].join("\n");
  assert.ok(!everything.includes(token), "the token leaked into the output");
}

describe("describeStatus", () => {
  it("maps the documented statuses to concrete copy", () => {
    assert.match(describeStatus(403), /checks:write is missing/);
    assert.match(describeStatus(404), /not found/);
    assert.equal(describeStatus(401), "token rejected");
    assert.match(describeStatus(502), /github api error 502/);
  });
});

describe("safeErrorText", () => {
  it("keeps only the public message field", () => {
    assert.equal(safeErrorText(JSON.stringify({ message: "Not Found" })), "Not Found");
    assert.equal(safeErrorText("not json at all"), "");
  });
});

describe("main", () => {
  it("ok: resolves the sha then creates a completed neutral probe run", async () => {
    const fetchImpl = scriptedFetch([
      json(200, { sha: SHA }),
      (_url, init, calls) => {
        const body = JSON.parse(init.body);
        assert.equal(body.name, "Board review probe");
        assert.equal(body.head_sha, SHA);
        assert.equal(body.status, "completed");
        assert.equal(body.conclusion, "neutral");
        assert.equal(calls.length, 2);
        return json(201, { id: 4242, name: body.name });
      },
    ]);
    const io = { ...capture(), fetchImpl, env: { GH_TOKEN: "tok-secret-1" } };
    const code = await main(argvOk, io);
    assert.equal(code, 0);
    assert.match(io.lines.out.join("\n"), /^ok check_run_id=4242 /);
    assertNoTokenLeak(io, "tok-secret-1");
    assert.equal(fetchImpl.calls[0].url, `https://api.github.com/repos/${REPO}/commits/feature`);
    assert.equal(fetchImpl.calls[1].url, `https://api.github.com/repos/${REPO}/check-runs`);
    assert.equal(fetchImpl.calls[1].init.headers.Authorization, "Bearer tok-secret-1");
    assert.equal(fetchImpl.calls[1].init.method, "POST");
  });

  it("ok --json prints machine-readable output only", async () => {
    const fetchImpl = scriptedFetch([json(200, { sha: SHA }), json(201, { id: 7 })]);
    const io = { ...capture(), fetchImpl, env: { GITHUB_TOKEN: "tok-secret-2" } };
    const code = await main([...argvOk, "--json"], io);
    assert.equal(code, 0);
    const parsed = JSON.parse(io.lines.out.join("\n"));
    assert.deepEqual(
      { ok: parsed.ok, id: parsed.checkRunId, name: parsed.name },
      { ok: true, id: 7, name: "Board review probe" },
    );
    assertNoTokenLeak(io, "tok-secret-2");
  });

  it("403: names the missing right and exits nonzero without leaking the token", async () => {
    const fetchImpl = scriptedFetch([json(200, { sha: SHA }), json(403, { message: "Resource not accessible by integration" })]);
    const io = { ...capture(), fetchImpl, env: { GH_TOKEN: "tok-secret-3" } };
    const code = await main(argvOk, io);
    assert.equal(code, 1);
    assert.match(io.lines.err.join("\n"), /checks:write is missing/);
    assert.match(io.lines.err.join("\n"), /Resource not accessible by integration/);
    assertNoTokenLeak(io, "tok-secret-3");
  });

  it("404: reports the ref or repository as missing", async () => {
    const fetchImpl = scriptedFetch([json(404, { message: "Not Found" })]);
    const io = { ...capture(), fetchImpl, env: { GH_TOKEN: "tok-secret-4" } };
    const code = await main(argvOk, io);
    assert.equal(code, 1);
    assert.match(io.lines.err.join("\n"), /repository or ref not found/);
    assertNoTokenLeak(io, "tok-secret-4");
  });

  it("401: reports the token as rejected", async () => {
    const fetchImpl = scriptedFetch([json(401, { message: "Bad credentials" })]);
    const io = { ...capture(), fetchImpl, env: { GH_TOKEN: "tok-secret-5" } };
    const code = await main(argvOk, io);
    assert.equal(code, 1);
    assert.match(io.lines.err.join("\n"), /token rejected/);
    assertNoTokenLeak(io, "tok-secret-5");
  });

  it("missing token fails before any network call", async () => {
    const fetchImpl = scriptedFetch([]);
    const io = { ...capture(), fetchImpl, env: {} };
    const code = await main(argvOk, io);
    assert.equal(code, 2);
    assert.equal(fetchImpl.calls.length, 0);
    assert.match(io.lines.err.join("\n"), /GH_TOKEN or GITHUB_TOKEN/);
  });

  it("usage errors exit 2 without a network call", async () => {
    for (const argv of [[], ["--repo", REPO], ["--repo", "bad shape", "--ref", "x"]]) {
      const fetchImpl = scriptedFetch([]);
      const io = { ...capture(), fetchImpl, env: { GH_TOKEN: "t" } };
      const code = await main(argv, io);
      assert.equal(code, 2, `expected usage exit for ${JSON.stringify(argv)}`);
      assert.equal(fetchImpl.calls.length, 0);
    }
  });
});
