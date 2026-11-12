import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// myrmidon(BOT-DISK-H8a/OPE-12490): the entrypoint's resolve_pnpm_store() must
// pick a store that a real pnpm can write to. The image ENV defaults
// npm_config_store_dir to /cache/pnpm-store (the shared mount). When that
// mount is absent (a bot without the shared cache role) or read-only, the
// resolver must fall back to /workspace/.pnpm-store inside the /bot mount.
// These tests extract the function from entrypoint.sh and run it against
// controlled directories — no Docker needed.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ENTRYPOINT = path.join(ROOT, "docker/bot-runtime/entrypoint.sh");

/** Extract resolve_pnpm_store and its helpers from entrypoint.sh, with a stub log(). */
function resolveScript(storeEnv) {
  const stub = `
log() { :; }
dotenv_value() { return 0; }
`;
  // Pull the function body from the real script so the test always exercises
  // production code, not a copy.
  const src = fs.readFileSync(ENTRYPOINT, "utf8");
  const m = /resolve_pnpm_store\(\) \{[\s\S]*?\n\}/.exec(src);
  assert.ok(m, "resolve_pnpm_store not found in entrypoint.sh");
  return `${stub}\n${m[0]}\nresolve_pnpm_store`;
}

function runResolve({ storeEnv, sharedStore, fallbackStore } = {}) {
  const script = resolveScript(storeEnv);
  const env = { ...process.env };
  if (storeEnv) env.npm_config_store_dir = storeEnv;
  else delete env.npm_config_store_dir;
  if (sharedStore) env.MYRMIDON_PNPM_SHARED_STORE = sharedStore;
  else delete env.MYRMIDON_PNPM_SHARED_STORE;
  if (fallbackStore) env.MYRMIDON_PNPM_FALLBACK_STORE = fallbackStore;
  else delete env.MYRMIDON_PNPM_FALLBACK_STORE;
  const r = spawnSync("bash", ["-c", script], { env, encoding: "utf8" });
  assert.equal(r.status, 0, `resolve failed: ${r.stderr}`);
  return r.stdout.trim();
}

describe("entrypoint resolve_pnpm_store", () => {
  it("entrypoint.sh is valid bash", () => {
    assert.equal(spawnSync("bash", ["-n", ENTRYPOINT]).status, 0);
  });

  it("uses the shared store when the mount is present and writable", () => {
    const shared = fs.mkdtempSync(path.join(os.tmpdir(), "shared-store-"));
    try {
      const got = runResolve({ storeEnv: shared });
      assert.equal(got, shared);
    } finally {
      fs.rmSync(shared, { recursive: true, force: true });
    }
  });

  it("falls back to the per-bot store when the shared mount is absent", () => {
    // /proc is read-only: mkdir always fails there, simulating the absent
    // shared mount on the bot image's read-only rootfs.
    const absent = path.join("/proc", "definitely-absent-pnpm-store");
    const fallback = path.join(os.tmpdir(), "fallback-store-");
    fs.mkdirSync(fallback, { recursive: true });
    try {
      // sharedStore is also forced absent so the chain reaches the fallback.
      const got = runResolve({ storeEnv: absent, sharedStore: absent, fallbackStore: fallback });
      assert.equal(got, fallback);
    } finally {
      fs.rmSync(fallback, { recursive: true, force: true });
    }
  });

  it("falls back when the store path exists but is read-only", () => {
    const ro = fs.mkdtempSync(path.join(os.tmpdir(), "ro-store-"));
    const fallback = path.join(os.tmpdir(), "fallback-store-");
    fs.mkdirSync(fallback, { recursive: true });
    try {
      fs.chmodSync(ro, 0o555);
      const absent = path.join("/proc", "definitely-absent-pnpm-store");
      const got = runResolve({ storeEnv: ro, sharedStore: absent, fallbackStore: fallback });
      assert.equal(got, fallback);
    } finally {
      fs.chmodSync(ro, 0o755);
      fs.rmSync(ro, { recursive: true, force: true });
      fs.rmSync(fallback, { recursive: true, force: true });
    }
  });

  it("falls back when npm_config_store_dir is unset and the shared mount is absent", () => {
    // No ENV, no .env: the resolver tries the shared store (forced absent via
    // /proc) and lands on the fallback.
    const shared = path.join("/proc", "definitely-absent-pnpm-store");
    const fallback = path.join(os.tmpdir(), "fallback-store-");
    fs.mkdirSync(fallback, { recursive: true });
    try {
      const got = runResolve({ sharedStore: shared, fallbackStore: fallback });
      assert.equal(got, fallback);
    } finally {
      fs.rmSync(fallback, { recursive: true, force: true });
    }
  });

  it("the image ENV default is the shared store, the fallback is the per-bot store", () => {
    const src = fs.readFileSync(ENTRYPOINT, "utf8");
    assert.match(src, /MYRMIDON_PNPM_SHARED_STORE:-\/cache\/pnpm-store/);
    assert.match(src, /MYRMIDON_PNPM_FALLBACK_STORE:-\/workspace\/\.pnpm-store/);
  });
});
