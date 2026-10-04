import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// myrmidon(1.6.2 BOT-DISK-C): pnpm hard-links node_modules into its store only
// when the project and the store share a mount. This runs the same script the
// dev image's build runs (docker/bot-runtime/pnpm-hardlink-check.sh) with the
// pnpm of this machine, and proves the layout the bot driver sets up:
//
//   - a store beside the clones (the default, /workspace/.pnpm-store): hard links;
//   - a store on another mount (what a separate /cache/pnpm bind is): copies.
//
// The second proof needs two filesystems; it is skipped where /dev/shm and the
// temporary directory are one device.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CHECK = path.join(ROOT, "docker/bot-runtime/pnpm-hardlink-check.sh");
const TEMPLATE = fs.readFileSync(path.join(ROOT, "server/src/myrmidon/bot-containers/template.ts"), "utf8");

const hasPnpm = spawnSync("pnpm", ["--version"], { encoding: "utf8" }).status === 0;

function runCheck(extraEnv = {}) {
  const r = spawnSync("sh", [CHECK], {
    env: { PATH: process.env.PATH, TMPDIR: os.tmpdir(), CI: "", ...extraEnv },
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const m = /nlink=(\d+) samefile=(yes|no)/.exec(r.stdout);
  assert.ok(m, `unexpected output: ${r.stdout}`);
  return { nlink: Number(m[1]), samefile: m[2] === "yes" };
}

describe("pnpm hard links", () => {
  it("the check script is valid shell", () => {
    assert.equal(spawnSync("sh", ["-n", CHECK]).status, 0);
  });

  it("a store beside the project is hard-linked, not copied", { skip: !hasPnpm }, () => {
    const result = runCheck();
    assert.ok(result.nlink >= 2, `expected a hard link, got link count ${result.nlink}`);
    assert.equal(result.samefile, true);
  });

  const shm = "/dev/shm";
  const crossDevice =
    fs.existsSync(shm) && fs.statSync(shm).dev !== fs.statSync(os.tmpdir()).dev && (() => {
      try {
        fs.accessSync(shm, fs.constants.W_OK);
        return true;
      } catch {
        return false;
      }
    })();

  it("a store on another mount is copied (why the default store sits on the workspace mount)", { skip: !hasPnpm || !crossDevice }, () => {
    const store = fs.mkdtempSync(path.join(shm, "pnpm-store-"));
    try {
      const result = runCheck({ STORE_DIR: store });
      assert.equal(result.nlink, 1, "a link cannot cross a mount: pnpm must have copied");
      assert.equal(result.samefile, false);
    } finally {
      fs.rmSync(store, { recursive: true, force: true });
    }
  });

  it("the bot driver keeps the store on the workspace mount by default", () => {
    assert.match(TEMPLATE, /WORKSPACE_PNPM_STORE_DIR = "\/workspace\/\.pnpm-store"/);
    assert.match(TEMPLATE, /packageCacheEnv\(pnpmStore: "workspace" \| "shared" = "workspace"\)/);
    const dockerfile = fs.readFileSync(path.join(ROOT, "docker/bot-runtime/Dockerfile"), "utf8");
    assert.match(dockerfile, /npm_config_store_dir=\/workspace\/\.pnpm-store/);
    assert.match(dockerfile, /pnpm-hardlink-check\.sh/);
  });
});
