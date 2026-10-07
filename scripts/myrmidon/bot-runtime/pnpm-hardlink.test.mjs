import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// myrmidon(BOT-DISK-D): pnpm hard-links node_modules into its store only when the
// project and the store share a mount. This runs the same script the dev image's
// build runs (docker/bot-runtime/pnpm-hardlink-check.sh) with the pnpm of this
// machine, and proves the layout the bot driver sets up:
//
//   - a store inside the bot's single mount and clones under ALL THREE clone
//     roots (/data/hermes, /workspace, /scratch — here three directories of one
//     tree): hard links from every root;
//   - a store on another mount (what a separate /cache/pnpm bind was): pnpm 9 still
//     COPIES there even with package-import-method=hardlink (it falls back on EXDEV),
//     which is why the image's build check and the container's start-time
//     self-check exist: pnpm itself never reports it.
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
    timeout: 240_000,
  });
  const lines = r.stdout.trim().split("\n").filter(Boolean).map((line) => {
    const m = /^root=(\S+) (?:nlink=(\d+) samefile=(yes|no)|(install-failed))$/.exec(line);
    assert.ok(m, `unexpected output line: ${line}`);
    return m[4]
      ? { root: m[1], failed: true }
      : { root: m[1], failed: false, nlink: Number(m[2]), samefile: m[3] === "yes" };
  });
  return { status: r.status, lines, raw: `${r.stdout}\n${r.stderr}` };
}

/** A bot tree like the container's: one directory holding the three clone roots and the store. */
function botTree() {
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), "bot-tree-"));
  const roots = ["hermes", "workspace", "scratch"].map((name) => {
    const dir = path.join(tree, name);
    fs.mkdirSync(dir);
    return dir;
  });
  return { tree, roots, store: path.join(tree, "workspace", ".pnpm-store") };
}

describe("pnpm hard links", () => {
  it("the check script is valid shell", () => {
    assert.equal(spawnSync("sh", ["-n", CHECK]).status, 0);
  });

  it("hard-links from all three clone roots into a store inside the same mount", { skip: !hasPnpm }, () => {
    const { tree, roots, store } = botTree();
    try {
      const result = runCheck({ ROOTS: roots.join(" "), STORE_DIR: store });
      assert.equal(result.status, 0, result.raw);
      assert.equal(result.lines.length, 3, result.raw);
      assert.deepEqual(result.lines.map((line) => line.root), roots);
      for (const line of result.lines) {
        assert.equal(line.failed, false, result.raw);
        assert.ok(line.nlink >= 2, `${line.root}: expected a hard link, got link count ${line.nlink}`);
        assert.equal(line.samefile, true, `${line.root} is not linked to the store`);
      }
    } finally {
      fs.rmSync(tree, { recursive: true, force: true });
    }
  });

  it("a single default root still works (store beside the project)", { skip: !hasPnpm }, () => {
    const result = runCheck();
    assert.equal(result.status, 0, result.raw);
    assert.equal(result.lines.length, 1);
    assert.equal(result.lines[0].samefile, true);
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

  it("a store on another mount is a silent copy that only this check can see", { skip: !hasPnpm || !crossDevice }, () => {
    const { tree, roots } = botTree();
    const store = fs.mkdtempSync(path.join(shm, "pnpm-store-"));
    try {
      const result = runCheck({ ROOTS: roots[1], STORE_DIR: store });
      assert.equal(result.status, 0, result.raw);
      assert.equal(result.lines.length, 1);
      assert.equal(result.lines[0].failed, false, result.raw);
      assert.equal(result.lines[0].nlink, 1, "a link cannot cross a mount: pnpm must have copied");
      assert.equal(result.lines[0].samefile, false);
    } finally {
      fs.rmSync(tree, { recursive: true, force: true });
      fs.rmSync(store, { recursive: true, force: true });
    }
  });

  it("the bot driver keeps the store inside the single mount and forces hardlink", () => {
    assert.match(TEMPLATE, /DEFAULT_PNPM_STORE_DIR = "\/cache\/pnpm-store"/);
    assert.match(TEMPLATE, /DEFAULT_PNPM_IMPORT_METHOD = "clone"/);
    const dockerfile = fs.readFileSync(path.join(ROOT, "docker/bot-runtime/Dockerfile"), "utf8");
    assert.match(dockerfile, /npm_config_store_dir=\/workspace\/\.pnpm-store/);
    assert.match(dockerfile, /npm_config_package_import_method=reflink/);
    assert.match(dockerfile, /ROOTS="\/data\/hermes \/workspace \/scratch"/);
    assert.match(dockerfile, /pnpm-hardlink-check\.sh/);
  });
});
