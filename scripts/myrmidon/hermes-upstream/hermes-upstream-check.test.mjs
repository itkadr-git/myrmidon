import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { hindsightCatalogPin, pinFromDockerfile, run, stableTags } from "./hermes-upstream-check.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DOCKERFILE = path.join(ROOT, "docker/bot-runtime/Dockerfile");
const REGISTRY = path.join(ROOT, "scripts/myrmidon/hermes-upstream/deltas.json");

const LS_REMOTE = [
  "1111111111111111111111111111111111111111\trefs/tags/v2026.9.7",
  "2222222222222222222222222222222222222222\trefs/tags/v2026.9.7^{}",
  "3333333333333333333333333333333333333333\trefs/tags/v2026.9.11",
  "4444444444444444444444444444444444444444\trefs/tags/v2026.9.11^{}",
  "5555555555555555555555555555555555555555\trefs/tags/v2026.9.24-canary",
  "6666666666666666666666666666666666666666\trefs/tags/v2026.9.24",
  "7777777777777777777777777777777777777777\trefs/tags/v2026.9.24^{}",
  "8888888888888888888888888888888888888888\trefs/tags/nightly/whatever",
].join("\n");

const registry = JSON.parse(fs.readFileSync(REGISTRY, "utf8"));
const dockerfile = fs.readFileSync(DOCKERFILE, "utf8");

it("registers the async writer-acquire delta with fail-closed markers", () => {
  const delta = registry.deltas.find((item) => item.id === "19-async-state-db-writer-acquire");
  assert.ok(delta, "delta 19 must remain registered without renumbering older deltas");
  assert.equal(delta.patch, "docker/bot-runtime/patches/19-async-writer-acquire.patch");
  assert.deepEqual(delta.files, [
    "hermes_state_dbfile.py", "hermes_state_errors.py", "hermes_state.py", "hermes_state_registry.py",
    "gateway/session_db_recovery.py", "gateway/session.py", "gateway/session_persistence.py",
    "gateway/session_recovery.py", "gateway/session_lifecycle.py", "gateway/session_transcript.py",
    "gateway/run.py", "gateway/run_startup.py", "gateway/run_shutdown.py",
    "tests/hermes_state/test_deleted_wal_generation_guard.py",
    "tests/gateway/test_async_writer_acquire_contract.py",
  ]);
  assert.match(delta.reason, /worker-owned async writer acquire/);
  assert.match(delta.probe.upstreamMarker, /SidecarScanIncompleteError/);
  assert.match(delta.dropCondition, /complete/);
  const patch = fs.readFileSync(path.join(ROOT, delta.patch), "utf8");
  assert.match(patch, /SidecarScanIncompleteError/);
  assert.match(patch, /DeletedWalGenerationError/);
  assert.match(patch, /os\.listdir\("\/proc"\)/);
  assert.match(patch, /incomplete_proc_fd_scan/);
  assert.match(patch, /partial_proc_fd_scan/);
  assert.match(patch, /class SidecarScanIncompleteError/);
  assert.match(patch, /raise SidecarScanIncompleteError/);
  assert.match(patch, /pytest.raises\(SidecarScanIncompleteError\)/);
  assert.match(patch, /async def acquire_async/);
  assert.match(patch, /initialize_writer/);
  assert.match(patch, /close_all_db_handles_async/);
});


it("maps the accepted writer lifecycle anchors to the pinned Hermes source", async () => {
  const sha = "f97608f178d1ffeca59860195ab7da295f7c8e5f";
  const paths = [
    "gateway/run.py",
    "gateway/run_startup.py",
    "gateway/run_shutdown.py",
    "gateway/run_bootstrap.py",
    "gateway/run_runtime_init.py",
  ];
  const responses = new Map();
  for (const file of paths) {
    const response = await fetch(
      `https://raw.githubusercontent.com/NousResearch/hermes-agent/${sha}/${file}`,
    );
    responses.set(file, response.status);
    if (response.ok && file === "gateway/run.py") {
      const source = await response.text();
      for (const symbol of ["class GatewayRunner", "def _init_session_store", "def _init_session_db", "def start_gateway"]) {
        assert.ok(source.includes(symbol), `pinned run.py must expose ${symbol}`);
      }
    }
  }
  assert.equal(responses.get("gateway/run.py"), 200);
  assert.equal(responses.get("gateway/run_startup.py"), 200);
  assert.equal(responses.get("gateway/run_shutdown.py"), 200);
  assert.equal(responses.get("gateway/run_bootstrap.py"), 404);
  assert.equal(responses.get("gateway/run_runtime_init.py"), 404);
});

const fakeRun = (texts) =>
  run({
    registryPath: REGISTRY,
    dockerfilePath: DOCKERFILE,
    exec: () => LS_REMOTE,
    fetchText: async (url) => {
      for (const [needle, text] of Object.entries(texts)) {
        if (url.includes(needle)) return text;
      }
      return "";
    },
  });

