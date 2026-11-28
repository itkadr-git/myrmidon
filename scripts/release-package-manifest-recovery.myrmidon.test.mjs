import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const sourceModule = resolve("scripts/release-package-map.mjs");
const scratchRoot = process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? homedir();

const manifestA = [
  { dir: "packages/myrmidon", name: "myrmidon", publishFromCi: true },
];
const manifestB = [
  { dir: "packages/myrmidon", name: "myrmidon", publishFromCi: true },
  { dir: "packages/myrmidon-addon", name: "@myrmidon/addon", publishFromCi: false },
];

async function makeFixture() {
  const fixture = await mkdtemp(join(scratchRoot, "myrmidon-manifest-recovery-"));
  const scriptsDir = join(fixture, "scripts");
  const packageDir = join(fixture, "packages", "myrmidon");
  await mkdir(scriptsDir, { recursive: true });
  await mkdir(packageDir, { recursive: true });
  await copyFile(sourceModule, join(scriptsDir, "release-package-map.mjs"));
  await writeFile(join(packageDir, "package.json"), `${JSON.stringify({ name: "myrmidon", version: "0.0.0" })}\n`);
  const manifestPath = join(scriptsDir, "release-package-manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifestA)}\n`);
  return { fixture, manifestPath, moduleUrl: pathToFileURL(join(scriptsDir, "release-package-map.mjs")).href };
}

test("loadReleaseManifest rereads the same manifest path after changes and failures", { timeout: 60_000 }, async () => {
  const { fixture, manifestPath, moduleUrl } = await makeFixture();
  try {
    const { loadReleaseManifest } = await import(moduleUrl);
    const before = await stat(manifestPath);
    const first = loadReleaseManifest();
    const after = await stat(manifestPath);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(await readFile(manifestPath, "utf8"), `${JSON.stringify(manifestA)}\n`);
    assert.deepEqual(first, manifestA);

    await writeFile(manifestPath, "{ broken json");
    assert.throws(() => loadReleaseManifest(), SyntaxError);

    await writeFile(manifestPath, `${JSON.stringify(manifestB)}\n`);
    const second = loadReleaseManifest();
    assert.deepEqual(second, manifestB);
    assert.deepEqual(first, manifestA);
    assert.notStrictEqual(second, first);

    await unlink(manifestPath);
    assert.throws(() => loadReleaseManifest(), /ENOENT/);

    await writeFile(manifestPath, `${JSON.stringify(manifestA)}\n`);
    const recovered = loadReleaseManifest();
    assert.deepEqual(recovered, manifestA);
    assert.deepEqual(second, manifestB);
    assert.notStrictEqual(recovered, second);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
