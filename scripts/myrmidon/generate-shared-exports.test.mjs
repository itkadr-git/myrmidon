import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { generateBarrelContent } from "../generate-shared-exports.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const GENERATOR_SCRIPT = path.join(REPO_ROOT, "scripts/generate-shared-exports.mjs");

describe("generate-shared-exports generator behavior (OPE-9341)", () => {
  let fixtureDir;
  let sharedSrc;
  let myrmidonDir;
  let barrelPath;

  before(() => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "shared-exports-test-"));
    sharedSrc = path.join(fixtureDir, "packages/shared/src");
    myrmidonDir = path.join(sharedSrc, "myrmidon");
    barrelPath = path.join(myrmidonDir, "index.ts");

    fs.mkdirSync(myrmidonDir, { recursive: true });

    // Seed fixture with unordered modules, standalone contracts, test files, and non-ts files
    fs.writeFileSync(path.join(myrmidonDir, "zebra-contract.ts"), "export const ZEBRA = 1;\n");
    fs.writeFileSync(path.join(myrmidonDir, "alpha-contract.ts"), "export const ALPHA = 1;\n");
    fs.writeFileSync(path.join(myrmidonDir, "alpha-contract.test.ts"), "// test file should be ignored\n");
    fs.writeFileSync(path.join(myrmidonDir, "types.d.ts"), "// declaration file should be ignored\n");
    fs.writeFileSync(path.join(myrmidonDir, "README.md"), "# ignored doc\n");

    // myrmidon-* files in shared/src
    fs.writeFileSync(path.join(sharedSrc, "myrmidon-omega.ts"), "export const OMEGA = 1;\n");
    fs.writeFileSync(path.join(sharedSrc, "myrmidon-beta.ts"), "export const BETA = 1;\n");
    fs.writeFileSync(path.join(sharedSrc, "myrmidon-beta.test.ts"), "// ignored test\n");

    // standalone contract file
    fs.writeFileSync(path.join(sharedSrc, "blocker-graph.ts"), "export const BG = 1;\n");
  });

  after(() => {
    if (fixtureDir && fs.existsSync(fixtureDir)) {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it("discovers modules and excludes test and non-ts files", () => {
    const content = generateBarrelContent(fixtureDir);

    assert.ok(content.includes('export * from "./alpha-contract.js";'));
    assert.ok(content.includes('export * from "./zebra-contract.js";'));
    assert.ok(content.includes('export * from "../myrmidon-beta.js";'));
    assert.ok(content.includes('export * from "../myrmidon-omega.js";'));
    assert.ok(content.includes('export * from "../blocker-graph.js";'));

    // Excluded files
    assert.ok(!content.includes("alpha-contract.test"));
    assert.ok(!content.includes("types.d"));
    assert.ok(!content.includes("README"));
    assert.ok(!content.includes("myrmidon-beta.test"));
  });

  it("sorts exports alphabetically to ensure deterministic stability", () => {
    const content = generateBarrelContent(fixtureDir);
    const exportLines = content
      .split("\n")
      .filter((line) => line.startsWith("export * from"));

    const expectedOrder = [
      'export * from "../blocker-graph.js";',
      'export * from "../myrmidon-beta.js";',
      'export * from "../myrmidon-omega.js";',
      'export * from "./alpha-contract.js";',
      'export * from "./zebra-contract.js";',
    ];

    assert.deepEqual(exportLines, expectedOrder);
  });

  it("--check rejects when barrel file does not exist or is stale", () => {
    assert.ok(!fs.existsSync(barrelPath));

    let threw = false;
    try {
      execFileSync(process.execPath, [GENERATOR_SCRIPT, "--root", fixtureDir, "--check"], {
        encoding: "utf8",
        stdio: "pipe",
      });
    } catch (err) {
      threw = true;
      assert.equal(err.status, 1);
    }
    assert.ok(threw, "--check should exit with code 1 when barrel is missing");

    // Now write stale content
    fs.writeFileSync(barrelPath, "// Outdated barrel\nexport * from './old.js';\n");

    threw = false;
    try {
      execFileSync(process.execPath, [GENERATOR_SCRIPT, "--root", fixtureDir, "--check"], {
        encoding: "utf8",
        stdio: "pipe",
      });
    } catch (err) {
      threw = true;
      assert.equal(err.status, 1);
      assert.ok(err.stderr.includes("is out of date"));
    }
    assert.ok(threw, "--check should exit with code 1 when barrel is stale");
  });

  it("updates barrel on regeneration and --check accepts current output", () => {
    // Run generator without --check
    const stdout = execFileSync(process.execPath, [GENERATOR_SCRIPT, "--root", fixtureDir], {
      encoding: "utf8",
    });
    assert.ok(stdout.includes("Updated"));
    assert.ok(fs.existsSync(barrelPath));

    // Now --check should succeed with exit code 0
    const checkStdout = execFileSync(
      process.execPath,
      [GENERATOR_SCRIPT, "--root", fixtureDir, "--check"],
      {
        encoding: "utf8",
      },
    );
    assert.ok(checkStdout.includes("up to date"));
  });

  it("detects new module addition and requires regeneration", () => {
    // Add a new module to fixture
    fs.writeFileSync(path.join(myrmidonDir, "new-feature.ts"), "export const NEW_FEAT = 1;\n");

    // --check must now fail
    let threw = false;
    try {
      execFileSync(process.execPath, [GENERATOR_SCRIPT, "--root", fixtureDir, "--check"], {
        encoding: "utf8",
        stdio: "pipe",
      });
    } catch (err) {
      threw = true;
      assert.equal(err.status, 1);
    }
    assert.ok(threw, "--check should fail after new module is added");

    // Regenerate
    execFileSync(process.execPath, [GENERATOR_SCRIPT, "--root", fixtureDir], {
      encoding: "utf8",
    });

    // --check must pass again
    const checkStdout = execFileSync(
      process.execPath,
      [GENERATOR_SCRIPT, "--root", fixtureDir, "--check"],
      {
        encoding: "utf8",
      },
    );
    assert.ok(checkStdout.includes("up to date"));
    const updatedBarrel = fs.readFileSync(barrelPath, "utf8");
    assert.ok(updatedBarrel.includes('export * from "./new-feature.js";'));
  });
});
