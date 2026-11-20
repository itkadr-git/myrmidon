import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { main } from "./verify-on-prod.mjs";

const cli = fileURLToPath(new URL("./verify-on-prod.mjs", import.meta.url));
const required = {
  "version": "1.7.0",
  "health-url": "https://health.invalid/api/health",
  "api-url": "https://board.invalid",
  "company-id": "test-company",
};
const baseArgs = Object.entries(required).flatMap(([name, value]) => [`--${name}`, value]);
const scenarios = Object.keys(required).flatMap((name) => {
  const remaining = Object.entries(required)
    .filter(([key]) => key !== name)
    .flatMap(([key, value]) => [`--${key}`, value]);
  return [
    { description: `missing --${name}`, name, args: remaining },
    { description: `bare --${name}`, name, args: [...remaining, `--${name}`] },
    { description: `--${name} followed by another flag`, name, args: [`--${name}`, ...remaining] },
  ];
});
scenarios.push({ description: "unexpected positional argument", args: [...baseArgs, "unexpected"] });

for (const scenario of scenarios) {
  test(`main rejects ${scenario.description} before fetch`, async () => {
    const originalFetch = globalThis.fetch;
    const originalError = console.error;
    let requests = 0;
    let stderr = "";
    globalThis.fetch = async (url) => {
      requests += 1;
      throw new Error(`unexpected fetch: ${url}`);
    };
    console.error = (...args) => { stderr += args.join(" "); };
    try {
      await assert.rejects(main(scenario.args), (error) => {
        if (scenario.name) assert.match(error.message, new RegExp(`--${scenario.name}`));
        else assert.match(error.message, /unexpected argument/);
        return true;
      });
      assert.equal(requests, 0);
      assert.doesNotMatch(stderr, /\bPASS\b/);
    } finally {
      globalThis.fetch = originalFetch;
      console.error = originalError;
    }
  });

  test(`CLI rejects ${scenario.description} without a report`, () => {
    const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || path.join(os.homedir(), ".myrmidon-test-scratch");
    fs.mkdirSync(root, { recursive: true });
    const dir = fs.mkdtempSync(path.join(root, "verify-argv-"));
    const report = path.join(dir, "report.json");
    const preload = path.join(dir, "no-network.cjs");
    fs.writeFileSync(preload, 'globalThis.fetch = async (url) => { throw new Error(`unexpected fetch: ${url}`); };\n');
    try {
      const result = spawnSync(process.execPath, ["--require", preload, cli, ...scenario.args, "--report", report], {
        encoding: "utf8",
        env: { ...process.env, NODE_OPTIONS: "", PAPERCLIP_API_KEY: "synthetic-test-key" },
      });
      assert.ifError(result.error);
      assert.equal(result.status, 2, result.stderr);
      if (scenario.name) assert.match(result.stderr, new RegExp(`--${scenario.name}`));
      assert.doesNotMatch(result.stdout, /\bPASS\b/);
      assert.doesNotMatch(result.stderr, /\bPASS\b|unexpected fetch/);
      assert.equal(fs.existsSync(report), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
