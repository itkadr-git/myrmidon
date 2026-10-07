import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

// OPE-4472 gate: every collectable server test file must run in exactly one CI
// lane. run-vitest-stable.mjs excluded any *route*/*routes*/*authz*.test.ts
// from general-server but built the serialized lane only from
// server/src/__tests__, so 23 route-named suites outside __tests__ ran in no
// lane at all. This file lives under scripts/myrmidon (node:test tier runs on
// every CI level, before pnpm install) and needs nothing but node stdlib.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const script = path.join(ROOT, "scripts", "run-vitest-stable.mjs");

function runJson(args) {
  const result = spawnSync(process.execPath, [script, ...args, "--dry-run"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `expected success for ${args.join(" ")}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

function collectServerTestFiles() {
  const files = [];
  const walker = (dir, ext) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walker(full, ext);
      else if (entry.name.endsWith(ext)) {
        files.push(path.relative(ROOT, full).split(path.sep).join("/"));
      }
    }
  };
  // Must match the `include` of server/vitest.config.ts: src/**/*.test.ts and
  // scripts/**/*.test.mjs.
  walker(path.join(ROOT, "server", "src"), ".test.ts");
  walker(path.join(ROOT, "server", "scripts"), ".test.mjs");
  return files.sort((a, b) => a.localeCompare(b));
}

describe("server test lane coverage (OPE-4472)", () => {
  it("--check exits 0 and reports an exact partition", () => {
    const result = spawnSync(process.execPath, [script, "--check"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `--check must pass on a clean tree: ${result.stderr}`);
    assert.match(result.stdout, /partition is exact/);
  });

  it("every server test file lands in exactly one lane, including route/authz suites outside __tests__", () => {
    const serialized = new Set(
      runJson(["--mode", "serialized", "--shard-index", "0", "--shard-count", "1"]).selectedSerializedSuites,
    );
    const general = new Set(
      runJson(["--mode", "general", "--group", "general-server", "--shard-index", "0", "--shard-count", "1"]).selectedGeneralServerSuites,
    );
    const collected = collectServerTestFiles();
    assert.ok(collected.length > 0);

    for (const file of collected) {
      const inSerialized = serialized.has(file);
      const inGeneral = general.has(file);
      assert.ok(
        inSerialized !== inGeneral,
        `expected exactly one lane for ${file} (serialized=${inSerialized} general=${inGeneral})`,
      );
    }

    // Spot-check the OPE-4472 files: route-named suites outside __tests__ must
    // be in the serialized lane. openrouter-models.test.ts matches the
    // existing basename pattern ("router" contains "route") — a service suite,
    // but the pattern is deliberately kept identical to the general-server
    // exclusion so the two selectors cannot disagree; serialized execution is
    // correctness-safe for it (first measured run: green).
    for (const file of [
      "server/src/myrmidon/access-hub/routes.myrmidon.test.ts",
      "server/src/myrmidon/foraging/routes.myrmidon.test.ts",
      "server/src/routes/setup-token-route.test.ts",
      "server/src/services/openrouter-models.test.ts",
    ]) {
      assert.ok(serialized.has(file), `${file} must run in the serialized lane`);
    }

    assert.equal(serialized.size + general.size, collected.length);
  });
});
