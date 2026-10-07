import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// myrmidon(BOT-DISK-H8b): pnpm reflink-imports node_modules from its store only
// when the project and the store share one copy-on-write filesystem (one
// superblock). This runs the same script the dev image's build runs
// (docker/bot-runtime/pnpm-reflink-check.sh) with the pnpm of this machine, and
// proves the layout the bot driver sets up:
//
//   - a store inside the bot's single mount and clones under ALL THREE clone
//     roots (/data/hermes, /workspace, /scratch — here three directories of one
//     tree): a reflink from every root (shared=yes);
//   - a store on another superblock (what a separate /cache/pnpm bind was):
//     `cp --reflink=always` (FICLONE) is refused with EXDEV/EOPNOTSUPP and pnpm
//     still COPIES — the negative test below. pnpm never reports it; the image
//     build check and the container's start-time self-check exist because of it.
//
// A real reflink is proven by filefrag(1): the installed file and its store
// entry share at least one physical extent. Where filefrag cannot answer the
// check prints shared=unknown and the caller decides.
//
// The negative proof needs a second filesystem; it is skipped with its reason
// where /dev/shm and the temporary directory are one device — never silently
// green.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CHECK = path.join(ROOT, "docker/bot-runtime/pnpm-reflink-check.sh");
const TEMPLATE = fs.readFileSync(path.join(ROOT, "server/src/myrmidon/bot-containers/template.ts"), "utf8");

const hasPnpm = spawnSync("pnpm", ["--version"], { encoding: "utf8" }).status === 0;
const hasFilefrag = spawnSync("sh", ["-c", "command -v filefrag"], { encoding: "utf8" }).status === 0;

function runCheck(extraEnv = {}) {
  const r = spawnSync("sh", [CHECK], {
    env: { PATH: process.env.PATH, TMPDIR: os.tmpdir(), CI: "", ...extraEnv },
    encoding: "utf8",
    timeout: 90_000,
  });
  const lines = r.stdout.trim().split("\n").filter(Boolean).map((line) => {
    const m = /^root=(\S+) (?:shared=(yes|no|unknown) samefile=(yes|no)|(install-failed))$/.exec(line);
    assert.ok(m, `unexpected output line: ${line}`);
    return m[4]
      ? { root: m[1], failed: true }
      : { root: m[1], failed: false, shared: m[2], samefile: m[3] === "yes" };
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

describe("pnpm reflinks", () => {
  it("the check script is valid shell", () => {
    assert.equal(spawnSync("sh", ["-n", CHECK]).status, 0);
  });

  it("reflinks from all three clone roots into a store inside the same mount", { skip: !hasPnpm || !hasFilefrag }, (t) => {
    const { tree, roots, store } = botTree();
    try {
      const result = runCheck({ ROOTS: roots.join(" "), STORE_DIR: store });
      assert.equal(result.status, 0, result.raw);
      assert.equal(result.lines.length, 3, result.raw);
      assert.deepEqual(result.lines.map((line) => line.root), roots);
      for (const line of result.lines) {
        assert.equal(line.failed, false, result.raw);
        if (line.shared === "no" && !line.samefile) {
          // This filesystem has no reflinks (ext4): pnpm copied. Not a failure
          // of the test environment, but not the fleet layout either — report
          // it as skipped-with-reason rather than green.
          t.skip("this filesystem refused FICLONE (no reflink support): pnpm copied, so the positive proof cannot run here");
          return;
        }
        assert.equal(line.shared, "yes", `${line.root}: expected a reflink (shared extents), got shared=${line.shared}`);
      }
    } finally {
      fs.rmSync(tree, { recursive: true, force: true });
    }
  });

  it("a single default root still works (store beside the project)", { skip: !hasPnpm }, () => {
    const result = runCheck();
    assert.equal(result.status, 0, result.raw);
    assert.equal(result.lines.length, 1);
    assert.notEqual(result.lines[0].failed, true);
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

  it("negative: a store on another superblock is a silent copy that only this check can see", { skip: !hasPnpm || !crossDevice }, (t) => {
    if (!crossDevice) {
      t.skip("one filesystem on this runner: no second superblock to provoke EXDEV");
      return;
    }
    const { tree, roots } = botTree();
    const store = fs.mkdtempSync(path.join(shm, "pnpm-store-"));
    try {
      const result = runCheck({ ROOTS: roots[1], STORE_DIR: store });
      assert.equal(result.status, 0, result.raw);
      assert.equal(result.lines.length, 1);
      assert.equal(result.lines[0].failed, false, result.raw);
      assert.equal(result.lines[0].samefile, false);
      assert.notEqual(result.lines[0].shared, "yes", "a reflink cannot cross a superblock: pnpm must have copied");
    } finally {
      fs.rmSync(tree, { recursive: true, force: true });
      fs.rmSync(store, { recursive: true, force: true });
    }
  });

  it("the bot driver keeps the store inside the single mount and forces reflink", () => {
    assert.match(TEMPLATE, /DEFAULT_PNPM_STORE_DIR = "\/cache\/pnpm-store"/);
    assert.match(TEMPLATE, /DEFAULT_PNPM_IMPORT_METHOD = "clone"/);
    const dockerfile = fs.readFileSync(path.join(ROOT, "docker/bot-runtime/Dockerfile"), "utf8");
    assert.match(dockerfile, /npm_config_store_dir=\/workspace\/\.pnpm-store/);
    assert.match(dockerfile, /npm_config_package_import_method=reflink/);
    assert.match(dockerfile, /ROOTS="\/data\/hermes \/workspace \/scratch"/);
    assert.match(dockerfile, /pnpm-reflink-check\.sh/);
  });
});
