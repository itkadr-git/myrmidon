// server/src/myrmidon/knowledge/migrate/run.ts
//
// myrmidon(1.6.6 KNOWLEDGE-2.0 K-6): the two commands behind
// `knowledge-migrate classify` and `knowledge-migrate import`.
//
//   classify — plans the migration: class per page, the slug map the operator
//              seeds and then edits, the link resolution rate, the class sum.
//              Read-only; `--dry-run` only pins that nothing is written.
//   import   — writes the plan into `knowledge` through the K-1 service
//              (create → revision + sources + frontmatter fields). `--dry-run`
//              does the whole computation and reports what it would write.

import { classifyPath } from "./classify.js";
import { rewriteLinks } from "./links.js";
import { parseSlugMap, serializeSlugMap, type MigrateMap, type MigratePagePlan } from "./map.js";
import { buildClassifyReport, classesOf, type ClassifyReport, type ImportReport, type PlannedPage } from "./report.js";
import { readSourceTree, type ReadSourceTreeOptions, type SourceTree } from "./source.js";
import { slugFor } from "./classify.js";
import { type CreateKnowledgeInput, type DraftKnowledgeInput, type KnowledgeActor } from "../store.js";
import { type KnowledgeSourceKind } from "../domain.js";

/** The slice of the K-1 service the migration uses (structural type). */
export interface KnowledgeWriter {
  create(input: CreateKnowledgeInput, actor: KnowledgeActor): Promise<{ id: string; slug: string }>;
  draft(nestId: string, idOrSlug: string, input: DraftKnowledgeInput, actor: KnowledgeActor): Promise<{ id: string; slug: string }>;
  supersede(nestId: string, idOrSlug: string, input: { bySlug: string }, actor: KnowledgeActor): Promise<unknown>;
  searchNest(nestId: string, query: string, limit?: number): Promise<Array<{ itemId: string; slug: string; title: string }>>;
}

export interface MigrationPlan {
  source: SourceTree;
  pages: PlannedPage[];
  report: ClassifyReport;
  /** Page bodies by source path — in memory only, never printed. */
  contents: Map<string, string>;
  map: MigrateMap;
}

export interface PlanOptions {
  root: string;
  map: MigrateMap;
  expectedTotal?: number;
  dryRun?: boolean;
  catalog?: ReadSourceTreeOptions["catalog"];
}

/** Data for one migration. */
export interface MigrationDataSet {
  tree: SourceTree;
}