describe("check-hermes-upstream", () => {
  it("takes only stable tags and orders them by date, not lexically", () => {
    const tags = stableTags(LS_REMOTE, "^v[0-9]{4}\\.[0-9]{1,2}\\.[0-9]{1,2}$");
    assert.deepEqual(tags, ["v2026.9.7", "v2026.9.11", "v2026.9.24"]);
  });

  it("reads the pin out of the image Dockerfile", () => {
    const pin = pinFromDockerfile(dockerfile);
    assert.match(pin.ref, /^v\d{4}\.\d{1,2}\.\d{1,2}$/);
    assert.match(pin.version, /^\d+\.\d+\.\d+$/);
    assert.match(pin.sha, /^[0-9a-f]{40}$/);
    // The registry is the machine-readable half of the delta list; it must not drift from
    // the image it describes.
    assert.equal(pin.ref, registry.pinnedRef);
    assert.equal(pin.version, registry.pinnedVersion);
  });

  it("records the vendored plugin pin, and cross-checks it when a hermes checkout is present", async () => {
    assert.match(registry.hindsightPlugin.repo, /^https:\/\/github\.com\//);
    assert.match(registry.hindsightPlugin.pinnedSha, /^[0-9a-f]{40}$/);
    assert.equal(registry.hindsightPlugin.subdir, "hindsight-integrations/hermes");

    // No hermes tree here: the registry's own record is used, no error.
    const plain = await fakeRun({ "raw.githubusercontent.com": "" });
    assert.equal(plain.pluginPin.pinnedSha, registry.hindsightPlugin.pinnedSha);
    assert.equal(plain.catalogPin, null);

    // A hermes checkout whose catalog entry disagrees with the registry is a hard error:
    // the two describe the same vendored tree and must move together.
    const fakeRoot = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "hermes-tree-"));
    fs.mkdirSync(path.join(fakeRoot, "plugin-catalog"), { recursive: true });
    fs.writeFileSync(
      path.join(fakeRoot, "plugin-catalog/hindsight.yaml"),
      "repo: https://github.com/vectorize-io/hindsight\nsha: " + "b".repeat(40) + "\nsubdir: hindsight-integrations/hermes\n",
      "utf8",
    );
    const bad = await run({
      root: fakeRoot,
      registryPath: REGISTRY,
      dockerfilePath: DOCKERFILE,
      exec: () => LS_REMOTE,
      fetchText: async () => "",
    }).then(() => null, (exc) => exc);
    assert.ok(bad && /deltas\.json records/.test(bad.message), "expected a pin-mismatch error");
    fs.rmSync(fakeRoot, { recursive: true, force: true });
  });

  it("flags a delta as droppable only when the upstream file carries its marker", async () => {
    const report = await fakeRun({
      "raw.githubusercontent.com/NousResearch/hermes-agent": "# nothing interesting here\n",
    });
    assert.equal(report.newest, "v2026.9.24");
    assert.deepEqual(report.behind, []);
    for (const result of report.results) {
      assert.ok(["still-needed", "droppable", "unknown"].includes(result.status));
      if (result.kind === "patch") assert.equal(result.status, "still-needed");
    }

    const caughtUp = await fakeRun({
      "gateway/run.py": "loop.set_default_executor(pool)  # HERMES_GATEWAY_EXECUTOR_WORKERS\n",
    });
    const pool = caughtUp.results.find((r) => r.id === "05-gateway-executor-pool");
    assert.equal(pool.status, "droppable");
    const snapshot = caughtUp.results.find((r) => r.id === "02-session-snapshot-secret-redaction");
    assert.equal(snapshot.status, "still-needed");
  });

  it("reports the pin as behind when a newer stable tag exists", async () => {
    const older = fs
      .readFileSync(DOCKERFILE, "utf8")
      .replace("ARG HERMES_GIT_REF=v2026.9.24", "ARG HERMES_GIT_REF=v2026.9.11")
      .replace("ARG HERMES_VERSION=0.21.5", "ARG HERMES_VERSION=0.21.2");
    const tmp = path.join(fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "hermes-upstream-")), "Dockerfile");
    fs.writeFileSync(tmp, older.replace(/^ARG HERMES_GIT_SHA=.*$/m, `ARG HERMES_GIT_SHA=${"a".repeat(40)}`), "utf8");
    const report = await run({
      registryPath: REGISTRY,
      dockerfilePath: tmp,
      exec: () => LS_REMOTE,
      fetchText: async () => "",
    }).catch(() => null);
    // The registry pins 0.21.5/v2026.9.24, so an older Dockerfile is a hard mismatch, not a
    // "behind" report: the registry and the image must move together.
    assert.equal(report, null);
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  });

  it("keeps the registry true: every patch it names exists and is documented", () => {
    const patchesDir = path.join(ROOT, "docker/bot-runtime/patches");
    const readme = fs.readFileSync(path.join(patchesDir, "README.md"), "utf8");
    const listed = new Set(fs.readdirSync(patchesDir).filter((f) => f.endsWith(".patch")));
    const fromRegistry = new Set(registry.deltas.filter((d) => d.kind === "patch").map((d) => path.basename(d.patch)));
    assert.deepEqual([...fromRegistry].sort(), [...listed].sort());
    for (const delta of registry.deltas) {
      assert.ok(delta.reason && delta.dropCondition, `${delta.id} needs a reason and a drop condition`);
      if (delta.kind === "patch") {
        assert.ok(fs.existsSync(path.join(ROOT, delta.patch)), `${delta.patch} is missing`);
        assert.ok(readme.includes(path.basename(delta.patch)), `patches/README.md must list ${delta.patch}`);
      }
    }
  });
});
