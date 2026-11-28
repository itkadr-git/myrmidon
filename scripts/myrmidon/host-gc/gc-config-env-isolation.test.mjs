import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const moduleUrl = new URL("./host-clone-cache-gc.mjs", import.meta.url).href;
const prefix = "MYRMIDON_GC_ENV_ISOLATION_";
const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || os.homedir();

function runChild(envPath, tmpDir) {
  const script = `
    import { loadEnvConfig } from ${JSON.stringify(moduleUrl)};
    const result = loadEnvConfig(JSON.parse(process.argv[1]));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith(${JSON.stringify(prefix)})));
    console.log(JSON.stringify({ result, env }));
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(envPath)], {
    encoding: "utf8",
    cwd: path.dirname(fileURLToPath(import.meta.url)),
    env: { HOME: tmpDir, TMPDIR: tmpDir, [`${prefix}EXISTING`]: "original" },
  });
  assert.equal(child.status, 0, child.stderr || String(child.error));
  return JSON.parse(child.stdout);
}

function withFixture(fn) {
  const dir = fs.mkdtempSync(path.join(scratch, "gc-env-isolation-"));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("loadEnvConfig parses values and isolates existing and duplicate environment keys", () => {
  withFixture((dir) => {
    const envFile = path.join(dir, "synthetic.env");
    fs.writeFileSync(envFile, [
      "  # ignored comment",
      "  ",
      `${prefix}NO_EQUALS`,
      `  ${prefix}SPACED  =  padded value  `,
      `${prefix}SINGLE='single value'`,
      `${prefix}DOUBLE="double value"`,
      `${prefix}EQUALS=first=second`,
      `${prefix}EXISTING=file value`,
      `${prefix}NEW=synthetic apiKey`,
      `${prefix}DUPLICATE=first`,
      `${prefix}DUPLICATE=last`,
      "",
    ].join("\n"));
    const { result, env } = runChild(envFile, dir);
    assert.deepEqual(result, {
      [`${prefix}SPACED`]: "padded value",
      [`${prefix}SINGLE`]: "single value",
      [`${prefix}DOUBLE`]: "double value",
      [`${prefix}EQUALS`]: "first=second",
      [`${prefix}EXISTING`]: "file value",
      [`${prefix}NEW`]: "synthetic apiKey",
      [`${prefix}DUPLICATE`]: "last",
    });
    assert.deepEqual(env, { ...result, [`${prefix}EXISTING`]: "original", [`${prefix}DUPLICATE`]: "first" });
  });
});

test("loadEnvConfig ignores an empty path, absent file, and directory", () => {
  withFixture((dir) => {
    for (const envPath of ["", path.join(dir, "missing.env"), dir]) {
      assert.deepEqual(runChild(envPath, dir), {
        result: {},
        env: { [`${prefix}EXISTING`]: "original" },
      });
    }
  });
});
