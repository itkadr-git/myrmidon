// Change classification and test selection for the fast PR tier of
// .github/workflows/myrmidon-ci.yml. Pure functions over plain data so they
// can be unit-tested; affected-tests.mjs feeds them the real repository.
//
// Tiers:
//   docs - only Myrmidon docs and our node:test scripts changed: no typecheck,
//          vitest or build.
//   fast - typecheck, build and the tests selected below.
//   full - every test lane (the same as a push to main).

import path from "node:path";

// Changing any of these can affect tests anywhere, so they force the full tier.
export const FULL_TRIGGERS = [
  { pattern: /^pnpm-lock\.yaml$/, reason: "lockfile" },
  { pattern: /^pnpm-workspace\.yaml$/, reason: "workspace layout" },
  { pattern: /^package\.json$/, reason: "root package.json" },
  { pattern: /^\.npmrc$/, reason: "npm settings" },
  { pattern: /^patches\//, reason: "patched dependencies" },
  { pattern: /^tsconfig[^/]*\.json$/, reason: "root TypeScript config" },
  { pattern: /^vitest\.config\.[cm]?[jt]s$/, reason: "root vitest config" },
  { pattern: /^scripts\/[^/]+\.(mjs|js|ts|json)$/, reason: "root build and test scripts" },
  { pattern: /^scripts\/__tests__\//, reason: "root build and test scripts" },
  { pattern: /^\.github\/workflows\/myrmidon-ci\.yml$/, reason: "CI workflow" },
  { pattern: /^scripts\/myrmidon\/ci\//, reason: "CI test selection" },
  { pattern: /^scripts\/myrmidon\/deploy\/predeploy-board-check\.(sh|test\.mjs)$/, reason: "predeploy compatibility gate" },
  // The vendor-name policy and its snapshots gate the built interface and the
  // server answers: a change there must run the build lane (the gate itself).
  { pattern: /^scripts\/myrmidon\/vendor-name\//, reason: "vendor-name policy" },
  { pattern: /^packages\/db\//, reason: "database package" },
  { pattern: /^packages\/shared\//, reason: "shared package" },
  { pattern: /^packages\/plugins\/sdk\//, reason: "plugin SDK" },
  { pattern: /^packages\/paperclip-runner\//, reason: "runner (Rust and TypeScript)" },
  { pattern: /^Dockerfile$/, reason: "Dockerfile" },
];

// Files that cannot change the result of typecheck, vitest or the build.
const LIGHT = [
  /^docs\/myrmidon\//,
  /^scripts\/myrmidon\/(?!ci\/)/,
  /^CLAUDE\.md$/,
  /^NOTICE$/,
  /^\.github\/README\.md$/,
  /^\.gitleaks\.toml$/,
];

// Large packages are never tested whole in the fast tier: only their tests that
// changed or directly import the change. Above this many selected files a
// package gets the full tier instead.
export const SELECTIVE_PACKAGES = ["@myrmidon/server", "@myrmidon/ui", "myrmidon"];
export const MAX_FAST_FILES_PER_PACKAGE = 60;

// These suites read shared source or documentation directly, so import-based
// affected selection cannot discover them.
export const SHARED_GUARD_TESTS = [
  "server/src/__tests__/app-private-hostname-gate.test.ts",
  "server/src/myrmidon/channel-connectors/bridge/bridge.myrmidon.test.ts",
  "server/src/myrmidon/flags-killswitch.myrmidon.test.ts",
  "server/src/myrmidon/monitoring/alerts/guard.myrmidon.test.ts",
  "server/src/myrmidon/monitoring/dashboard/guard.myrmidon.test.ts",
  "server/src/myrmidon/monitoring/metrics/guard.myrmidon.test.ts",
  "server/src/myrmidon/swarm-claim/app-wiring.myrmidon.test.ts",
  "server/src/myrmidon/tracing-health/app-wiring.myrmidon.test.ts",
  "server/src/myrmidon/host-disk/wiring.myrmidon.test.ts",
];

const SHARED_GUARD_TRIGGERS = [
  "server/src/app.ts",
  "server/src/index.ts",
  "server/src/myrmidon/app-plugin.ts",
  "docs/myrmidon/FLAGS.md",
  "docs/myrmidon/SETTINGS.md",
];

/**
 * Applies the release-branch fast mode to a plan.
 *
 * Release branches (rel/*): PRs touching shared foundations run only the tests
 * their change touches, so a full-classified plan is lowered to fast. The
 * release branch itself still gets one full run before the release tag
 * (manual run or the `full-ci` label), and the fast mode applies only while
 * every package's selection stays within MAX_FAST_FILES_PER_PACKAGE: above
 * the limit the affected set no longer fits the fast job, so the plan
 * escalates back to full. A full run before the tag is never cancelled by
 * this helper.
 *
 * PR light (`prLight`, ordinary PRs when the repository variable CI_PR_FAST is
 * true; never set for rel/*, main, merge_group or tags): instead of escalating
 * to full above the limit, a package over the limit gets its DIRECT selection
 * (selectDirectTests: changed tests, tests next to the changed sources, tests
 * importing a changed file directly, the shared guard suites), capped at
 * MAX_FAST_FILES_PER_PACKAGE. The plan stays fast; plan.light records what was
 * kept and what was dropped so the planner can log it. Indirect effects are
 * left to the full run on main, exactly as in the fast tier itself.
 *
 * plan:      the classifyChanges result ({ tier, reasons, ... })
 * selection: the selectTests result for the change ({ files: [{ package, files }] })
 * options:   { releaseFast, forceFull, prLight, directSelection } — the CLI
 *            flags and, for prLight, the selectDirectTests result
 *
 * Returns the plan to use (a new object when the tier changes) plus, for a
 * surviving fast tier, the selection attached.
 */
export function applyReleaseFast(
  plan,
  selection,
  { releaseFast = false, forceFull = false, prLight = false, directSelection = null } = {},
) {
  const releaseFastActive = releaseFast && !forceFull && plan.tier === "full";
  let loweredReason = null;
  if (releaseFastActive) {
    plan = {
      tier: "fast",
      reasons: [
        `${prLight ? "PR light" : "release branch PR"}: affected tests only (was full: ${plan.reasons.slice(0, 3).join("; ")})`,
      ],
      ...(plan.changed ? { changed: plan.changed } : {}),
    };
    loweredReason = plan.reasons[0];
  }
  if (plan.tier !== "fast") return plan;
  const tooMany = (selection?.files ?? []).filter((entry) => entry.files.length > MAX_FAST_FILES_PER_PACKAGE);
  if (tooMany.length > 0) {
    const wasFull = tooMany.map(
      (e) => `${e.files.length} ${e.package} test files import the change (limit ${MAX_FAST_FILES_PER_PACKAGE})`,
    );
    if (prLight && !forceFull && directSelection) {
      return lightPlan(plan, selection, tooMany, directSelection, wasFull, loweredReason);
    }
    return {
      tier: "full",
      reasons: wasFull,
      ...(plan.changed ? { changed: plan.changed } : {}),
    };
  }
  return { ...plan, selection };
}

/** Fast plan whose over-limit packages are replaced by their direct selection. */
function lightPlan(plan, selection, tooMany, directSelection, wasFull, loweredReason) {
  const overLimit = new Set(tooMany.map((entry) => entry.package));
  const directOf = (name) => directSelection.find((entry) => entry.package === name) ?? { total: 0, files: [], dropped: [] };
  const files = selection.files.flatMap((entry) => {
    if (!overLimit.has(entry.package)) return [entry];
    const direct = directOf(entry.package);
    return direct.files.length > 0 ? [{ package: entry.package, files: direct.files }] : [];
  });
  return {
    tier: "fast",
    reasons: [`PR light: direct tests only (was full: ${wasFull.join("; ")})`, ...(loweredReason ? [loweredReason] : [])],
    ...(plan.changed ? { changed: plan.changed } : {}),
    selection: { ...selection, files },
    light: {
      limit: MAX_FAST_FILES_PER_PACKAGE,
      packages: tooMany.map((entry) => {
        const direct = directOf(entry.package);
        return {
          package: entry.package,
          affected: entry.files.length,
          direct: direct.total,
          kept: direct.files.length,
          dropped: direct.dropped,
        };
      }),
    },
  };
}

/** Log lines for a PR light plan: per package how much was kept and dropped. */
export function lightLogLines(plan, { listed = 10 } = {}) {
  if (!plan.light) return [];
  const lines = [];
  for (const p of plan.light.packages) {
    lines.push(
      `PR light: ${p.package}: ${p.affected} test files import the change; direct selection ${p.direct} file(s), ` +
        `kept ${p.kept} (limit ${plan.light.limit}), dropped ${p.dropped.length}`,
    );
    if (p.dropped.length > 0) {
      const more = p.dropped.length > listed ? `; +${p.dropped.length - listed} more in plan.json` : "";
      lines.push(`PR light: ${p.package}: dropped: ${p.dropped.slice(0, listed).join(", ")}${more}`);
    }
  }
  return lines;
}

export function classifyChanges(files, { forceFull = false } = {}) {
  if (forceFull) return { tier: "full", reasons: ["full run requested"] };
  if (files.length === 0) return { tier: "docs", reasons: ["no changed files"] };
  const reasons = new Set();
  for (const file of files) {
    for (const trigger of FULL_TRIGGERS) {
      if (trigger.pattern.test(file)) reasons.add(`${trigger.reason}: ${file}`);
    }
  }
  if (reasons.size > 0) return { tier: "full", reasons: [...reasons] };
  if (files.every((file) => LIGHT.some((pattern) => pattern.test(file)))) {
    return { tier: "docs", reasons: ["only Myrmidon docs and scripts"] };
  }
  return { tier: "fast", reasons: ["affected tests only"] };
}

const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bvi\.(?:mock|doMock|importActual)\s*\(\s*|\brequire\s*\(\s*)["'`]([^"'`]+)["'`]/g;

export function importSpecifiers(source) {
  const out = new Set();
  for (const match of source.matchAll(IMPORT_SPECIFIER)) out.add(match[1]);
  return [...out];
}

function stripExtension(file) {
  return file.replace(/\.(?:d\.ts|tsx?|mts|cts|mjs|cjs|jsx?)$/, "").replace(/\/index$/, "");
}

/** Owning package of a repo-relative path (longest matching directory). */
export function ownerOf(file, packages) {
  let best = null;
  for (const pkg of packages) {
    if (pkg.dir === "" ) continue;
    if (file === pkg.dir || file.startsWith(`${pkg.dir}/`)) {
      if (!best || pkg.dir.length > best.dir.length) best = pkg;
    }
  }
  return best;
}

/**
 * Selects tests for the fast tier.
 *
 * packages:  [{ name, dir, vitestProject: boolean, testScript: string|null }]
 * testFiles: [{ file, source }] every test file in the repository (repo-relative)
 *
 * A test file is selected when it changed itself, when it belongs to a changed
 * package (the whole package is tested, except SELECTIVE_PACKAGES), or when it
 * directly imports a changed package (bare specifier) or a changed module
 * (relative specifier). Transitive effects are left to the full run on main.
 */
export function selectTests(changedFiles, packages, testFiles, { selective = SELECTIVE_PACKAGES } = {}) {
  const changedSet = new Set(changedFiles);
  const changedPackages = new Map();
  const changedModules = new Set();
  for (const file of changedFiles) {
    const pkg = ownerOf(file, packages);
    if (pkg) changedPackages.set(pkg.name, pkg);
    if (/\.(?:tsx?|mts|cts|mjs|cjs|jsx?)$/.test(file)) changedModules.add(stripExtension(file));
  }

  const wholePackages = [...changedPackages.values()].filter((pkg) => !selective.includes(pkg.name));
  const wholeNames = new Set(wholePackages.map((pkg) => pkg.name));
  const selected = new Map();
  const add = (pkg, file, why) => {
    if (!pkg) return;
    if (!selected.has(pkg.name)) selected.set(pkg.name, { pkg, files: new Map() });
    selected.get(pkg.name).files.set(file, why);
  };

  if (changedFiles.some((file) => SHARED_GUARD_TRIGGERS.includes(file))) {
    const testFilesByPath = new Set(testFiles.map((testFile) => testFile.file));
    const server = packages.find((pkg) => pkg.name === "@myrmidon/server");
    for (const file of SHARED_GUARD_TESTS) {
      if (testFilesByPath.has(file)) add(server, file, "shared-source guard");
    }
  }

  for (const { file, source } of testFiles) {
    const pkg = ownerOf(file, packages);
    if (!pkg || wholeNames.has(pkg.name)) continue;
    if (changedSet.has(file)) {
      add(pkg, file, "changed");
      continue;
    }
    for (const spec of importSpecifiers(source)) {
      if (spec.startsWith(".")) {
        const target = stripExtension(path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)));
        if (changedModules.has(target)) {
          add(pkg, file, `imports ${target}`);
          break;
        }
      } else {
        const bare = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
        if (changedPackages.has(bare) && bare !== pkg.name) {
          add(pkg, file, `imports ${bare}`);
          break;
        }
      }
    }
  }

  return {
    wholePackages: wholePackages.map((pkg) => pkg.name).sort(),
    files: [...selected.values()]
      .map(({ pkg, files }) => ({ package: pkg.name, files: [...files.keys()].sort() }))
      .sort((a, b) => a.package.localeCompare(b.package)),
  };
}

// ------------------------------------------------------------ PR light

// "@/x" in ui sources and tests points into ui/src (vitest alias in ui/vitest.config.ts).
export const PACKAGE_ALIASES = { "@myrmidon/ui": [{ prefix: "@/", dir: "src/" }] };

const CODE_FILE = /\.(?:tsx?|mts|cts|mjs|cjs|jsx?)$/;
const TEST_SUFFIX = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

// Order in which a package's direct selection is kept when it exceeds the limit.
const DIRECT_RANK = { changed: 0, "co-located": 1, "shared-guard": 2, imports: 3 };

/** First string a package.json `exports` entry resolves to (conditions: import, default, types, require). */
function exportTarget(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = exportTarget(item);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const condition of ["import", "default", "types", "require"]) {
      const found = exportTarget(value[condition]);
      if (found) return found;
    }
  }
  return null;
}

/** Repo-relative file a workspace package exports under `subpath` ("." or "./x"), or null. */
export function resolveExport(pkg, subpath) {
  const map = pkg.exports;
  if (!map) return null;
  const subpaths = typeof map === "object" && !Array.isArray(map) ? Object.keys(map).filter((k) => k.startsWith(".")) : [];
  let target = null;
  if (subpaths.length === 0) {
    target = subpath === "." ? exportTarget(map) : null;
  } else if (Object.hasOwn(map, subpath)) {
    target = exportTarget(map[subpath]);
  } else {
    // Longest matching "./prefix*suffix" pattern wins, as in Node.
    let best = null;
    for (const key of subpaths) {
      const star = key.indexOf("*");
      if (star < 0) continue;
      const prefix = key.slice(0, star);
      const suffix = key.slice(star + 1);
      if (subpath.length < key.length - 1 || !subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
      if (!best || prefix.length > best.prefix.length) best = { key, prefix, suffix };
    }
    if (best) {
      const matched = subpath.slice(best.prefix.length, subpath.length - best.suffix.length);
      target = exportTarget(map[best.key])?.split("*").join(matched) ?? null;
    }
  }
  return target ? path.posix.join(pkg.dir, target) : null;
}

/** Module path (extension stripped) a test's import specifier points at, or null if it is not a workspace file. */
function importTarget(spec, testFile, testPackage, packagesByName) {
  if (spec.startsWith(".")) return stripExtension(path.posix.normalize(path.posix.join(path.posix.dirname(testFile), spec)));
  for (const alias of PACKAGE_ALIASES[testPackage.name] ?? []) {
    if (spec.startsWith(alias.prefix)) return stripExtension(path.posix.join(testPackage.dir, alias.dir, spec.slice(alias.prefix.length)));
  }
  const parts = spec.split("/");
  const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  const pkg = packagesByName.get(name);
  if (!pkg || pkg.name === testPackage.name) return null;
  const rest = parts.slice(spec.startsWith("@") ? 2 : 1).join("/");
  const file = resolveExport(pkg, rest ? `./${rest}` : ".");
  return file ? stripExtension(file) : null;
}

/** Number of leading directory segments two repo paths share. */
function sharedDepth(a, b) {
  const left = path.posix.dirname(a).split("/");
  const right = path.posix.dirname(b).split("/");
  let n = 0;
  while (n < left.length && n < right.length && left[n] === right[n]) n += 1;
  return n;
}

/**
 * Direct selection for the PR light tier: for each package, the test files that
 * are clearly about the change, in the order they are kept under `limit`:
 *   1. changed       - test files the PR itself changed;
 *   2. co-located    - tests next to a changed source: `name.test.ts`,
 *                      `name.<kind>.test.ts` (for example `.myrmidon.test.ts`) in
 *                      the same directory, or `name.test.ts` in a `__tests__`
 *                      directory at or above it (server/src/__tests__);
 *   3. shared-guard  - SHARED_GUARD_TESTS (server), always;
 *   4. imports       - tests importing a changed file directly (depth 1; a relative
 *                      path, the `@/` alias of ui, or a package subpath resolved
 *                      through the package's `exports`). Importing a package root
 *                      that re-exports the changed file is transitive and not counted.
 * Within a rank the tests whose name starts with a changed file's name
 * (`heartbeat-*.test.ts` for heartbeat.ts) go first, then the tests nearest to
 * the change in the tree, then by path, so the result is deterministic. Tests of whole-tested packages are skipped (they
 * run whole anyway).
 *
 * Returns [{ package, total, files, dropped }] (files and dropped sorted by path;
 * `total` is the size before the cap).
 */
export function selectDirectTests(
  changedFiles,
  packages,
  testFiles,
  { selective = SELECTIVE_PACKAGES, limit = MAX_FAST_FILES_PER_PACKAGE } = {},
) {
  const changedSet = new Set(changedFiles);
  const packagesByName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const changedPackages = new Set();
  const changedModules = new Set();
  // Changed sources by name: base -> directories, for the co-located rule.
  const sourceDirsByBase = new Map();
  const changedBases = new Set();
  for (const file of changedFiles) {
    const pkg = ownerOf(file, packages);
    if (pkg) changedPackages.add(pkg.name);
    if (!CODE_FILE.test(file)) continue;
    changedModules.add(stripExtension(file));
    if (TEST_SUFFIX.test(file)) continue;
    const base = path.posix.basename(file).replace(CODE_FILE, "");
    if (base !== "index") changedBases.add(base);
    if (!sourceDirsByBase.has(base)) sourceDirsByBase.set(base, []);
    sourceDirsByBase.get(base).push(path.posix.dirname(file));
  }
  const wholeNames = new Set([...changedPackages].filter((name) => !selective.includes(name)));

  const colocated = (testFile) => {
    const dir = path.posix.dirname(testFile);
    const stem = path.posix.basename(testFile).replace(TEST_SUFFIX, "");
    const inTestsDir = path.posix.basename(dir) === "__tests__";
    const above = inTestsDir ? path.posix.dirname(dir) : null;
    const segments = stem.split(".");
    // "a.b.test.ts" belongs to sources "a.b" and "a".
    for (let n = segments.length; n >= 1; n -= 1) {
      const base = segments.slice(0, n).join(".");
      const dirs = sourceDirsByBase.get(base);
      if (!dirs) continue;
      if (dirs.includes(dir)) return true;
      if (inTestsDir && base !== "index" && dirs.some((d) => d === above || d.startsWith(`${above}/`))) return true;
    }
    return false;
  };

  // "heartbeat-cost.test.ts" is named after the changed heartbeat.ts.
  const namedAfterChange = (testFile) => {
    const stem = path.posix.basename(testFile).replace(TEST_SUFFIX, "");
    return [...changedBases].some((base) => stem === base || (stem.startsWith(base) && /^[-._]/.test(stem.slice(base.length))));
  };

  const candidates = new Map(); // package name -> Map(file -> { rank, named, near })
  const add = (pkg, file, kind, near = 0) => {
    if (!candidates.has(pkg.name)) candidates.set(pkg.name, new Map());
    const rank = DIRECT_RANK[kind];
    const known = candidates.get(pkg.name).get(file);
    if (!known || rank < known.rank) candidates.get(pkg.name).set(file, { rank, named: namedAfterChange(file) ? 1 : 0, near });
  };

  const server = packagesByName.get("@myrmidon/server");
  const testPaths = new Set(testFiles.map((testFile) => testFile.file));
  if (server && !wholeNames.has(server.name)) {
    for (const file of SHARED_GUARD_TESTS) {
      if (testPaths.has(file)) add(server, file, "shared-guard");
    }
  }

  for (const { file, source } of testFiles) {
    const pkg = ownerOf(file, packages);
    if (!pkg || wholeNames.has(pkg.name)) continue;
    if (changedSet.has(file)) {
      add(pkg, file, "changed");
    } else if (colocated(file)) {
      add(pkg, file, "co-located");
    } else {
      let near = -1;
      for (const spec of importSpecifiers(source)) {
        const target = importTarget(spec, file, pkg, packagesByName);
        if (target && changedModules.has(target)) near = Math.max(near, sharedDepth(file, target));
      }
      if (near >= 0) add(pkg, file, "imports", near);
    }
  }

  return [...candidates.entries()]
    .map(([name, byFile]) => {
      const ordered = [...byFile.entries()]
        .sort(([fa, a], [fb, b]) => a.rank - b.rank || b.named - a.named || b.near - a.near || (fa < fb ? -1 : fa > fb ? 1 : 0))
        .map(([file]) => file);
      return {
        package: name,
        total: ordered.length,
        files: ordered.slice(0, limit).sort(),
        dropped: ordered.slice(limit).sort(),
      };
    })
    .sort((a, b) => a.package.localeCompare(b.package));
}
