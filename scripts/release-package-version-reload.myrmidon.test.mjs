import assert from "node:assert/strict";
import test from "node:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const source = fileURLToPath(new URL("./release-package-map.mjs", import.meta.url));
const a = { name: "@myrmidon/a", version: "1.0.0", dependencies: { "@myrmidon/b": "workspace:*" } };
const b = { name: "@myrmidon/b", version: "1.0.0", peerDependencies: { zod: "^3.0.0" } };
const cli = { name: "myrmidon", version: "1.0.0", dependencies: { "@myrmidon/a": "workspace:*" } };
const manifest = [
  { dir: "packages/a", name: "@myrmidon/a", publishFromCi: true },
  { dir: "packages/b", name: "@myrmidon/b", publishFromCi: true },
  { dir: "cli", name: "myrmidon", publishFromCi: true },
];
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

test("release APIs reread versions and recover from invalid metadata without mutation", async () => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), ".cache", "myrmidon-release-tests");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "version-reload-"));
  try {
    const files = {
      "scripts/release-package-manifest.json": json(manifest),
      "packages/a/package.json": json(a),
      "packages/b/package.json": json(b),
      "cli/package.json": json(cli),
    };
    for (const [path, bytes] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), bytes);
    }
    const modulePath = join(root, "scripts/release-package-map.mjs");
    copyFileSync(source, modulePath);
    files["scripts/release-package-map.mjs"] = readFileSync(source, "utf8");
    const api = await import(pathToFileURL(modulePath).href);
    const verifyBytes = () => {
      for (const [path, bytes] of Object.entries(files)) assert.equal(readFileSync(join(root, path), "utf8"), bytes, path);
    };
    const check = (expectedVersion) => {
      const plan = api.buildReleasePackagePlan();
      const published = api.getReleasePackages();
      for (const result of [plan, published]) {
        assert.deepEqual(Object.fromEntries(result.map((p) => [p.name, p.version])), {
          "@myrmidon/a": expectedVersion, "@myrmidon/b": "1.0.0", myrmidon: "1.0.0",
        });
        assert.deepEqual(Object.fromEntries(result.map((p) => [p.name, p.pkg])), {
          "@myrmidon/a": { ...a, version: expectedVersion }, "@myrmidon/b": b, myrmidon: cli,
        });
        assert.ok(result.every((p) => p.publishFromCi === true));
      }
      verifyBytes();
      return [plan, published];
    };
    const first = check("1.0.0");
    const firstSnapshot = structuredClone(first);
    files["packages/a/package.json"] = json({ ...a, version: "2.0.0" });
    writeFileSync(join(root, "packages/a/package.json"), files["packages/a/package.json"]);
    const second = check("2.0.0");
    const secondSnapshot = structuredClone(second);
    files["packages/a/package.json"] = "{invalid json\n";
    writeFileSync(join(root, "packages/a/package.json"), files["packages/a/package.json"]);
    assert.throws(() => api.buildReleasePackagePlan(), SyntaxError);
    assert.throws(() => api.getReleasePackages(), SyntaxError);
    verifyBytes();
    files["packages/a/package.json"] = json(a);
    writeFileSync(join(root, "packages/a/package.json"), files["packages/a/package.json"]);
    check("1.0.0");
    assert.deepEqual(first, firstSnapshot);
    assert.deepEqual(second, secondSnapshot);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
