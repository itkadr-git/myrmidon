// myrmidon(OPE-12677, 1.7 SETTINGS-HONESTY): ratchet test — every registered
// behavior setting must have a code consumer, or be listed in the frozen
// UNWIRED_SETTINGS baseline.
//
// The point of the ratchet: today 25 of the registered settings have no reader
// anywhere in the code (their real functions live under other settings — e.g.
// `instance_settings.general.parallelHelpers`, `runsQueue.pauseDrains.*` — so
// these registry entries do nothing). A registry entry that nothing reads is
// dishonest UI: an operator can save a value and believe the system changed.
//
// The test walks the repository sources (no git, no network) and, for every
// registered key, searches a whole-word match of the key, its `envName`, or
// the camelCase variant of a snake_case key. Files that cannot be consumers
// are excluded: tests, the registration modules themselves, locale/i18n files,
// the Fine settings screen, and `baseline-exports.txt`.
// OPE-12677 review fix: the scan roots are no longer a hard-coded package
// list — the walker enumerates `packages/` and scans every `src` tree found
// at any depth, so readers in any package (current or future) are seen.
//
// Ratchet rules (it can only tighten):
// - a key that gained a reader must be REMOVED from UNWIRED_SETTINGS —
//   keeping it there fails with "remove it from the list";
// - a new registration without a reader (and not in the list) fails with
//   "wire it or do not register it".

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  behaviorSettingRegistry,
} from "./myrmidon-behavior-settings.js";
import "./myrmidon-runs-queue-settings.js";
import "./myrmidon-system-settings.js";

/** snake_case / dotted-uppercase → camelCase (autonomy_level → autonomyLevel). */
function camelCase(name: string): string {
  const parts = name.split("_");
  return parts[0] + parts.slice(1).map((p) => (p ? p[0].toUpperCase() + p.slice(1).toLowerCase() : "")).join("");
}

/** The names searched for one registered setting, whole-word. */
function searchableNames(key: string, envName: string): string[] {
  const names = new Set<string>([key, envName]);
  if (key.includes("_")) names.add(camelCase(key));
  if (envName.toLowerCase().includes("_")) names.add(camelCase(envName.toLowerCase()));
  return [...names];
}

/**
 * The frozen baseline: registered settings with no consumer in the code.
 * ONLY SHRINKS. Before removing a name, verify the reader with
 * `git grep -w <key>` (a file outside tests, documents, locales, the registry
 * and the Fine settings screen). Solving one of these (wiring a real consumer)
 * is an ADM decision — this test only keeps the list honest.
 */
const UNWIRED_SETTINGS: readonly string[] = [
  "auto_resume_from_error",
  "autonomy_level",
  "debug_mode",
  "default_timeout_seconds",
  "guardrail_injection_action",
  "guardrail_injection_enabled",
  "max_concurrent_agents",
  "model_fallback_signal_enabled",
  "parallel_helpers_default",
  "parallel_helpers_max_count",
  "pause_drain_enabled",
  "pause_drain_grace_sec",
  "pause_guard_threshold_days",
  "pause_resume_wake_batch_size",
  "review_rework_enabled",
  "review_routing_enabled",
  "run_stop_signal_mode",
  "stranded_autopolicy_retries_per_day",
  "swarm_cooling_base_sec",
  "swarm_scent_model",
  "swarm_scent_weight_recency",
  "swarm_scent_weight_similarity",
  "swarm_scent_weight_success",
  "swarm_taskless_gate",
  "team_liveness_silence_threshold_sec",
];

/** Repository root (packages/shared/src → repo root). */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * Source trees scanned for consumers. `packages/**\/src` is NOT hard-coded:
 * the walker enumerates `packages/` and includes every `src` tree found at
 * any depth (packages/db/src, packages/adapters/claude-local/src,
 * packages/plugins/sdk/src, packages/paperclip-runner/devtools src trees), so a
 * new package cannot be silently skipped (OPE-12677 review: the previous
 * fixed list omitted packages and could misclassify their readers).
 */
const FIXED_SCAN_ROOTS = ["server/src", "cli/src", "ui/src", "extension/src"] as const;

const SKIPPED_TREE_NAMES = new Set(["node_modules", "dist", ".git"]);

function collectPackageSrcRoots(
  packagesDir: string,
  repoRoot: string = REPO_ROOT,
): string[] {
  let entries: string[];
  try {
    entries = readdirSync(packagesDir);
  } catch {
    return []; // no packages/ tree — nothing to enumerate
  }
  const roots: string[] = [];
  for (const entry of entries.sort()) {
    if (entry.startsWith(".") || SKIPPED_TREE_NAMES.has(entry)) continue;
    const full = join(packagesDir, entry);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (!stats.isDirectory()) continue;
    // A package's own `src` tree is scanned AND the walker keeps descending
    // into the directory either way (OPE-12677 review): grouping directories
    // and packages without their own `src` (packages/plugins, devtools/,
    // examples/, sandbox-providers/*) hold nested package `src` trees that
    // must not be silently skipped.
    if (statSync(join(full, "src"), { throwIfNoEntry: false })?.isDirectory()) {
      roots.push(relative(repoRoot, join(full, "src")));
    }
    roots.push(...collectPackageSrcRoots(full, repoRoot));
  }
  return roots;
}

