import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const source = fileURLToPath(new URL("./vendor-release-add.mjs", import.meta.url));
const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || os.homedir();

function files(root, dir = root) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const name = path.join(dir, entry.name);
    return entry.isDirectory() ? files(root, name) : [path.relative(root, name)];
  }).sort();
}

async function fixture(registry, run) {
  const root = mkdtempSync(path.join(scratch, "vendor-diagnostic-"));
  const script = path.join(root, "scripts/myrmidon/vendor-release-add.mjs");
  const target = path.join(root, "cli/src/commands/myrmidon-migrate-vendor-releases.ts");
  const bin = path.join(root, "bin");
  const sentinel = path.join(root, "gh-called");
  const oldPath = process.env.PATH;
  try {
    mkdirSync(path.dirname(script), { recursive: true });
    mkdirSync(path.dirname(target), { recursive: true });
    mkdirSync(bin);
    copyFileSync(source, script);
    writeFileSync(path.join(bin, "gh"), `#!/bin/sh\ntouch '${sentinel}'\nexit 99\n`, { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}${oldPath || ""}`;
    if (registry !== null) writeFileSync(target, registry);
    const before = registry === null ? null : readFileSync(target);
    const beforeFiles = files(root);
    const moduleUrl = pathToFileURL(script);
    moduleUrl.searchParams.set("fixture", path.basename(root));
    const { formatUnsupportedRelease } = await import(moduleUrl.href);
    await run(formatUnsupportedRelease);
    assert.equal(existsSync(target), before !== null);
    if (before !== null) assert.deepEqual(readFileSync(target), before);
    assert.deepEqual(files(root), beforeFiles);
    assert.equal(existsSync(sentinel), false, "diagnostic must not invoke gh");
  } finally {
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
  }
}

function expected(tag, count, last, supported) {
  return [
    `Paperclip release ${tag} is not supported by myrmidon migrate.`,
    `Release migrations: ${count}.`,
    `Last migration: ${last}.`,
    `Supported source releases: ${supported}.`,
    `Add it: node scripts/myrmidon/vendor-release-add.mjs ${tag}`,
  ].join("\n");
}

const base = "v2026.916.1";

test("missing registry reports only the base release", async () => {
  await fixture(null, (format) => assert.deepEqual(format("v2026.1200.0", 317, "0318_new"), expected("v2026.1200.0", 317, "0318_new", base)));
});

test("registry without releases header reports only the base release", async () => {
  await fixture("// not releases: v2026.100.0\n", (format) => assert.deepEqual(format("v2026.1200.0", 317, "0318_new"), expected("v2026.1200.0", 317, "0318_new", base)));
});

test("empty releases header reports only the base release", async () => {
  await fixture("// releases:   \n", (format) => assert.deepEqual(format("v2026.1200.0", 317, "0318_new"), expected("v2026.1200.0", 317, "0318_new", base)));
});

test("reverse releases and whitespace use numeric version ordering", async () => {
  await fixture("// releases:   v2026.100.1  v2026.100.0\t v2026.99.0   \n", (format) => assert.deepEqual(format("v2026.1200.0", 317, "0318_new"), expected("v2026.1200.0", 317, "0318_new", "v2026.99.0, v2026.100.0, v2026.100.1, v2026.916.1")));
});

test("tag and migration bounds including zero are preserved exactly", async () => {
  await fixture("// releases: v2026.100.0\n", (format) => {
    assert.deepEqual(format("v2030.7.42", 0, "0000_initial-name"), expected("v2030.7.42", 0, "0000_initial-name", "v2026.100.0, v2026.916.1"));
    assert.deepEqual(format("v2031.8.3", 1234, "1234_last_migration"), expected("v2031.8.3", 1234, "1234_last_migration", "v2026.100.0, v2026.916.1"));
  });
});

test("repeated calls return the same diagnostic without modifying registry", async () => {
  await fixture("// releases: v2026.100.1 v2026.99.0\n", (format) => {
    const result = expected("v2026.1200.0", 2, "0002_final", "v2026.99.0, v2026.100.1, v2026.916.1");
    assert.deepEqual(format("v2026.1200.0", 2, "0002_final"), result);
    assert.deepEqual(format("v2026.1200.0", 2, "0002_final"), result);
  });
});
