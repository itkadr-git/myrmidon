import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { main, parseArgs } from "./check-prod-runtime-resolution.mjs";

function withFixture(run) {
  const base = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || path.join(os.homedir(), ".cache", "myrmidon-test");
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, "resolution-cli-"));
  try {
    run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function invoke(argv, cwd) {
  const logs = [];
  const errors = [];
  const code = main(argv, { log: (message) => logs.push(message), error: (message) => errors.push(message) }, cwd);
  return { code, logs, errors };
}

describe("runtime resolution CLI error channels", () => {
  const cases = [
    ["missing flag", [], "check-prod-runtime-resolution: укажите --dist <путь к собранному dist сервера>"],
    ["unknown flag", ["--unknown"], "check-prod-runtime-resolution: неизвестный аргумент: --unknown"],
    ["missing value", ["--dist"], "check-prod-runtime-resolution: --dist требует путь к собранному каталогу"],
    ["empty value", ["--dist="], "check-prod-runtime-resolution: укажите --dist <путь к собранному dist сервера>"],
    ["missing path", ["--dist", "missing"], "check-prod-runtime-resolution: dist не найден: missing (сначала соберите сервер)"],
    ["regular file", ["--dist", "file"], "check-prod-runtime-resolution: dist не найден: file (сначала соберите сервер)"],
  ];
  for (const [name, argv, error] of cases) {
    it(`reports ${name} only on the error channel with exit 2`, () => withFixture((dir) => {
      fs.writeFileSync(path.join(dir, "file"), "not a directory");
      assert.deepEqual(invoke(argv, dir), { code: 2, logs: [], errors: [error] });
    }));
  }

  it("reports an empty dist as success on the log channel", () => withFixture((dir) => {
    fs.mkdirSync(path.join(dir, "dist"));
    assert.deepEqual(invoke(["--dist", "dist"], dir), {
      code: 0, logs: ["0 сбоев в 0 пакетах"], errors: [],
    });
  }));

  it("reports a relative TypeScript import and summary on the error channel", () => withFixture((dir) => {
    fs.mkdirSync(path.join(dir, "dist"));
    fs.writeFileSync(path.join(dir, "dist", "index.js"), 'import "./broken.ts";\n');
    assert.deepEqual(invoke(["--dist", "dist"], dir), {
      code: 1, logs: [], errors: [
        "dist/index.js:1 ./broken.ts → относительный импорт .ts",
        "1 сбой в 0 пакетах",
      ],
    });
  }));
});

describe("parseArgs value preservation", () => {
  for (const argv of [
    ["--dist", "dir with spaces", "--skip-vendor-runner"],
    ["--skip-vendor-runner", "--dist", "dir with spaces"],
    ["--dist=dir with spaces", "--skip-vendor-runner"],
    ["--skip-vendor-runner", "--dist=dir with spaces"],
  ]) {
    it(`preserves argv and path for ${JSON.stringify(argv)}`, () => {
      const original = [...argv];
      assert.deepEqual(parseArgs(argv), { dist: "dir with spaces", skipVendorRunner: true });
      assert.deepEqual(argv, original);
    });
  }
});
