import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { paperclipRunnerBinaryNeedsBuild } from "../../dev-runner-native-binary.mjs";

const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR
  ?? process.env.PAPERCLIP_SCRATCH_DIR
  ?? path.join(process.env.HOME, "cache", "scratch");
const older = new Date("2020-01-01T00:00:00Z");
const equal = new Date("2020-01-01T00:00:10Z");
const newer = new Date("2020-01-01T00:00:20Z");
const inputs = [
  "Cargo.toml", "Cargo.lock", ".cargo/config.toml", "rust-toolchain",
  "rust-toolchain.toml", "crates/runner/src/deep/lib.rs",
];

async function withFixture(run) {
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, "native-build-inputs-"));
  try {
    const runner = path.join(root, "packages/paperclip-runner/runner");
    const binary = path.join(root, "packages/paperclip-runner/dist/bin/paperclip-runnerd");
    const files = [...inputs.map((name) => path.join(runner, name)), binary];
    for (const file of files) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, `fixture:${path.relative(root, file)}\n`);
    }
    const directories = [".", ".cargo", "crates", "crates/runner", "crates/runner/src", "crates/runner/src/deep"];
    for (const dir of directories) await utimes(path.join(runner, dir), older, older);
    await utimes(path.dirname(binary), older, older);
    for (const file of files) await utimes(file, older, older);
    await utimes(binary, equal, equal);
    await run({ root, runner, binary, files });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function decision(fixture, expected) {
  const before = await Promise.all(fixture.files.map((file) => readFile(file)));
  assert.equal(paperclipRunnerBinaryNeedsBuild({
    repoRoot: fixture.root,
    nativeRunnerRequired: true,
    configuredBinary: "",
    platform: "linux",
  }), expected);
  const after = await Promise.all(fixture.files.map((file) => readFile(file)));
  assert.deepEqual(after, before, "build check must not change source or binary bytes");
}

for (const input of inputs) {
  test(`${input}: older, equal and newer timestamps`, async () => {
    await withFixture(async (fixture) => {
      const file = path.join(fixture.runner, input);
      await decision(fixture, false);
      await utimes(file, equal, equal);
      assert.equal((await stat(file)).mtimeMs, (await stat(fixture.binary)).mtimeMs);
      await decision(fixture, false);
      await utimes(file, newer, newer);
      await decision(fixture, true);
    });
  });
}

test("missing optional input is ignored while a present newer input is detected", async () => {
  await withFixture(async (fixture) => {
    const optional = path.join(fixture.runner, "rust-toolchain.toml");
    await rm(optional);
    fixture.files = fixture.files.filter((file) => file !== optional);
    await decision(fixture, false);
    await utimes(path.join(fixture.runner, "Cargo.toml"), newer, newer);
    await decision(fixture, true);
  });
});

test("newer unrelated file is ignored while a newer input is detected", async () => {
  await withFixture(async (fixture) => {
    const unrelated = path.join(fixture.runner, "README.md");
    await writeFile(unrelated, "unrelated\n");
    await utimes(unrelated, newer, newer);
    fixture.files.push(unrelated);
    await decision(fixture, false);
    await utimes(path.join(fixture.runner, "Cargo.lock"), newer, newer);
    await decision(fixture, true);
  });
});
