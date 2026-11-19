import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const source = fileURLToPath(new URL("./release-package-map.mjs", import.meta.url));
const version = "2026.11.16";
const sections = ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"];
const paths = ["cli/package.json", "packages/shared/package.json", "packages/offtrain/package.json"];
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function fixture(run, { spec = "workspace:*", cliVersion = '"old"' } = {}) {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const root = mkdtempSync(join(scratch, "myrmidon-version-"));
  const put = (path, data) => {
    const dest = join(root, path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, data);
  };
  const read = (path) => readFileSync(join(root, path), "utf8");
  const cli = { name: "myrmidon", version: "old", description: "keep metadata", custom: { flag: true } };
  for (const section of sections) {
    cli[section] = {
      "@myrmidon/shared": spec,
      "@myrmidon/pinned": "^1.2.3",
      "other-package": "workspace:*",
      "@myrmidon/nonstring": 42,
    };
  }
  const shared = { name: "@myrmidon/shared", version: "old", license: "MIT" };
  const offtrain = { name: "@myrmidon/offtrain", version: "old", description: "untouched" };
  try {
    put("scripts/release-package-manifest.json", json([
      { dir: "cli", name: "myrmidon", publishFromCi: true },
      { dir: "packages/shared", name: "@myrmidon/shared", publishFromCi: true },
      { dir: "packages/offtrain", name: "@myrmidon/offtrain", publishFromCi: false },
    ]));
    copyFileSync(source, join(root, "scripts/release-package-map.mjs"));
    put(paths[0], json(cli));
    put(paths[1], json(shared));
    put(paths[2], json(offtrain));
    put("cli/src/index.ts", `program.version(${cliVersion});\n`);
    const invoke = (...args) => spawnSync(process.execPath, [join(root, "scripts/release-package-map.mjs"), "set-version", ...args], { cwd: root, encoding: "utf8", timeout: 10000 });
    run({ cli, shared, read, invoke });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function success(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
}

for (const spec of ["workspace:*", "workspace:^", "workspace:~"]) {
  test(`rewrites ${spec} in every dependency section and preserves other fields`, () => fixture(({ cli, shared, read, invoke }) => {
    const disabled = read(paths[2]);
    success(invoke(version));
    const expected = structuredClone(cli);
    expected.version = version;
    for (const section of sections) expected[section]["@myrmidon/shared"] = version;
    assert.deepEqual(JSON.parse(read(paths[0])), expected);
    assert.deepEqual(JSON.parse(read(paths[1])), { ...shared, version });
    assert.equal(read(paths[2]), disabled);
    assert.equal(read("cli/src/index.ts"), `program.version("${version}");\n`);
  }, { spec }));
}

test("dynamic CLI version is accepted without editing the entrypoint", () => fixture(({ read, invoke }) => {
  const before = read("cli/src/index.ts");
  success(invoke(version));
  assert.equal(read("cli/src/index.ts"), before);
  assert.equal(JSON.parse(read(paths[0])).version, version);
  assert.equal(JSON.parse(read(paths[1])).version, version);
}, { cliVersion: "cliVersion" }));

test("repeating a version preserves all package and CLI bytes", () => fixture(({ read, invoke }) => {
  success(invoke(version));
  const files = [...paths, "cli/src/index.ts"];
  const before = files.map(read);
  success(invoke(version));
  assert.deepEqual(files.map(read), before);
}));

test("missing version exits with usage without modifying any package", () => fixture(({ read, invoke }) => {
  const before = paths.map(read);
  const entry = read("cli/src/index.ts");
  const result = invoke();
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "Usage:\n  node scripts/release-package-map.mjs list\n  node scripts/release-package-map.mjs check\n  node scripts/release-package-map.mjs set-version <version>\n");
  assert.deepEqual(paths.map(read), before);
  assert.equal(read("cli/src/index.ts"), entry);
}));
