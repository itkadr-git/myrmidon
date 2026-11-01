import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyReleaseFast,
  classifyChanges,
  importSpecifiers,
  lightLogLines,
  resolveExport,
  selectDirectTests,
  selectTests,
  MAX_FAST_FILES_PER_PACKAGE,
  SHARED_GUARD_TESTS,
} from "./select.mjs";

const packages = [
  { name: "@myrmidon/server", dir: "server" },
  { name: "@myrmidon/ui", dir: "ui" },
  { name: "myrmidon", dir: "cli" },
  { name: "@myrmidon/adapter-a-local", dir: "packages/adapters/a-local" },
  { name: "@myrmidon/adapter-b-local", dir: "packages/adapters/b-local" },
];

const testFiles = [
  { file: "server/src/__tests__/a-adapter.test.ts", source: 'import { x } from "@myrmidon/adapter-a-local/server";' },
  { file: "server/src/__tests__/b-adapter.test.ts", source: 'vi.mock("@myrmidon/adapter-b-local");' },
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
      "scripts/myrmidon/vendor-name/vendor-name-policy.json",
    ]) {
      assert.equal(classifyChanges([file]).tier, "full", file);
    }
  });

  it("forces the full tier for the predeploy extension compatibility gate", () => {
    for (const file of [
      "scripts/myrmidon/deploy/predeploy-board-check.sh",
      "scripts/myrmidon/deploy/predeploy-board-check.test.mjs",
    ]) {
      const result = classifyChanges([file]);
      assert.equal(result.tier, "full", file);
      assert.match(result.reasons.join(" "), /predeploy compatibility gate/);
    }
  });

  it("keeps Myrmidon docs and non-critical scripts in the docs tier", () => {
    const result = classifyChanges(["docs/myrmidon/tracks/1.md", "scripts/myrmidon/deploy/deploy.sh", "NOTICE"]);
    assert.equal(result.tier, "docs");
  });

  it("uses the fast tier for an adapter change", () => {
    assert.equal(classifyChanges(["packages/adapters/a-local/src/server/execute.ts"]).tier, "fast");
  });

  it("treats vendor docs read by tests as code", () => {
    assert.equal(classifyChanges(["docs/api/issues.md"]).tier, "fast");
  });

  it("includes shared-source guard suites when app.ts changes", () => {
    for (const changedFile of [
      "server/src/app.ts",
      "server/src/myrmidon/app-plugin.ts",
      "docs/myrmidon/SETTINGS.md",
    ]) {
      const result = selectTests(
        [changedFile],
        [{ name: "@myrmidon/server", dir: "server", vitestProject: true }],
        [
          { file: "server/src/__tests__/app-private-hostname-gate.test.ts", source: "" },
          { file: "server/src/myrmidon/monitoring/dashboard/guard.myrmidon.test.ts", source: "" },
        ],
      );
      assert.deepEqual(result.files, [{
        package: "@myrmidon/server",
        files: [
          "server/src/__tests__/app-private-hostname-gate.test.ts",
          "server/src/myrmidon/monitoring/dashboard/guard.myrmidon.test.ts",
        ],
      }]);
    }
  });

  it("selects openapi-routes whenever a server route file changes (OPE-10350)", () => {
    const pkgs = [{ name: "@myrmidon/server", dir: "server", vitestProject: true }];
    const tests = [
      { file: "server/src/__tests__/openapi-routes.test.ts", source: "" },
      { file: "server/src/__tests__/unrelated.test.ts", source: 'import { y } from "../services/other.js";' },
    ];
    for (const changedFile of [
      "server/src/routes/users.ts",
      "server/src/routes/costs/by-day.ts",
      "server/src/routes/openapi.ts",
    ]) {
      const result = selectTests([changedFile], pkgs, tests);
      assert.deepEqual(result.files, [{
        package: "@myrmidon/server",
        files: ["server/src/__tests__/openapi-routes.test.ts"],
      }], changedFile);
    }
  });

  it("keeps the routes guard inside the fast tier", () => {
    const result = classifyChanges(["server/src/routes/users.ts"]);
    assert.equal(result.tier, "fast");
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
    assert.deepEqual(result.wholePackages, ["@myrmidon/adapter-a-local"]);
    assert.deepEqual(result.files, [{ package: "@myrmidon/server", files: ["server/src/__tests__/a-adapter.test.ts"] }]);
  });

  it("never tests the server whole: only tests importing the changed module", () => {
    const result = selectTests(["server/src/services/heartbeat.ts"], packages, testFiles);
    assert.deepEqual(result.wholePackages, []);
    assert.deepEqual(result.files, [
      {
        package: "@myrmidon/server",
        files: ["server/src/__tests__/heartbeat.test.ts", "server/src/services/heartbeat.local.test.ts"],
      },
    ]);
  });

  it("selects a changed test file itself", () => {
    const result = selectTests(["ui/src/components/Card.test.tsx"], packages, testFiles);
    assert.deepEqual(result.files, [{ package: "@myrmidon/ui", files: ["ui/src/components/Card.test.tsx"] }]);
  });

  it("follows mocks of a changed package", () => {
    const result = selectTests(["packages/adapters/b-local/src/index.ts"], packages, testFiles);
    assert.deepEqual(result.files, [{ package: "@myrmidon/server", files: ["server/src/__tests__/b-adapter.test.ts"] }]);
  });

  it("selects nothing for a change nobody imports", () => {
    const result = selectTests(["server/src/services/lonely.ts"], packages, testFiles);
    assert.deepEqual(result, { wholePackages: [], files: [] });
  });
});

