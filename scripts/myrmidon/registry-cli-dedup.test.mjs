import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { verifyPackageRegistryState, createManifestLookupKey } from "../verify-release-registry-state.mjs";

const scriptPath = fileURLToPath(new URL("../verify-release-registry-state.mjs", import.meta.url));
const version = "2026.1116.0";

for (const packages of [
  ["single-package", "single-package", "single-package"],
  ["@myrmidon/alpha", "@myrmidon/alpha", "beta", "@myrmidon/alpha", "beta"],
  ["@myrmidon/alpha", "beta", "@myrmidon/gamma", "beta", "@myrmidon/gamma", "@myrmidon/alpha"],
]) {
  test(`stable CLI deduplicates registry requests for ${new Set(packages).size} packages`, { timeout: 15_000 }, async () => {
    const names = [...new Set(packages)];
    const routes = new Map();
    for (const name of names) {
      const doc = { name, "dist-tags": { latest: version }, versions: {} };
      const manifest = { name, version };
      const path = `/${encodeURIComponent(name)}`;
      routes.set(path, doc);
      routes.set(`${path}/${version}`, manifest);
      assert.deepEqual(verifyPackageRegistryState({
        packageName: name, packageDoc: doc, packageDocsByName: new Map([[name, doc]]),
        packageManifestsByKey: new Map([[createManifestLookupKey(name, version), manifest]]),
        channel: "stable", distTag: "latest", targetVersion: version,
      }), []);
    }

    const requests = [];
    const sockets = new Set();
    const server = createServer((req, res) => {
      requests.push({ method: req.method, url: req.url, headers: req.headers });
      const body = routes.get(req.url);
      res.writeHead(body ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify(body ?? { error: "unexpected request" }));
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    server.requestTimeout = 5_000;
    server.headersTimeout = 5_000;
    let child;
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        !/npm|registry|token|auth|credential|proxy/i.test(key),
      ));
      env.npm_config_registry = `http://127.0.0.1:${server.address().port}/`;
      child = spawn(process.execPath, [scriptPath, "--channel", "stable", "--dist-tag", "latest",
        "--target-version", version, ...packages.flatMap((name) => ["--package", name])],
      { env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
      const timer = setTimeout(() => child.kill("SIGKILL"), 8_000);
      let result;
      try {
        result = await once(child, "close");
      } finally {
        clearTimeout(timer);
      }
      assert.deepEqual(result, [0, null], `CLI failed: ${stderr}`);
      assert.deepEqual(requests.map(({ method, url }) => `${method} ${url}`).sort(),
        [...routes.keys()].map((path) => `GET ${path}`).sort());
      assert.deepEqual(stdout.split("\n").filter((line) => line.startsWith("  Verifying ")).sort(),
        names.map((name) => `  Verifying ${name} on dist-tag latest`).sort());
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
}
