import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// myrmidon(1.6.8 BOT-PNPM-STORE-FS): existing clones carry a .modules.yaml
// that points at the OLD storeDir; pnpm 10 asks for a TTY confirmation before
// purging node_modules (ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY) and the
// agents run installs without a TTY. confirmModulesPurge is read ONLY from
// the command line (env and .npmrc do not work), so the pnpm wrapper in the
// bot image must inject --config.confirm-modules-purge=false for install/add.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const WRAPPER = path.join(ROOT, "docker/bot-runtime/build-wrappers/pnpm");

describe("docker/bot-runtime/build-wrappers/pnpm purge-flag injection", () => {
  it("injects --config.confirm-modules-purge=false for install and add", () => {
    const source = fs.readFileSync(WRAPPER, "utf8");
    assert.match(source, /install/);
    assert.match(source, /add/);
    assert.match(source, /--config\.confirm-modules-purge=false/);
    // The flag must be added for install/add only, not for every subcommand:
    // version/config/store probes and unrelated lanes stay untouched.
    assert.match(source, /PURGE_SUBCOMMANDS\s*=\s*new Set\(\["install", "add"\]\)/);
  });

  it("does not touch light subcommands (version, config, store probes)", () => {
    const source = fs.readFileSync(WRAPPER, "utf8");
    assert.match(source, /const LIGHT = new Set\(\[/);
    assert.match(source, /"config"/);
    assert.match(source, /STORE_LIGHT/);
  });
});

// Behavioural proof: run the wrapper in a sandbox where the real pnpm is a
// stub that records its argv. The wrapper execs REAL_PNPM by absolute path,
// so the sandbox copy rewrites that constant to the stub. Heavy lanes
// (install/add) are refused by the devbuild gate without the gateway file,
// which is itself the proof that the purge flag reached the refusal path;
// light lanes (version/config/store) run the stub and their recorded argv
// must stay unflagged.
describe("docker/bot-runtime/build-wrappers/pnpm behaviour", () => {
  let sandbox;
  let stubLog;
  let wrapperCopy;

  before(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "pnpm-wrapper-test-"));
    stubLog = path.join(sandbox, "pnpm-argv.json");
    const stub = path.join(sandbox, "fake-pnpm.js");
    fs.writeFileSync(
      stub,
      [
        "#!/usr/bin/env node",
        '"use strict";',
        `require("node:fs").writeFileSync(${JSON.stringify(stubLog)}, JSON.stringify(process.argv.slice(2)));`,
        'process.stdout.write("fake pnpm ok\\n");',
      ].join("\n"),
      "utf8",
    );
    fs.chmodSync(stub, 0o755);

    // The wrapper requires ./devbuild-gate.js and ./heavy-fallback.js next to
    // itself; the sandbox needs those bytes too.
    for (const f of ["devbuild-gate.js", "heavy-fallback.js"]) {
      fs.copyFileSync(path.join(ROOT, "docker/bot-runtime/build-wrappers", f), path.join(sandbox, f));
    }

    wrapperCopy = path.join(sandbox, "pnpm-wrapper.cjs");
    const source = fs.readFileSync(WRAPPER, "utf8");
    const patched = source.replace(
      /const REAL_PNPM = "\/opt\/pnpm\/bin\/pnpm";/,
      `const REAL_PNPM = ${JSON.stringify(stub)};`,
    );
    assert.notEqual(patched, source, "could not rewrite REAL_PNPM in the sandbox copy");
    fs.writeFileSync(wrapperCopy, patched, "utf8");
  });

  after(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  function runWrapper(args) {
    return spawnSync(process.execPath, [wrapperCopy, ...args], {
      encoding: "utf8",
      timeout: 10_000,
    });
  }

  it("install refusal carries --config.confirm-modules-purge=false exactly once", () => {
    const r = runWrapper(["install"]);
    assert.equal(r.status, 1, "heavy lane without the devbuild gateway must refuse");
    assert.match(r.stderr, /Refused: pnpm --config\.confirm-modules-purge=false install/);
  });

  it("add refusal carries --config.confirm-modules-purge=false exactly once", () => {
    const r = runWrapper(["add", "lodash"]);
    assert.equal(r.status, 1, "heavy lane without the devbuild gateway must refuse");
    assert.match(r.stderr, /Refused: pnpm --config\.confirm-modules-purge=false add lodash/);
  });

  it("install with the flag already present is not duplicated in the refusal", () => {
    const r = runWrapper(["install", "--config.confirm-modules-purge=false"]);
    assert.equal(r.status, 1, "heavy lane without the devbuild gateway must refuse");
    const refused = r.stderr.split("\n").find((l) => l.startsWith("Refused:")) || "";
    const matches = refused.match(/--config\.confirm-modules-purge=false/g) || [];
    assert.equal(matches.length, 1, r.stderr);
  });

  it("--version is not flagged", () => {
    const r = runWrapper(["--version"]);
    assert.equal(r.status, 0, r.stderr);
    const argv = JSON.parse(fs.readFileSync(stubLog, "utf8"));
    assert.ok(!argv.includes("--config.confirm-modules-purge=false"), JSON.stringify(argv));
  });

  it("config get is not flagged", () => {
    const r = runWrapper(["config", "get", "store-dir"]);
    assert.equal(r.status, 0, r.stderr);
    const argv = JSON.parse(fs.readFileSync(stubLog, "utf8"));
    assert.ok(!argv.includes("--config.confirm-modules-purge=false"), JSON.stringify(argv));
  });

  it("store status is not flagged", () => {
    const r = runWrapper(["store", "status"]);
    assert.equal(r.status, 0, r.stderr);
    const argv = JSON.parse(fs.readFileSync(stubLog, "utf8"));
    assert.ok(!argv.includes("--config.confirm-modules-purge=false"), JSON.stringify(argv));
  });
});