describe("applyReleaseFast", () => {
  const fullPlan = { tier: "full", reasons: ["CI test selection: scripts/myrmidon/ci/select.mjs"], changed: ["scripts/myrmidon/ci/select.mjs"] };
  const smallSelection = { wholePackages: [], files: [{ package: "@myrmidon/server", files: ["server/src/__tests__/a.test.ts"] }] };
  const bigFiles = Array.from({ length: MAX_FAST_FILES_PER_PACKAGE + 1 }, (_, i) => `server/src/__tests__/bulk-${i}.test.ts`);
  const bigSelection = { wholePackages: [], files: [{ package: "@myrmidon/server", files: bigFiles }] };

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
    assert.match(result.reasons[0], new RegExp(`${MAX_FAST_FILES_PER_PACKAGE + 1} @myrmidon/server test files`));
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

describe("applyReleaseFast with prLight", () => {
  const fullPlan = { tier: "full", reasons: ["shared package: packages/shared/src/x.ts"], changed: ["packages/shared/src/x.ts"] };
  const fastPlan = { tier: "fast", reasons: ["affected tests only"], changed: ["server/src/services/heartbeat.ts"] };
  const many = (prefix, count) => Array.from({ length: count }, (_, i) => `${prefix}-${String(i).padStart(3, "0")}.test.ts`);
  const selection = {
    wholePackages: ["@myrmidon/shared"],
    files: [
      { package: "@myrmidon/adapter-utils", files: ["packages/adapter-utils/src/a.test.ts"] },
      { package: "@myrmidon/server", files: many("server/src/__tests__/bulk", MAX_FAST_FILES_PER_PACKAGE + 80) },
      { package: "@myrmidon/ui", files: many("ui/src/bulk", MAX_FAST_FILES_PER_PACKAGE + 5) },
    ],
  };
  const direct = [
    {
      package: "@myrmidon/server",
      total: MAX_FAST_FILES_PER_PACKAGE + 7,
      files: many("server/src/__tests__/direct", MAX_FAST_FILES_PER_PACKAGE),
      dropped: many("server/src/__tests__/late", 7),
    },
  ];

  it("keeps an over-limit PR fast with the direct selection instead of going full", () => {
    const result = applyReleaseFast(fastPlan, selection, { releaseFast: true, prLight: true, directSelection: direct });
    assert.equal(result.tier, "fast");
    assert.match(result.reasons[0], /^PR light: direct tests only \(was full: /);
    assert.match(result.reasons[0], new RegExp(`${MAX_FAST_FILES_PER_PACKAGE + 80} @myrmidon/server test files import the change \\(limit ${MAX_FAST_FILES_PER_PACKAGE}\\)`));
    assert.match(result.reasons[0], new RegExp(`${MAX_FAST_FILES_PER_PACKAGE + 5} @myrmidon/ui test files`));
    const byPackage = Object.fromEntries(result.selection.files.map((entry) => [entry.package, entry.files]));
    // Over the limit: replaced by the capped direct selection.
    assert.deepEqual(byPackage["@myrmidon/server"], direct[0].files);
    assert.ok(byPackage["@myrmidon/server"].length <= MAX_FAST_FILES_PER_PACKAGE);
    // Over the limit with nothing direct: the package contributes no tests.
    assert.equal(byPackage["@myrmidon/ui"], undefined);
    // Within the limit: untouched.
    assert.deepEqual(byPackage["@myrmidon/adapter-utils"], ["packages/adapter-utils/src/a.test.ts"]);
    assert.deepEqual(result.selection.wholePackages, ["@myrmidon/shared"]);
  });

  it("reports what the cap dropped", () => {
    const result = applyReleaseFast(fastPlan, selection, { releaseFast: true, prLight: true, directSelection: direct });
    const server = result.light.packages.find((entry) => entry.package === "@myrmidon/server");
    assert.deepEqual(
      { affected: server.affected, direct: server.direct, kept: server.kept, dropped: server.dropped.length },
      { affected: MAX_FAST_FILES_PER_PACKAGE + 80, direct: MAX_FAST_FILES_PER_PACKAGE + 7, kept: MAX_FAST_FILES_PER_PACKAGE, dropped: 7 },
    );
    assert.deepEqual(server.dropped, direct[0].dropped);
    const lines = lightLogLines(result);
    assert.match(lines.join("\n"), /@myrmidon\/server: 140 test files import the change; direct selection 67 file\(s\), kept 60 \(limit 60\), dropped 7/);
    assert.match(lines.join("\n"), /@myrmidon\/server: dropped: server\/src\/__tests__\/late-000\.test\.ts/);
    assert.match(lines.join("\n"), /@myrmidon\/ui: 65 test files import the change; direct selection 0 file\(s\), kept 0 \(limit 60\), dropped 0/);
  });

  it("shortens a long dropped list in the log and leaves the rest to plan.json", () => {
    const result = applyReleaseFast(fastPlan, selection, {
      releaseFast: true,
      prLight: true,
      directSelection: [{ ...direct[0], dropped: many("server/src/__tests__/late", 25) }],
    });
    const line = lightLogLines(result, { listed: 3 }).find((entry) => entry.includes("dropped: server/"));
    assert.match(line, /late-002\.test\.ts; \+22 more in plan\.json$/);
  });

  it("lowers a full-classified plan to fast and still applies the direct selection", () => {
    const result = applyReleaseFast(fullPlan, selection, { releaseFast: true, prLight: true, directSelection: direct });
    assert.equal(result.tier, "fast");
    assert.match(result.reasons[0], /^PR light: direct tests only \(was full: /);
    assert.match(result.reasons.join(" "), /PR light: affected tests only \(was full: shared package/);
    assert.ok(result.selection.files.every((entry) => entry.files.length <= MAX_FAST_FILES_PER_PACKAGE));
  });

  it("names the PR light mode, not a release branch, when it lowers a full plan within the limit", () => {
    const small = { wholePackages: [], files: [{ package: "@myrmidon/server", files: ["server/src/__tests__/a.test.ts"] }] };
    const result = applyReleaseFast(fullPlan, small, { releaseFast: true, prLight: true, directSelection: [] });
    assert.equal(result.tier, "fast");
    assert.match(result.reasons[0], /^PR light: affected tests only \(was full: shared package/);
    assert.equal(result.light, undefined);
    assert.deepEqual(result.selection, small);
  });

  it("keeps the full-ci label full", () => {
    for (const plan of [fullPlan, fastPlan]) {
      const result = applyReleaseFast({ ...plan, tier: "full" }, selection, {
        releaseFast: true,
        forceFull: true,
        prLight: true,
        directSelection: direct,
      });
      assert.equal(result.tier, "full");
      assert.equal(result.selection, undefined);
      assert.equal(result.light, undefined);
    }
  });

  it("changes nothing without prLight: rel/*, main, merge_group and tag plans still escalate", () => {
    // rel/* PR: --release-fast only.
    const release = applyReleaseFast(fullPlan, selection, { releaseFast: true, directSelection: direct });
    assert.equal(release.tier, "full");
    assert.equal(release.selection, undefined);
    assert.equal(release.light, undefined);
    // An ordinary fast plan with no flags.
    const plain = applyReleaseFast(fastPlan, selection, { directSelection: direct });
    assert.equal(plain.tier, "full");
    assert.equal(plain.light, undefined);
    // No base commit (push, tag, manual run): the plan is full before this helper.
    const noBase = { tier: "full", reasons: ["no base commit (push or manual run)"] };
    assert.deepEqual(applyReleaseFast(noBase, null, {}), noBase);
  });

  it("falls back to full when prLight has no direct selection to use", () => {
    const result = applyReleaseFast(fastPlan, selection, { releaseFast: true, prLight: true });
    assert.equal(result.tier, "full");
  });

  it("leaves a plan within the limit alone", () => {
    const small = { wholePackages: [], files: [{ package: "@myrmidon/server", files: ["server/src/__tests__/a.test.ts"] }] };
    const result = applyReleaseFast(fastPlan, small, { releaseFast: true, prLight: true, directSelection: direct });
    assert.equal(result.tier, "fast");
    assert.deepEqual(result.selection, small);
    assert.equal(result.light, undefined);
    assert.deepEqual(lightLogLines(result), []);
  });
});

describe("resolveExport", () => {
  const shared = {
    name: "@myrmidon/shared",
    dir: "packages/shared",
    exports: { ".": "./src/index.ts", "./telemetry": "./src/telemetry/index.ts", "./*": "./src/*.ts" },
  };

  it("resolves the root, an exact subpath and a wildcard subpath", () => {
    assert.equal(resolveExport(shared, "."), "packages/shared/src/index.ts");
    assert.equal(resolveExport(shared, "./telemetry"), "packages/shared/src/telemetry/index.ts");
    assert.equal(resolveExport(shared, "./env-alias"), "packages/shared/src/env-alias.ts");
    assert.equal(resolveExport(shared, "./remote-sites/health-reducer"), "packages/shared/src/remote-sites/health-reducer.ts");
  });

  it("follows import conditions and prefers the longest pattern", () => {
    const pkg = {
      name: "p",
      dir: "packages/p",
      exports: { ".": { types: "./a.d.ts", import: "./src/main.ts" }, "./*": "./src/*.ts", "./deep/*": "./src/deep/*/index.ts" },
    };
    assert.equal(resolveExport(pkg, "."), "packages/p/src/main.ts");
    assert.equal(resolveExport(pkg, "./deep/x"), "packages/p/src/deep/x/index.ts");
    assert.equal(resolveExport(pkg, "./other"), "packages/p/src/other.ts");
  });

  it("returns null when the package has no exports for the subpath", () => {
    assert.equal(resolveExport({ name: "p", dir: "packages/p" }, "."), null);
    assert.equal(resolveExport({ name: "p", dir: "packages/p", exports: "./src/index.ts" }, "./x"), null);
    assert.equal(resolveExport({ name: "p", dir: "packages/p", exports: { ".": "./src/index.ts" } }, "./x"), null);
  });
});

describe("selectDirectTests", () => {
  const pkgs = [
    { name: "@myrmidon/server", dir: "server", exports: null },
    { name: "@myrmidon/ui", dir: "ui", exports: null },
    {
      name: "@myrmidon/shared",
      dir: "packages/shared",
      exports: { ".": "./src/index.ts", "./*": "./src/*.ts" },
    },
    { name: "@myrmidon/adapter-a-local", dir: "packages/adapters/a-local", exports: { "./server": "./src/server/index.ts" } },
  ];
  const t = (file, source = "") => ({ file, source });
  const filesOf = (result, name) => result.find((entry) => entry.package === name)?.files ?? [];

  it("takes a changed test, tests next to the source and importers, in that order of importance", () => {
    const tests = [
      t("server/src/services/heartbeat.test.ts"),
      t("server/src/services/heartbeat.myrmidon.test.ts"),
      t("server/src/services/__tests__/heartbeat.test.ts"),
      t("server/src/__tests__/heartbeat.integration.test.ts"),
      t("server/src/__tests__/heartbeat-cost.test.ts", 'import { h } from "../services/heartbeat.js";'),
      t("server/src/__tests__/changed.test.ts"),
      t("server/src/__tests__/elsewhere.test.ts", 'vi.mock("../services/other.js");'),
    ];
    const result = selectDirectTests(["server/src/services/heartbeat.ts", "server/src/__tests__/changed.test.ts"], pkgs, tests);
    assert.deepEqual(filesOf(result, "@myrmidon/server"), [
      "server/src/__tests__/changed.test.ts",
      "server/src/__tests__/heartbeat-cost.test.ts",
      "server/src/__tests__/heartbeat.integration.test.ts",
      "server/src/services/__tests__/heartbeat.test.ts",
      "server/src/services/heartbeat.myrmidon.test.ts",
      "server/src/services/heartbeat.test.ts",
    ]);
  });

  it("does not follow imports transitively", () => {
    // heartbeat imports util; the test imports only heartbeat. util changed: no direct importer.
    const tests = [t("server/src/__tests__/heartbeat-x.test.ts", 'import { h } from "../services/heartbeat.js";')];
    assert.deepEqual(selectDirectTests(["server/src/services/util.ts"], pkgs, tests), []);
  });

  it("matches a package subpath through exports but not a barrel that re-exports the change", () => {
    const tests = [
      t("server/src/__tests__/subpath.test.ts", 'import { a } from "@myrmidon/shared/env-alias";'),
      t("server/src/__tests__/barrel.test.ts", 'import { b } from "@myrmidon/shared";'),
      t("server/src/__tests__/adapter.test.ts", 'import { c } from "@myrmidon/adapter-a-local/server";'),
    ];
    const subpath = selectDirectTests(["packages/shared/src/env-alias.ts"], pkgs, tests);
    assert.deepEqual(filesOf(subpath, "@myrmidon/server"), ["server/src/__tests__/subpath.test.ts"]);
    const barrel = selectDirectTests(["packages/shared/src/index.ts"], pkgs, tests);
    assert.deepEqual(filesOf(barrel, "@myrmidon/server"), ["server/src/__tests__/barrel.test.ts"]);
    const adapter = selectDirectTests(["packages/adapters/a-local/src/server/index.ts"], pkgs, tests);
    assert.deepEqual(filesOf(adapter, "@myrmidon/server"), ["server/src/__tests__/adapter.test.ts"]);
    // A file the barrel re-exports and nobody imports by its own path: no direct importer.
    assert.deepEqual(selectDirectTests(["packages/shared/src/types/issue.ts"], pkgs, tests), []);
  });

  it("resolves the @/ alias of ui", () => {
    const tests = [
      t("ui/src/pages/Page.test.tsx", 'import { x } from "@/lib/format";'),
      t("ui/src/pages/Other.test.tsx", 'import { x } from "@/lib/other";'),
      t("server/src/__tests__/not-ui.test.ts", 'import { x } from "@/lib/format";'),
    ];
    const result = selectDirectTests(["ui/src/lib/format.ts"], pkgs, tests);
    assert.deepEqual(filesOf(result, "@myrmidon/ui"), ["ui/src/pages/Page.test.tsx"]);
    assert.deepEqual(filesOf(result, "@myrmidon/server"), []);
  });

  it("always includes the shared guard suites for the server", () => {
    const guards = SHARED_GUARD_TESTS.map((file) => t(file));
    const result = selectDirectTests(["server/src/services/lonely.ts"], pkgs, guards);
    assert.deepEqual(filesOf(result, "@myrmidon/server"), [...SHARED_GUARD_TESTS].sort());
  });

  it("skips tests of a changed package that is tested whole", () => {
    const tests = [
      t("packages/shared/src/env.test.ts"),
      t("server/src/__tests__/uses-env.test.ts", 'import { a } from "@myrmidon/shared/env";'),
    ];
    const result = selectDirectTests(["packages/shared/src/env.ts", "packages/shared/src/env.test.ts"], pkgs, tests);
    assert.deepEqual(result.map((entry) => entry.package), ["@myrmidon/server"]);
  });

  it("caps a package at the limit: important tiers first, then names and nearness, deterministically", () => {
    const importers = [
      t("server/src/__tests__/zzz-far.test.ts", 'import "../services/heartbeat.js";'),
      t("server/src/__tests__/aaa-far.test.ts", 'import "../services/heartbeat.js";'),
      t("server/src/__tests__/heartbeat-named.test.ts", 'import "../services/heartbeat.js";'),
      t("server/src/services/near.test.ts", 'import "./heartbeat.js";'),
    ];
    const tests = [t("server/src/services/heartbeat.test.ts"), t("server/src/__tests__/mine.test.ts"), ...importers];
    const changed = ["server/src/services/heartbeat.ts", "server/src/__tests__/mine.test.ts"];
    const capped = selectDirectTests(changed, pkgs, tests, { limit: 3 });
    const server = capped.find((entry) => entry.package === "@myrmidon/server");
    // changed, co-located, then the importer named after heartbeat
    assert.deepEqual(server.files, [
      "server/src/__tests__/heartbeat-named.test.ts",
      "server/src/__tests__/mine.test.ts",
      "server/src/services/heartbeat.test.ts",
    ]);
    assert.equal(server.total, 6);
    // dropped: the nearer importer first by tier, then by path; sorted for the log
    assert.deepEqual(server.dropped, [
      "server/src/__tests__/aaa-far.test.ts",
      "server/src/__tests__/zzz-far.test.ts",
      "server/src/services/near.test.ts",
    ]);
    // Same input in another order gives the same answer.
    const again = selectDirectTests(changed, pkgs, [...tests].reverse(), { limit: 3 });
    assert.deepEqual(again, capped);
  });

  it("applies the default limit of MAX_FAST_FILES_PER_PACKAGE", () => {
    const tests = Array.from({ length: MAX_FAST_FILES_PER_PACKAGE + 10 }, (_, i) =>
      t(`server/src/__tests__/imp-${String(i).padStart(3, "0")}.test.ts`, 'import "../services/heartbeat.js";'),
    );
    const [server] = selectDirectTests(["server/src/services/heartbeat.ts"], pkgs, tests);
    assert.equal(server.total, MAX_FAST_FILES_PER_PACKAGE + 10);
    assert.equal(server.files.length, MAX_FAST_FILES_PER_PACKAGE);
    assert.equal(server.dropped.length, 10);
  });
});
