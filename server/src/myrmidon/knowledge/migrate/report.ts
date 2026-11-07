// server/src/myrmidon/knowledge/migrate/report.ts
//
// myrmidon(1.6.6 KNOWLEDGE-2.0 K-6): the migration report is numbers only —
// class counts and their sum (§5.3: "сумма классов = 170"), the link
// resolution rate, the frontmatter keys that were parsed, the operator
// decisions still missing. No page content, no field values.

import { MIGRATE_CLASSES, type MigrateClass } from "./classify.js";
import type { MigratePagePlan } from "./map.js";

export interface PlannedPage {
  path: string;
  bytes: number;
  /** The page title (frontmatter, else the catalog title, else the first H1, else the file name). */
  title?: string;
  /** Effective plan: the map entry when the operator wrote one, else the seed. */
  plan: MigratePagePlan;
  /** True when the classifier supplied the plan because the map had no entry. */
  seeded: boolean;
  /** The knowledge slug this page is written to (import/merge). */
  target: string | null;
  hasFrontmatter: boolean;
  frontmatterKeys: string[];
  malformedFrontmatterLines: number;
  links: { total: number; resolved: number; unresolved: string[] };
}

export interface ClassifyReport {
  version: 1;
  mode: "classify";
  dryRun: boolean;
  source: { root: string; pages: number; skipped: { controlFiles: number; rawSources: number; other: number } };
  classes: Record<string, number>;
  classSum: { expected: number; actual: number; ok: boolean };
  actions: Record<string, number>;
  /** Source paths the map does not mention (the seed was used). */
  seededFromRules: string[];
  /** Map entries with no matching source page. */
  orphanMapEntries: string[];
  /** Targets that several source pages write to (a merge, if intended). */
  sharedTargets: Record<string, string[]>;
  frontmatter: { withBlock: number; withoutBlock: number; malformedLines: number; keys: Record<string, number> };
  links: { total: number; resolved: number; unresolved: number; percent: number; unresolvedTargets: string[] };
  /** Class C pages whose `mergeInto` the operator still has to choose. */
  mergeNeedsDecision: string[];
  warnings: string[];
}

function countBy<T extends string>(values: readonly T[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

export function buildClassifyReport(input: {
  root: string;
  skipped: { controlFiles: number; rawSources: number; other: number };
  pages: PlannedPage[];
  mapPaths: string[];
  expectedTotal: number;
  dryRun: boolean;
}): ClassifyReport {
  const classes = countBy(input.pages.map((page) => page.plan.class));
  for (const classId of MIGRATE_CLASSES) if (classes[classId] === undefined) classes[classId] = 0;

  const targets = new Map<string, string[]>();
  for (const page of input.pages) {
    if (page.target === null) continue;
    const list = targets.get(page.target) ?? [];
    list.push(page.path);
    targets.set(page.target, list);
  }
  const sharedTargets: Record<string, string[]> = {};
  for (const [target, paths] of [...targets.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (paths.length > 1) sharedTargets[target] = paths;
  }

  const keys: Record<string, number> = {};
  for (const page of input.pages) {
    for (const key of page.frontmatterKeys) keys[key] = (keys[key] ?? 0) + 1;
  }

  const unresolvedTargets: string[] = [];
  let linkTotal = 0;
  let linkResolved = 0;
  for (const page of input.pages) {
    linkTotal += page.links.total;
    linkResolved += page.links.resolved;
    for (const target of page.links.unresolved) if (!unresolvedTargets.includes(target)) unresolvedTargets.push(target);
  }

  const actual = input.pages.length;
  const warnings: string[] = [];
  if (input.pages.some((page) => page.malformedFrontmatterLines > 0)) {
    warnings.push("Some frontmatter blocks have malformed lines; see the per-page counts in the run log.");
  }

  return {
    version: 1,
    mode: "classify",
    dryRun: input.dryRun,
    source: { root: input.root, pages: actual, skipped: input.skipped },
    classes,
    classSum: { expected: input.expectedTotal, actual, ok: actual === input.expectedTotal },
    actions: countBy(input.pages.map((page) => page.plan.action)),
    seededFromRules: input.pages.filter((page) => page.seeded).map((page) => page.path).sort(),
    orphanMapEntries: [...input.mapPaths].filter((path) => !input.pages.some((page) => page.path === path)).sort(),
    sharedTargets,
    frontmatter: {
      withBlock: input.pages.filter((page) => page.hasFrontmatter).length,
      withoutBlock: input.pages.filter((page) => !page.hasFrontmatter).length,
      malformedLines: input.pages.reduce((sum, page) => sum + page.malformedFrontmatterLines, 0),
      keys: Object.fromEntries(Object.entries(keys).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))),
    },
    links: {
      total: linkTotal,
      resolved: linkResolved,
      unresolved: linkTotal - linkResolved,
      percent: linkTotal === 0 ? 100 : Math.round((linkResolved / linkTotal) * 1000) / 10,
      unresolvedTargets: unresolvedTargets.sort(),
    },
    mergeNeedsDecision: input.pages
      .filter((page) => page.plan.action === "merge" && (page.plan.mergeInto ?? "") === "")
      .map((page) => page.path)
      .sort(),
    warnings,
  };
}

export interface ImportReport {
  version: 1;
  mode: "import";
  dryRun: boolean;
  nestId: string;
  classes: Record<string, number>;
  classSum: { expected: number; actual: number; ok: boolean };
  created: number;
  /** Source pages appended as an extra revision of an existing target. */
  appended: number;
  superseded: string[];
  dropped: number;
  failed: Array<{ path: string; code: string }>;
  /** Page content never appears here: only sizes and counts. */
  bytesWritten: number;
  sourcesWritten: number;
  revisionsWritten: number;
  publishIntent: string[];
  mergeNeedsDecision: string[];
  links: { total: number; resolved: number; unresolved: number; percent: number };
  frontmatterParsed: number;
  checks: Array<{ query: string; expect: string; found: boolean; slug: string | null }>;
}

export function classesOf(pages: PlannedPage[]): Record<string, number> {
  const counts = countBy(pages.map((page) => page.plan.class as MigrateClass));
  for (const classId of MIGRATE_CLASSES) if (counts[classId] === undefined) counts[classId] = 0;
  return counts;
}