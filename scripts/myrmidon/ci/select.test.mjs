import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyReleaseFast, classifyChanges, importSpecifiers, selectTests, MAX_FAST_FILES_PER_PACKAGE } from "./select.mjs";

const packages = [
  { name: "@paperclipai/server", dir: "server" },
  { name: "@paperclipai/ui", dir: "ui" },
  { name: "paperclipai", dir: "cli" },
  { name: "@paperclipai/adapter-a-local", dir: "packages/adapters/a-local" },
  { name: "@paperclipai/adapter-b-local", dir: "packages/adapters/b-local" },
];

const testFiles = [
  { file: "server/src/__tests__/a-adapter.test.ts", source: 'import { x } from "@paperclipai/adapter-a-local/server";' },
  { file: "server/src/__tests__/b-adapter.test.ts", source: 'vi.mock("@paperclipai/adapter-b-local");' },
  { file: "server/src/__tests__/heartbeat.test.ts", source: 'import { heartbeat } from "../services/heartbeat.js";' },
  { file: "server/src/services/heartbeat.local.test.ts", source: 'const m = await import("./heartbeat.js");' },
  { file: "server/src/__tests__/unrelated.test.ts", source: 'import { y } from "../services/other.js";' },
  { file: "ui/src/components/Card.test.tsx", source: 'import { Card } from "./Card";' },
  { file: "packages/adapters/a-local/src/server/execute.test.ts", source: 'import { execute } from "./execute.js";' },
];

describe("classifyChanges", () => {
  it("forces the full tier for shared foundations", () => {
    for (const file of [
      "pnpm-lock.yaml",
      "package.json",
      "packages/db/src/schema/issues.ts",
      "packages/shared/src/constants.ts",
      ".github/workflows/myrmidon-ci.yml",
      "scripts/run-vitest-stable.mjs",
      "packages/paperclip-runner/src/index.ts",
      "scripts/myrmidon/ci/select.mjs",
    ]) {
      assert.equal(classifyChanges([file]).tier, "full", file);
    }
  });

  it("keeps Myrmidon docs and scripts in the docs tier", () => {
    const result = classifyChanges(["docs/myrmidon/tracks/1.md", "scripts/myrmidon/deploy/deploy.sh", "NOTICE"]);
    assert.equal(result.tier, "docs");
  });

  it("uses the fast tier for an adapter change", () => {
    assert.equal(classifyChanges(["packages/adapters/a-local/src/server/execute.ts"]).tier, "fast");
  });

  it("treats vendor docs read by tests as code", () => {
    assert.equal(classifyChanges(["docs/api/issues.md"]).tier, "fast");
  });

  it("honours a forced full run", () => {
    assert.equal(classifyChanges(["docs/myrmidon/ci.md"], { forceFull: true }).tier, "full");
  });
});

describe("importSpecifiers", () => {
  it("finds static, dynamic, mock and require specifiers", () => {
    const source = [
      'import a from "a";',
      'import { b } from "./b.js";',
      'import "./side-effect";',
      'const c = await import("c/sub");',
      'vi.mock("@scope/d");',
      'const e = require("e");',
    ].join("\n");
    assert.deepEqual(importSpecifiers(source).sort(), ["./b.js", "./side-effect", "@scope/d", "a", "c/sub", "e"].sort());
  });
});

describe("selectTests", () => {
  it("tests a changed adapter whole plus direct importers elsewhere", () => {
    const result = selectTests(["packages/adapters/a-local/src/server/execute.ts"], packages, testFiles);
    assert.deepEqual(result.wholePackages, ["@paperclipai/adapter-a-local"]);
    assert.deepEqual(result.files, [{ package: "@paperclipai/server", files: ["server/src/__tests__/a-adapter.test.ts"] }]);
  });

  it("never tests the server whole: only tests importing the changed module", () => {
    const result = selectTests(["server/src/services/heartbeat.ts"], packages, testFiles);
    assert.deepEqual(result.wholePackages, []);
    assert.deepEqual(result.files, [
      {
        package: "@paperclipai/server",
        files: ["server/src/__tests__/heartbeat.test.ts", "server/src/services/heartbeat.local.test.ts"],
      },
    ]);
  });

  it("selects a changed test file itself", () => {
    const result = selectTests(["ui/src/components/Card.test.tsx"], packages, testFiles);
    assert.deepEqual(result.files, [{ package: "@paperclipai/ui", files: ["ui/src/components/Card.test.tsx"] }]);
  });

  it("follows mocks of a changed package", () => {
    const result = selectTests(["packages/adapters/b-local/src/index.ts"], packages, testFiles);
    assert.deepEqual(result.files, [{ package: "@paperclipai/server", files: ["server/src/__tests__/b-adapter.test.ts"] }]);
  });

  it("selects nothing for a change nobody imports", () => {
    const result = selectTests(["server/src/services/lonely.ts"], packages, testFiles);
    assert.deepEqual(result, { wholePackages: [], files: [] });
  });
});

describe("applyReleaseFast", () => {
  const fullPlan = { tier: "full", reasons: ["CI test selection: scripts/myrmidon/ci/select.mjs"], changed: ["scripts/myrmidon/ci/select.mjs"] };
  const smallSelection = { wholePackages: [], files: [{ package: "@paperclipai/server", files: ["server/src/__tests__/a.test.ts"] }] };
  const bigFiles = Array.from({ length: MAX_FAST_FILES_PER_PACKAGE + 1 }, (_, i) => `server/src/__tests__/bulk-${i}.test.ts`);
  const bigSelection = { wholePackages: [], files: [{ package: "@paperclipai/server", files: bigFiles }] };

  it("keeps a small release PR fast", () => {
    const result = applyReleaseFast(fullPlan, smallSelection, { releaseFast: true });
    assert.equal(result.tier, "fast");
    assert.deepEqual(result.selection, smallSelection);
    assert.match(result.reasons[0], /release branch PR: affected tests only/);
  });

  it("escalates a release PR past the per-package file limit to full", () => {
    const result = applyReleaseFast(fullPlan, bigSelection, { releaseFast: true });
    assert.equal(result.tier, "full");
    assert.equal(result.selection, undefined);
    assert.match(result.reasons[0], new RegExp(`${MAX_FAST_FILES_PER_PACKAGE + 1} @paperclipai/server test files`));
  });

  it("escalates a non-release fast plan past the limit to full (unchanged behaviour)", () => {
    const fastPlan = { tier: "fast", reasons: ["affected tests only"], changed: ["server/src/services/heartbeat.ts"] };
    const result = applyReleaseFast(fastPlan, bigSelection, { releaseFast: false });
    assert.equal(result.tier, "full");
    assert.match(result.reasons[0], /test files import the change/);
  });

  it("keeps a non-release fast plan within the limit fast", () => {
    const fastPlan = { tier: "fast", reasons: ["affected tests only"] };
    const result = applyReleaseFast(fastPlan, smallSelection, { releaseFast: false });
    assert.equal(result.tier, "fast");
    assert.deepEqual(result.selection, smallSelection);
  });

  it("never lowers a forced full run", () => {
    const result = applyReleaseFast(fullPlan, smallSelection, { releaseFast: true, forceFull: true });
    assert.equal(result.tier, "full");
  });

  it("leaves a docs plan alone", () => {
    const docsPlan = { tier: "docs", reasons: ["only Myrmidon docs and scripts"] };
    const result = applyReleaseFast(docsPlan, null, { releaseFast: true });
    assert.equal(result.tier, "docs");
    assert.equal(result.selection, undefined);
  });
});