const SCAN_ROOTS: string[] = [
  ...FIXED_SCAN_ROOTS,
  ...collectPackageSrcRoots(join(REPO_ROOT, "packages")),
];

/** Files that by construction are not consumers. */
function isExcludedFile(path: string, base: string): boolean {
  // Tests never wire anything.
  if (base.includes(".test.") || base.includes(".spec.")) return true;
  // The registration modules themselves (and the registry class).
  if (
    base === "myrmidon-behavior-settings.ts" ||
    base === "myrmidon-behavior-settings-registry.ts" ||
    base === "myrmidon-runs-queue-settings.ts" ||
    base === "myrmidon-system-settings.ts" ||
    // This ratchet test module.
    base === "myrmidon-behavior-settings-consumers.test.ts"
  ) {
    return true;
  }
  // Export snapshots are not consumers.
  if (base === "baseline-exports.txt") return true;
  // Locales/i18n files are display text, not readers.
  const segments = path.split(sep);
  if (segments.some((segment) => segment === "locales" || segment === "i18n")) return true;
  if (/[/\\]locales?\b|[/\\]i18n\b|\.locales?\./i.test(path)) return true;
  // The Fine settings screen lists keys for display — not a reader (OPE-12677
  // scope: its four unwired keys are removed there separately).
  if (base.startsWith("Ui2FineSettings")) return true;
  return false;
}

function collectSourceFiles(root: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return; // absent tree — nothing to scan
  }
  for (const entry of entries) {
    const full = join(root, entry);
    if (isExcludedFile(full, entry)) continue;
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
      collectSourceFiles(full, out);
    } else if (/\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(entry)) {
      out.push(full);
    }
  }
}

describe("myrmidon(1.7 SETTINGS-HONESTY) every registered behavior setting has a consumer", () => {
  const defs = behaviorSettingRegistry.getAll();

  it("the registry under ratchet is non-trivial (walker sanity)", () => {
    expect(defs.length).toBeGreaterThan(100);
  });

  it("UNWIRED_SETTINGS names exist in the registry and are unique", () => {
    const registered = new Set(defs.map((def) => def.key));
    const seen = new Set<string>();
    for (const key of UNWIRED_SETTINGS) {
      expect(registered.has(key), `${key} is listed in UNWIRED_SETTINGS but not registered`).toBe(true);
      expect(seen.has(key), `${key} is listed twice`).toBe(false);
      seen.add(key);
    }
  });

  it("every registered setting has a code consumer or is in UNWIRED_SETTINGS", () => {
    const files: string[] = [];
    for (const scanRoot of SCAN_ROOTS) {
      collectSourceFiles(join(REPO_ROOT, scanRoot), files);
    }
    expect(files.length, "the walker found source files to scan").toBeGreaterThan(500);

    const contents = files.map((file) => ({ file, text: readFileSync(file, "utf8") }));

    const unwiredStill: string[] = [];
    const removeNow: string[] = [];
    const newUnwired: string[] = [];

    for (const def of defs) {
      const names = searchableNames(def.key, def.envName);
      const pattern = new RegExp(
        names.map((name) => `\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).join("|"),
      );
      const hasReader = contents.some(({ text }) => pattern.test(text));
      const listed = UNWIRED_SETTINGS.includes(def.key);
      if (!hasReader && !listed) {
        newUnwired.push(def.key);
      } else if (hasReader && listed) {
        removeNow.push(def.key);
      } else if (!hasReader && listed) {
        unwiredStill.push(def.key);
      }
    }

    expect(
      removeNow,
      removeNow.length > 0
        ? `These settings gained a reader — remove them from UNWIRED_SETTINGS in ` +
          `src/myrmidon-behavior-settings-consumers.test.ts: ${removeNow.join(", ")}`
        : "no stale entries",
    ).toEqual([]);
    expect(
      newUnwired,
      newUnwired.length > 0
        ? `These registered settings have no consumer anywhere in the code — wire a ` +
          `reader or do not register them: ${newUnwired.join(", ")}`
        : "no new unwired settings",
    ).toEqual([]);
    // The ratchet's own bookkeeping: the frozen list must still cover exactly
    // the settings it claims to cover.
    expect(unwiredStill.sort()).toEqual([...UNWIRED_SETTINGS].sort());
  });

  it("enumerates nested package src trees under grouping directories (OPE-12677 review)", () => {
    const packagesDir = join(REPO_ROOT, "packages");
    const roots = collectPackageSrcRoots(packagesDir);
    const relRoots = roots.map((root) => root.split(sep).join("/"));

    // Grouping directories and packages WITHOUT their own `src` must still
    // contribute the nested package `src` trees below them — the previous
    // walker bailed out on them and silently skipped these readers
    // (packages/plugins has no own src; paperclip-runner has one but its
    // devtools/examples trees sit deeper).
    expect(relRoots).toContain("packages/plugins/sdk/src");
    expect(relRoots).toContain("packages/plugins/sandbox-providers/docker/src");
    expect(relRoots).toContain("packages/paperclip-runner/devtools/browser/src");
    expect(relRoots).toContain("packages/paperclip-runner/examples/mini-consumer/src");
    // Top-level packages keep their own roots.
    expect(relRoots).toContain("packages/shared/src");
    expect(relRoots).toContain("packages/db/src");
    // Every enumerated root exists exactly once (no duplicates from the
    // always-descend traversal).
    expect(new Set(relRoots).size).toBe(relRoots.length);
  });
});
