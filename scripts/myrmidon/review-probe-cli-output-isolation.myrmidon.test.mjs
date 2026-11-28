import assert from "node:assert/strict";
import { test } from "node:test";
import { main } from "./review-check-run-probe.mjs";

const messages = new Map([
  [401, "токен не принят"],
  [403, "нет права checks:write — нужна задача оператору доски"],
  [404, "репозиторий или ветка не найдены"],
  [503, "GitHub API вернул HTTP 503"],
]);

function harness({ token, head, id, failureAt, failure } = {}) {
  const calls = [];
  const stdout = [];
  const stderr = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? "GET";
    calls.push({ url, method, headers: init.headers, body: init.body });
    if (method === failureAt) {
      if (failure === "network") throw new Error(`connection failed: ${token} / ${token}`);
      return { ok: false, status: failure, json: async () => ({ message: token }) };
    }
    return { ok: true, status: 200, json: async () => method === "GET" ? { sha: head } : { id } };
  };
  return { calls, stdout, stderr, io: { log: (line) => stdout.push(line), error: (line) => stderr.push(line), fetchImpl } };
}

function assertNoSecrets(h, ...tokens) {
  for (const text of [...h.stdout, ...h.stderr]) {
    for (const token of tokens) assert.equal(text.includes(token), false, "output contains synthetic token");
  }
}

function assertRequests(h, { repo, ref, token, head }, expectedMethods) {
  assert.deepEqual(h.calls.map((call) => call.method), expectedMethods);
  assert.equal(h.calls[0].url, `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`);
  for (const call of h.calls) assert.equal(call.headers.Authorization, `Bearer ${token}`);
  if (expectedMethods.includes("POST")) {
    const post = h.calls[1];
    assert.equal(post.url, `https://api.github.com/repos/${repo}/check-runs`);
    const body = JSON.parse(post.body);
    assert.equal(body.name, "Board review probe");
    assert.notEqual(body.name, "Board review");
    assert.equal(body.head_sha, head);
    assert.equal(body.status, "completed");
    assert.equal(body.conclusion, "neutral");
  }
}

const repo = "example/project";
const ref = "topic/one";
const token = "synthetic-alpha-value";
const head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const id = 12345;
const args = ["--repo", repo, "--ref", ref, "--json"];

test("JSON success emits exactly one complete result and a neutral probe", async () => {
  const h = harness({ token, head, id });
  assert.equal(await main(args, { ...h.io, env: { GH_TOKEN: token } }), 0);
  assert.equal(h.stdout.length, 1);
  assert.deepEqual(JSON.parse(h.stdout[0]), { ok: true, checkRunId: id, headSha: head, checkName: "Board review probe" });
  assert.deepEqual(h.stderr, []);
  assertNoSecrets(h, token);
  assertRequests(h, { repo, ref, token, head }, ["GET", "POST"]);
});

for (const failureAt of ["GET", "POST"]) {
  for (const failure of [401, 403, 404, 503, "network"]) {
    test(`${failureAt} ${failure} emits only the expected error and exits 1`, async () => {
      const h = harness({ token, head, id, failureAt, failure });
      assert.equal(await main(args, { ...h.io, env: { GH_TOKEN: token } }), 1);
      assert.deepEqual(h.stdout, []);
      const expected = failure === "network" ? "GitHub недоступен: connection failed: <redacted> / <redacted>" : messages.get(failure);
      assert.deepEqual(h.stderr, [expected]);
      assertNoSecrets(h, token);
      assertRequests(h, { repo, ref, token, head }, failureAt === "GET" ? ["GET"] : ["GET", "POST"]);
    });
  }
}

test("usage failures emit only an error and never fetch", async () => {
  for (const [argv, env, message] of [
    [["--repo", "invalid", "--ref", ref, "--json"], { GH_TOKEN: token }, "--repo owner/name is required"],
    [args, {}, "GH_TOKEN или GITHUB_TOKEN не заданы"],
  ]) {
    const h = harness({ token, head, id });
    assert.equal(await main(argv, { ...h.io, env }), 2);
    assert.deepEqual(h.stdout, []);
    assert.deepEqual(h.stderr, [message]);
    assert.deepEqual(h.calls, []);
    assertNoSecrets(h, token);
  }
});

test("sequential invocations isolate env, credentials, requests and output", async () => {
  const other = { repo: "second/repository", ref: "other/branch", token: "synthetic-beta-value", head: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", id: 67890 };
  const first = harness({ token, head, id });
  const second = harness(other);
  assert.equal(await main(args, { ...first.io, env: { GH_TOKEN: token } }), 0);
  assert.equal(await main(["--repo", other.repo, "--ref", other.ref, "--json"], { ...second.io, env: { GITHUB_TOKEN: other.token } }), 0);
  assert.deepEqual(JSON.parse(first.stdout[0]), { ok: true, checkRunId: id, headSha: head, checkName: "Board review probe" });
  assert.deepEqual(JSON.parse(second.stdout[0]), { ok: true, checkRunId: other.id, headSha: other.head, checkName: "Board review probe" });
  assert.equal(first.stdout.length, 1);
  assert.equal(second.stdout.length, 1);
  assert.deepEqual(first.stderr, []);
  assert.deepEqual(second.stderr, []);
  assertNoSecrets(first, token, other.token);
  assertNoSecrets(second, token, other.token);
  assertRequests(first, { repo, ref, token, head }, ["GET", "POST"]);
  assertRequests(second, other, ["GET", "POST"]);
  assert.equal(second.stdout[0].includes(head), false);
  assert.equal(first.stdout[0].includes(other.head), false);
});
