import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { fetchRegistryJson } from "../verify-release-registry-state.mjs";

const COUNT = 12;
const ACCEPT = "application/vnd.npm.install-v1+json, application/json;q=0.9";

test("registry requests retain their identity across reversed concurrent responses", { timeout: 15_000 }, async () => {
  const requests = [];
  const responses = [];
  const sockets = new Set();
  const pending = new Map();
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, accept: request.headers.accept });
    const url = new URL(request.url, "http://127.0.0.1");
    const round = Number(url.searchParams.get("round"));
    const index = Number(url.searchParams.get("index"));
    if (!pending.has(round)) pending.set(round, []);
    const group = pending.get(round);
    group.push({ index, response });
    if (group.length === COUNT) {
      for (const item of group.sort((a, b) => b.index - a.index)) {
        responses.push({ round, index: item.index });
        item.response.writeHead(round === 2 && item.index === 5 ? 500 : 200, {
          "content-type": "application/json",
        });
        item.response.end(JSON.stringify({ round, index: item.index }));
      }
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    for (let round = 0; round < 3; round += 1) {
      const paths = Array.from({ length: COUNT }, (_, index) =>
        `/package-${index}/manifest?round=${round}&index=${index}`);
      const results = await Promise.allSettled(paths.map((path) =>
        fetchRegistryJson(`${base}${path}`, { timeoutMs: 3_000 })));
      for (let index = 0; index < COUNT; index += 1) {
        const result = results[index];
        if (round === 2 && index === 5) {
          assert.equal(result.status, "rejected");
          assert.match(result.reason.message, /500/);
        } else {
          assert.equal(result.status, "fulfilled");
          assert.deepEqual(result.value, { round, index });
        }
      }
      assert.deepEqual(responses.filter((entry) => entry.round === round).map((entry) => entry.index),
        Array.from({ length: COUNT }, (_, index) => COUNT - index - 1));
      assert.deepEqual(requests.slice(round * COUNT).sort((a, b) => a.url.localeCompare(b.url)),
        paths.map((url) => ({ method: "GET", url, accept: ACCEPT })).sort((a, b) => a.url.localeCompare(b.url)));
      assert.equal(requests.length, (round + 1) * COUNT);
    }
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});


test("negative control detects a changed accept header", { timeout: 20_000 }, async () => {
  if (process.env.MYRMIDON_REGISTRY_NEGATIVE_CONTROL === "1") return;
  const root = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? homedir(), "registry-isolation-"));
  let child;
  try {
    const scripts = join(root, "scripts");
    await mkdir(join(scripts, "myrmidon"), { recursive: true });
    const production = await readFile(new URL("../verify-release-registry-state.mjs", import.meta.url), "utf8");
    const mutated = production.replace(ACCEPT, "application/json");
    assert.notEqual(mutated, production, "negative control must mutate the production header");
    await writeFile(join(scripts, "verify-release-registry-state.mjs"), mutated);
    await writeFile(join(scripts, "myrmidon", "registry-http-isolation.test.mjs"), await readFile(fileURLToPath(import.meta.url)));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/npm|registry|token|auth|credential/i.test(key)));
    // A nested node --test must not inherit the parent test runner's context.
    delete env.NODE_TEST_CONTEXT;
    env.MYRMIDON_REGISTRY_NEGATIVE_CONTROL = "1";
    child = spawn(process.execPath, ["--test", join(scripts, "myrmidon", "registry-http-isolation.test.mjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    let code;
    try {
      [code] = await once(child, "close");
    } finally {
      clearTimeout(timer);
    }
    assert.equal(code, 1, output);
    assert.match(output, /application\/vnd\.npm\.install-v1\+json/);
    assert.match(output, /registry requests retain their identity/);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});
