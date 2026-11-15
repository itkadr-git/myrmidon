import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// myrmidon(OPE-13112): the image bakes npm_config_store_dir=/workspace/.pnpm-store,
// the board's profile writes /cache/pnpm-store only into ${HERMES_HOME}/.env. The
// pnpm wrapper must let the profile value win when the directory is writable, and
// keep the environment's (image) value otherwise.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const WRAPPER = path.join(ROOT, "docker/bot-runtime/build-wrappers/pnpm");
const IMAGE_DEFAULT = "/workspace/.pnpm-store";

describe("pnpm wrapper: the profile's store wins over the image default", () => {
  let sandbox;
  let wrapperCopy;
  let home;

  before(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "pnpm-store-test-"));
    const stub = path.join(sandbox, "fake-pnpm.js");
    fs.writeFileSync(
      stub,
      '#!/usr/bin/env node\nprocess.stdout.write(process.env.npm_config_store_dir || "");\n',
      "utf8",
    );
    fs.chmodSync(stub, 0o755);
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
    home = path.join(sandbox, "hermes");
    fs.mkdirSync(home);
  });

  after(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  function storeSeenByPnpm(envFile) {
    const file = path.join(home, ".env");
    if (envFile === null) {
      fs.rmSync(file, { force: true });
    } else {
      fs.writeFileSync(file, envFile, "utf8");
    }
    const r = spawnSync(process.execPath, [wrapperCopy, "--version"], {
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, HERMES_HOME: home, npm_config_store_dir: IMAGE_DEFAULT },
    });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  }

  it("a writable profile store is chosen", () => {
    const store = path.join(sandbox, "cache", "pnpm-store");
    fs.mkdirSync(store, { recursive: true });
    assert.equal(storeSeenByPnpm(`API_SERVER_KEY="x"\nnpm_config_store_dir="${store}"\n`), store);
  });

  it("a profile store that does not exist yet but can be created is chosen", () => {
    const store = path.join(sandbox, "cache", "new-store");
    assert.equal(storeSeenByPnpm(`npm_config_store_dir=${store}\n`), store);
  });

  it("a profile store that is not writable keeps the image default", () => {
    const blocker = path.join(sandbox, "a-file");
    fs.writeFileSync(blocker, "x");
    assert.equal(storeSeenByPnpm(`npm_config_store_dir="${path.join(blocker, "store")}"\n`), IMAGE_DEFAULT);
    if (process.getuid && process.getuid() !== 0) {
      const ro = path.join(sandbox, "ro");
      fs.mkdirSync(ro);
      fs.chmodSync(ro, 0o500);
      try {
        assert.equal(storeSeenByPnpm(`npm_config_store_dir="${ro}"\n`), IMAGE_DEFAULT);
      } finally {
        fs.chmodSync(ro, 0o700);
      }
    }
  });

  it("a relative profile value keeps the image default", () => {
    assert.equal(storeSeenByPnpm("npm_config_store_dir=cache/store\n"), IMAGE_DEFAULT);
  });

  it("a profile without the key, or an empty one, keeps the image default", () => {
    assert.equal(storeSeenByPnpm("API_SERVER_KEY=\"x\"\n"), IMAGE_DEFAULT);
    assert.equal(storeSeenByPnpm('npm_config_store_dir=""\n'), IMAGE_DEFAULT);
    assert.equal(storeSeenByPnpm(null), IMAGE_DEFAULT);
  });
});