function normalizeLinkTarget(raw: string): string {
  let target = raw.trim();
  target = target.replace(/^\.{1,2}\//, "");
  while (target.startsWith("../")) target = target.slice(3);
  if (target.startsWith("/")) target = target.slice(1);
  if (target.startsWith("wiki/")) target = target.slice(5);
  target = target.replace(/\.md$/i, "");
  return target;
}

/**
 * Builds the resolver for `[[…]]`: a link resolves through the operator's map
 * when its target is a source path, a source slug, a target slug, or a page
 * title. Anything else stays unresolved and lands in the report (§5.3).
 */
export function buildLinkResolver(pages: PlannedPage[]): (target: string) => string | null {
  const byPath = new Map<string, string>();
  const bySourceSlug = new Map<string, string>();
  const byLastSegment = new Map<string, string | null>();
  const byTitle = new Map<string, string>();

  const rememberLastSegment = (key: string, slug: string): void => {
    const existing = byLastSegment.get(key);
    if (existing === undefined) byLastSegment.set(key, slug);
    else if (existing !== slug) byLastSegment.set(key, null); // ambiguous
  };

  for (const page of pages) {
    if (page.target === null) continue;
    byPath.set(page.path, page.target);
    byPath.set(page.path.replace(/\.md$/i, ""), page.target);
    bySourceSlug.set(slugFor(page.path), page.target);
    rememberLastSegment(slugFor(page.path).split("/").pop() ?? "", page.target);
    byPath.set(page.target, page.target);
  }
  for (const page of pages) {
    if (page.target === null) continue;
    if (!byTitle.has(page.path)) byTitle.set(page.path, page.target);
  }

  return (raw: string): string | null => {
    const target = normalizeLinkTarget(raw);
    if (target === "") return null;
    const direct = byPath.get(raw) ?? byPath.get(target);
    if (direct !== undefined) return direct;
    const sourceSlug = bySourceSlug.get(target);
    if (sourceSlug !== undefined) return sourceSlug;
    const byTitled = byTitle.get(target);
    if (byTitled !== undefined) return byTitled;
    const last = target.split("/").pop() ?? "";
    const segment = byLastSegment.get(last);
    if (segment !== undefined && segment !== null) return segment;
    const lastSlug = byLastSegment.get(slugFor(last));
    if (lastSlug !== undefined && lastSlug !== null) return lastSlug;
    return null;
  };
}

/** Plans the migration: the class of every page, the map, the link counts. */
export function planMigration(options: PlanOptions): MigrationPlan {
  const tree = readSourceTree(options.root, options.catalog === undefined ? {} : { catalog: options.catalog });
  const pages: PlannedPage[] = [];
  const contents = new Map<string, string>();

  const drafts: Array<{ path: string; plan: MigratePagePlan; seeded: boolean; bytes: number; content: string; keys: string[]; hasFrontmatter: boolean; malformed: number }> = [];
  for (const page of tree.pages) {
    const override = options.map.pages[page.path];
    let plan: MigratePagePlan;
    let seeded = false;
    if (override !== undefined) {
      plan = override;
    } else {
      const seed = classifyPath(page.path, page.bytes);
      plan = { class: seed.class, action: seed.action, kind: seed.kind, publish: seed.publish };
      if (seed.target !== undefined) plan.target = seed.target;
      if (seed.mergeInto !== undefined) plan.mergeInto = seed.mergeInto;
      if (seed.approverKind !== undefined) plan.approverKind = seed.approverKind;
      seeded = true;
    }
    drafts.push({
      path: page.path,
      plan,
      seeded,
      bytes: page.bytes,
      content: page.frontmatter.body,
      keys: page.frontmatter.keys,
      hasFrontmatter: page.frontmatter.hasFrontmatter,
      malformed: page.frontmatter.malformedLines,
    });
  }

  // Targets are known before links are resolved, so `[[…]]` can point at pages
  // that are still to be written.
  const targetOf = (draft: (typeof drafts)[number]): string | null => {
    if (draft.plan.action === "drop" || draft.plan.action === "replace_index") return null;
    return draft.plan.target ?? draft.plan.mergeInto ?? null;
  };
  const previewPages: PlannedPage[] = drafts.map((draft) => {
    const target = targetOf(draft);
    return {
      path: draft.path,
      bytes: draft.bytes,
      plan: draft.plan,
      seeded: draft.seeded,
      target,
      hasFrontmatter: draft.hasFrontmatter,
      frontmatterKeys: draft.keys,
      malformedFrontmatterLines: draft.malformed,
      links: { total: 0, resolved: 0, unresolved: [] },
    };
  });
  const resolve = buildLinkResolver(previewPages);

  for (let index = 0; index < drafts.length; index += 1) {
    const draft = drafts[index]!;
    const page = previewPages[index]!;
    if (page.target === null) {
      pages.push(page);
      contents.set(draft.path, draft.content);
      continue;
    }
    const rewritten = rewriteLinks(draft.content, resolve);
    page.links = { total: rewritten.total, resolved: rewritten.resolved, unresolved: rewritten.unresolved };
    pages.push(page);
    contents.set(draft.path, rewritten.content);
  }

  const report = buildClassifyReport({
    root: options.root,
    skipped: tree.skipped,
    pages,
    mapPaths: Object.keys(options.map.pages),
    expectedTotal: options.expectedTotal ?? options.map.expectedTotal,
    dryRun: options.dryRun ?? false,
  });

  return { source: tree, pages, report, contents, map: options.map };
}

/** Reads the operator's slug map text into the typed map. */
export function readSlugMap(text: string): MigrateMap {
  return parseSlugMap(text);
}

export { serializeSlugMap };

/** Seeds the operator's map from the classifier (never overwrites their file). */
export function seedSlugMap(plan: MigrationPlan, base?: Partial<MigrateMap>): MigrateMap {
  const pages: Record<string, MigratePagePlan> = {};
  for (const page of plan.pages.slice().sort((a, b) => (a.path < b.path ? -1 : 1))) {
    if (!page.seeded) {
      pages[page.path] = page.plan;
      continue;
    }
    const seed = classifyPath(page.path, page.bytes);
    const planEntry: MigratePagePlan = { class: seed.class, action: seed.action };
    if (seed.target !== undefined) planEntry.target = seed.target;
    if (seed.kind !== undefined) planEntry.kind = seed.kind;
    if (seed.mergeInto !== undefined) planEntry.mergeInto = seed.mergeInto;
    if (seed.approverKind !== undefined) planEntry.approverKind = seed.approverKind;
    if (seed.publish !== undefined) planEntry.publish = seed.publish;
    pages[page.path] = planEntry;
  }
  return {
    version: 1,
    expectedTotal: base?.expectedTotal ?? plan.map.expectedTotal,
    defaultSources: base?.defaultSources ?? plan.map.defaultSources,
    pages,
    checks: base?.checks ?? plan.map.checks,
  };
}

function sourceKindOf(ref: string): KnowledgeSourceKind {
  if (/^https?:\/\//i.test(ref)) return "url";
  if (/^OPE-\d+$/i.test(ref) || /^[0-9a-f-]{36}$/i.test(ref)) return "issue";
  return "document";
}

function sourcesFor(page: PlannedPage, page_sources: string[], defaults: string[] | undefined): Array<{ kind: KnowledgeSourceKind; ref: string; note?: string | null }> {
  const refs: string[] = [`wiki/${page.path}`, ...page_sources];
  for (const ref of defaults ?? []) refs.push(ref);
  const seen = new Set<string>();
  const out: Array<{ kind: KnowledgeSourceKind; ref: string; note?: string | null }> = [];
  for (const ref of refs) {
    if (ref.trim() === "" || seen.has(ref)) continue;
    seen.add(ref);
    out.push({ kind: sourceKindOf(ref), ref });
  }
  return out;
}

export interface ImportOptions {
  plan: MigrationPlan;
  service: KnowledgeWriter;
  companyId: string;
  nestId: string;
  actor: KnowledgeActor;
  dryRun: boolean;
  expectedTotal?: number;
}

interface CreatedTarget {
  id: string;
  slug: string;
  /** Accumulated content (in memory only) so a shared target keeps all pages. */
  content: string;
}

/** Writes the plan through the K-1 service. Dry-run computes, writes nothing. */
export async function runImport(options: ImportOptions): Promise<ImportReport> {
  const { plan, service, companyId, nestId, actor, dryRun } = options;
  const writable = plan.pages.filter((page) => page.target !== null);
  const ordered = writable.slice().sort((a, b) => (a.path < b.path ? -1 : 1));

  const created = new Map<string, CreatedTarget>();
  const failed: Array<{ path: string; code: string }> = [];
  const superseded: string[] = [];
  const publishIntent: string[] = [];
  const mergeNeedsDecision: string[] = [];
  let appended = 0;
  let bytesWritten = 0;
  let sourcesWritten = 0;
  let revisionsWritten = 0;

  const order = [...ordered];
  const sourceByPath = new Map(plan.source.pages.map((page) => [page.path, page]));
  // Merges are superseded only once their targets exist, so they run last.
  const isMerge = (page: PlannedPage): boolean => page.plan.action === "merge";

  for (const page of order) {
    const target = page.target!;
    const content = plan.contents.get(page.path) ?? "";
    const source = sourceByPath.get(page.path);
    const sources = sourcesFor(page, page.plan.sources ?? source?.fields.sources ?? [], plan.map.defaultSources);
    const existing = created.get(target);
    if (existing === undefined) {
      const input: CreateKnowledgeInput = {
        companyId,
        nestId,
        slug: target,
        title: page.plan.title ?? source?.title ?? target,
        content,
        kind: (page.plan.kind as CreateKnowledgeInput["kind"] | undefined) ?? "wiki",
        summary: source?.fields.summary ?? null,
        folderPath: target.includes("/") ? target.slice(0, target.lastIndexOf("/")) : "",
        tags: page.plan.tags ?? source?.fields.tags ?? [],
        approvalRequired: (page.plan.kind ?? "wiki") === "rule",
        approverKind: page.plan.approverKind ?? null,
        sources,
      };
      if (page.plan.publish === true) publishIntent.push(target);
      if (!dryRun) {
        try {
          const item = await service.create(input, actor);
          created.set(target, { id: item.id, slug: item.slug, content });
        } catch (error) {
          failed.push({ path: page.path, code: (error as { code?: string }).code ?? "error" });
          continue;
        }
      } else {
        created.set(target, { id: `dry-run:${target}`, slug: target, content });
      }
      bytesWritten += Buffer.byteLength(content, "utf8");
      sourcesWritten += sources.length;
      revisionsWritten += 1;
    } else {
      // A second source page for the same target is knowledge, not noise:
      // its text is appended as a new revision so nothing is lost (§5.3).
      const merged = `${existing.content}\n\n${content}`;
      if (!dryRun) {
        try {
          await service.draft(nestId, target, { content: merged, changeSummary: "merged from a second plugin page", sources }, actor);
        } catch (error) {
          failed.push({ path: page.path, code: (error as { code?: string }).code ?? "error" });
          continue;
        }
      }
      existing.content = merged;
      appended += 1;
      bytesWritten += Buffer.byteLength(content, "utf8");
      sourcesWritten += sources.length;
      revisionsWritten += 1;
    }
  }

  for (const page of ordered) {
    if (!isMerge(page)) continue;
    const target = page.target!;
    const mergeInto = page.plan.mergeInto ?? "";
    if (mergeInto === "") {
      mergeNeedsDecision.push(page.path);
      continue;
    }
    if (dryRun) {
      superseded.push(target);
      continue;
    }
    try {
      await service.supersede(nestId, target, { bySlug: mergeInto }, actor);
      superseded.push(target);
    } catch (error) {
      failed.push({ path: page.path, code: (error as { code?: string }).code ?? "error" });
    }
  }

  const checks: ImportReport["checks"] = [];
  for (const check of plan.map.checks ?? []) {
    if (dryRun) {
      checks.push({ query: check.query, expect: check.expect, found: false, slug: null });
      continue;
    }
    const results = await service.searchNest(nestId, check.query, 10);
    const hit = results.find((row) => row.slug === check.expect || row.slug.includes(check.expect) || row.title.includes(check.expect));
    checks.push({ query: check.query, expect: check.expect, found: hit !== undefined, slug: hit?.slug ?? null });
  }

  let linkTotal = 0;
  let linkResolved = 0;
  for (const page of plan.pages) {
    linkTotal += page.links.total;
    linkResolved += page.links.resolved;
  }

  const classes = classesOf(plan.pages);
  const actual = plan.pages.length;
  return {
    version: 1,
    mode: "import",
    dryRun,
    nestId,
    classes,
    classSum: { expected: options.expectedTotal ?? plan.map.expectedTotal, actual, ok: actual === (options.expectedTotal ?? plan.map.expectedTotal) },
    created: created.size,
    appended,
    superseded,
    dropped: plan.pages.filter((page) => page.target === null).length,
    failed,
    bytesWritten,
    sourcesWritten,
    revisionsWritten,
    publishIntent,
    mergeNeedsDecision,
    links: {
      total: linkTotal,
      resolved: linkResolved,
      unresolved: linkTotal - linkResolved,
      percent: linkTotal === 0 ? 100 : Math.round((linkResolved / linkTotal) * 1000) / 10,
    },
    frontmatterParsed: plan.pages.filter((page) => page.hasFrontmatter).length,
    checks,
  };
}