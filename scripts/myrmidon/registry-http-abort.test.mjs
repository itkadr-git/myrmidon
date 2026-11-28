import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { fetchRegistryJson } from "../verify-release-registry-state.mjs";

const scriptPath = fileURLToPath(new URL("../verify-release-registry-state.mjs", import.meta.url));
const accept = "application/vnd.npm.install-v1+json, application/json;q=0.9";
const testOptions = { timeout: 10000 };
const fixtureTimeoutMs = 8000;

async function fixture(run) {
  const requests = [];
  const sockets = new Set();
  let releaseHeld;
  let heldArrived;
  const heldResponse = new Promise((resolve) => { releaseHeld = resolve; });
  const heldRequest = new Promise((resolve) => { heldArrived = resolve; });
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, accept: req.headers.accept, authorization: req.headers.authorization });
    if (req.url === "/hang") return;
    if (req.url === "/held") {
      heldArrived();
      heldResponse.then(() => {
        if (!res.destroyed) res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
      });
      return;
    }
    if (req.url === "/reset") return req.socket.destroy();
    const documents = {
      "/fast": { ok: true },
      "/%40myrmidon%2Ffixture": { "dist-tags": { latest: "1.2.3" }, versions: { "1.2.3": { name: "@myrmidon/fixture", version: "1.2.3" } } },
      "/%40myrmidon%2Ffixture/1.2.3": { name: "@myrmidon/fixture", version: "1.2.3" },
    };
    if (!Object.hasOwn(documents, req.url)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(documents[req.url]));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  let timer;
  try {
    // The node:test timeout does not unwind a pending fixture callback.
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`registry fixture exceeded ${fixtureTimeoutMs}ms at ${base}`)), fixtureTimeoutMs);
    });
    await Promise.race([deadline, run({ base, requests, heldRequest, releaseHeld })]);
  } finally {
    clearTimeout(timer);
    releaseHeld();
    const closed = once(server, "close");
    server.close();
    for (const socket of sockets) socket.destroy();
    await closed;
  }
}

for (const timeoutMs of [25, 50, 100]) {
  test(`hung headers produce a ${timeoutMs}ms timeout diagnostic`, testOptions, async () => {
    await fixture(async ({ base, requests }) => {
      const url = `${base}/hang`;
      await assert.rejects(fetchRegistryJson(url, { timeoutMs }), (error) => {
        assert.equal(error.message, `npm registry request timed out for ${url} after ${timeoutMs}ms`);
        return true;
      });
      // The shortest timeout can expire before a heavily loaded runner connects.
      assert.ok(requests.length <= 1);
      if (requests.length) assert.equal(requests[0].url, "/hang");
    });
  });
}

test("fast JSON succeeds with a 1000ms timeout", testOptions, async () => {
  await fixture(async ({ base, requests }) => {
    assert.deepEqual(await fetchRegistryJson(`${base}/fast`, { timeoutMs: 1000 }), { ok: true });
    assert.deepEqual(requests, [{ method: "GET", url: "/fast", accept, authorization: undefined }]);
  });
});

test("aborting one concurrent request does not cancel the other", testOptions, async () => {
  await fixture(async ({ base, requests, heldRequest, releaseHeld }) => {
    const held = fetchRegistryJson(`${base}/held`, { timeoutMs: 5000 });
    held.catch(() => {});
    await heldRequest;
    const hung = assert.rejects(fetchRegistryJson(`${base}/hang`, { timeoutMs: 1000 }), /timed out/);
    await hung;
    releaseHeld();
    assert.deepEqual(await held, { ok: true });
    assert.deepEqual(requests.map((r) => r.url).sort(), ["/hang", "/held"]);
  });
});

test("connection reset is not reported as a timeout", testOptions, async () => {
  await fixture(async ({ base, requests }) => {
    await assert.rejects(fetchRegistryJson(`${base}/reset`, { timeoutMs: 1000 }), (error) => {
      assert.doesNotMatch(error.message, /timed out/i);
      assert.equal(error.cause?.code, "UND_ERR_SOCKET");
      return true;
    });
    assert.deepEqual(requests.map((r) => r.url), ["/reset"]);
  });
});

test("a request after an abort succeeds", testOptions, async () => {
  await fixture(async ({ base, requests }) => {
    await assert.rejects(fetchRegistryJson(`${base}/hang`, { timeoutMs: 100 }), /timed out/);
    assert.deepEqual(await fetchRegistryJson(`${base}/fast`, { timeoutMs: 1000 }), { ok: true });
    assert.deepEqual(requests.map((r) => r.url), ["/hang", "/fast"]);
  });
});

test("CLI reads only the expected loopback registry documents", testOptions, async () => {
  await fixture(async ({ base, requests }) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/npm|registry|token|auth/i.test(key)));
    env.npm_config_registry = base;
    const child = spawn(process.execPath, [scriptPath, "--channel", "stable", "--dist-tag", "latest", "--target-version", "1.2.3", "--package", "@myrmidon/fixture"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      const [code, signal] = await once(child, "close");
      assert.equal(signal, null);
      assert.equal(code, 0, stderr);
      assert.match(stdout, /consistent/);
      assert.deepEqual(requests, [
        { method: "GET", url: "/%40myrmidon%2Ffixture", accept, authorization: undefined },
        { method: "GET", url: "/%40myrmidon%2Ffixture/1.2.3", accept, authorization: undefined },
      ]);
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });
});
