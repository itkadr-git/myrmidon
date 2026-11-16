import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { publishPreview } from "../../preview-artifacts.mjs";

const sha = "a".repeat(40);
const version = `0.0.0-preview.g${sha}`;
const names = ["@myrmidon/shared", "@myrmidon/db"];
const manifest = (name) => ({
  name, version, gitHead: sha, paperclipPreviewCommit: sha,
  ...(name === names[1] ? { dependencies: { [names[0]]: version } } : {}),
});

function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "preview-order-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const name of names) {
    const bytes = Buffer.from(JSON.stringify(manifest(name)));
    const header = Buffer.alloc(512);
    header.write("package/package.json");
    header.write(bytes.length.toString(8).padStart(11, "0"), 124, 11);
    header[156] = 48;
    const padded = Buffer.alloc(Math.ceil(bytes.length / 512) * 512);
    bytes.copy(padded);
    writeFileSync(path.join(dir, `${name.split("/")[1]}.tgz`), gzipSync(Buffer.concat([header, padded, Buffer.alloc(1024)])));
  }
  return dir;
}

const present = (name) => new Response(JSON.stringify({ ...manifest(name), dist: { integrity: "test", tarball: "https://registry.npmjs.org/test.tgz" } }), { status: 200 });
const missing = () => new Response(null, { status: 404 });
const lookup = (url) => {
  const parsed = new URL(url);
  assert.equal(parsed.origin, "https://registry.npmjs.org");
  assert.equal(parsed.pathname.split("/")[2], version);
  const name = decodeURIComponent(parsed.pathname.split("/")[1]);
  assert.ok(names.includes(name));
  return name;
};
const publish = (dir, short) => ["exec", "npm", ["publish", path.join(dir, `${short}.tgz`), "--tag", "preview", "--access", "public", "--ignore-scripts", "--provenance", "--registry", "https://registry.npmjs.org"], { stdio: "inherit" }];
const sameError = (expected) => (actual) => { assert.strictEqual(actual, expected); return true; };

function harness(dir, respond, failure) {
  const events = [];
  return {
    events,
    options: {
      fetchImpl: async (url) => { const name = lookup(url); events.push(["fetch", name]); return respond(name, events); },
      exec: (command, args, options) => { events.push(["exec", command, args, options]); if (failure && args[1] === path.join(dir, `${failure.short}.tgz`)) throw failure.error; },
      sleep: async (ms) => { events.push(["sleep", ms]); },
    },
  };
}

test("shared publish failure prevents DB publication and polling", async (t) => {
  const dir = fixture(t), error = new Error("shared publish failed");
  const h = harness(dir, () => missing(), { short: "shared", error });
  await assert.rejects(publishPreview(dir, sha, h.options), sameError(error));
  assert.deepEqual(h.events, [["fetch", names[0]], publish(dir, "shared")]);
});

test("DB publish failure after reuse never polls", async (t) => {
  const dir = fixture(t), error = new Error("db publish failed");
  const h = harness(dir, (name) => name === names[0] ? present(name) : missing(), { short: "db", error });
  await assert.rejects(publishPreview(dir, sha, h.options), sameError(error));
  assert.deepEqual(h.events, [["fetch", names[0]], ["fetch", names[1]], publish(dir, "db")]);
});

test("shared lookup failure prevents all publication", async (t) => {
  const dir = fixture(t), error = new Error("lookup failed");
  const h = harness(dir, () => { throw error; });
  await assert.rejects(publishPreview(dir, sha, h.options), sameError(error));
  assert.deepEqual(h.events, [["fetch", names[0]]]);
});

test("visibility failure propagates unchanged without republishing", async (t) => {
  const dir = fixture(t), error = new Error("visibility failed");
  const h = harness(dir, (_name, events) => {
    if (events.filter((event) => event[0] === "exec").length === 2) throw error;
    return missing();
  });
  await assert.rejects(publishPreview(dir, sha, h.options), sameError(error));
  assert.deepEqual(h.events, [["fetch", names[0]], publish(dir, "shared"), ["fetch", names[1]], publish(dir, "db"), ["fetch", names[0]], ["fetch", names[1]]]);
});

test("polling drops visible shared and sleeps only while DB remains pending", async (t) => {
  const dir = fixture(t);
  let dbPolls = 0;
  const h = harness(dir, (name, events) => {
    if (events.filter((event) => event[0] === "exec").length < 2) return missing();
    if (name === names[0]) return present(name);
    return ++dbPolls === 3 ? present(name) : missing();
  });
  assert.equal(await publishPreview(dir, sha, h.options), undefined);
  assert.deepEqual(h.events, [["fetch", names[0]], publish(dir, "shared"), ["fetch", names[1]], publish(dir, "db"), ["fetch", names[0]], ["fetch", names[1]], ["sleep", 10000], ["fetch", names[1]], ["sleep", 10000], ["fetch", names[1]]]);
});
