// server/src/myrmidon/knowledge/seed.ts
//
// myrmidon(1.6.6 KNOWLEDGE-2.0 K-8): seeder for the knowledge base.
//
// Seeds the `decisions/` and `product/` folders of a nest from the curated
// corpus (seed-data.ts + seed-product.ts). Decisions are created as
// `kind=wiki` items (the K-1 store supports note/wiki/answer/task_outcome/
// rule; the arch doc's finer-grained `kind=decision` lands with a later
// K-task) with the decided_by / date / quote recorded in the content
// front-matter and a `sources` pointer back to the OPE-401 registry.
// Supersede chains (e.g. FORAGING variant-2 → "включить сейчас") are applied
// via store.supersede so the replaced decision keeps its history.
//
// The seeder is idempotent: a re-run skips items whose slug already exists in
// the nest instead of duplicating rows (create() would raise slug_conflict).

import type { Db } from "@myrmidon/db";
import { KnowledgeDomainError } from "./domain.js";
import { SEED_DECISIONS, type SeedDecision } from "./seed-data.js";
import { SEED_PRODUCT_PAGES, type SeedProductPage } from "./seed-product.js";
import {
  createKnowledgeService,
  type KnowledgeActor,
  type KnowledgeService,
} from "./store.js";

export { SEED_DECISIONS, SEED_PRODUCT_PAGES };
export type { SeedDecision, SeedProductPage };

/** The system actor the seed runs as (curator drafts → operator publish). */
export const SEED_ACTOR: KnowledgeActor = { actorType: "system", actorId: null };

function decisionContent(d: SeedDecision): string {
  const lines = [
    "---",
    `decided_by: ${d.decidedBy}`,
    `date: ${d.date}`,
    "---",
    "",
    `> ${d.quote}`,
    "",
  ];
  if (d.body) lines.push(d.body, "");
  if (d.supersedes) lines.push(`Отменяет: [[${d.supersedes}]].`, "");
  return lines.join("\n");
}

export interface SeedKnowledgeOptions {
  now?: () => Date;
}

export interface SeedKnowledgeResult {
  created: number;
  skipped: number;
  superseded: number;
  recovered: number;
  errors: Array<{ slug: string; code: string }>;
}

// Exact targets retired by the legacy curated edges removed in this patch.
const LEGACY_SUPERSEDE_TARGETS = [
  "decisions/2026-09-28-board-manages-containers",
  "decisions/2026-10-04-wiki-own",
  "decisions/2026-09-29-1-1-0-one-release",
] as const;

/**
 * Seed the decisions/ and product/ folders of a nest. Idempotent: existing
 * slugs are skipped. Decisions with `supersedes` are processed in a second
 * pass so the superseded slug already exists regardless of data order. A
 * second run treats an already-superseded item as success.
 */
export async function seedKnowledgeBase(
  db: Db,
  companyId: string,
  nestId: string,
  options: SeedKnowledgeOptions = {},
): Promise<SeedKnowledgeResult> {
  const store: KnowledgeService = createKnowledgeService(db, options);
  const result: SeedKnowledgeResult = { created: 0, skipped: 0, superseded: 0, recovered: 0, errors: [] };

  async function createIfMissing(input: Parameters<KnowledgeService["create"]>[0]): Promise<boolean> {
    try {
      await store.create(input, SEED_ACTOR);
      await store.publish(nestId, input.slug, SEED_ACTOR);
      return true;
    } catch (err: unknown) {
      if (err instanceof KnowledgeDomainError && err.code === "slug_conflict") return false;
      throw err;
    }
  }

  // Product pages (kind=note, no approval gate).
  for (const page of SEED_PRODUCT_PAGES) {
    const created = await createIfMissing({
      companyId,
      nestId,
      slug: page.slug,
      title: page.title,
      summary: page.summary,
      content: page.content,
      kind: "note",
      tags: page.tags,
      folderPath: "product",
      sources: [{ kind: "issue", ref: "OPE-2913", note: "vision-2-0 / roadmap-v1 (владелец, 29.09)" }],
    });
    created ? result.created++ : result.skipped++;
  }

  // Decisions (kind=wiki); content carries decided_by/date/quote front-matter.
  for (const d of SEED_DECISIONS) {
    const created = await createIfMissing({
      companyId,
      nestId,
      slug: d.slug,
      title: d.title,
      summary: `${d.date} — ${d.decidedBy}: «${d.quote.slice(0, 120)}»`,
      content: decisionContent(d),
      kind: "wiki",
      tags: d.tags ?? ["decision"],
      folderPath: "decisions",
      sources: [{ kind: "issue", ref: "OPE-401", note: `Реестр решений ADM, запись ${d.date}` }],
    });
    created ? result.created++ : result.skipped++;
  }

  // Only restore the three known legacy supersede targets. This is an
  // allowlisted recovery, not a general reversal of terminal workflow state.
  for (const slug of LEGACY_SUPERSEDE_TARGETS) {
    const item = await store.get(nestId, slug);
    if (!item || item.status !== "superseded") continue;
    try {
      if (await store.restoreSeedSuperseded(nestId, item.id, SEED_ACTOR)) result.recovered++;
    } catch (err: unknown) {
      if (err instanceof KnowledgeDomainError) {
        result.errors.push({ slug, code: err.code });
        continue;
      }
      throw err;
    }
  }

  // Only restore the explicit legacy targets retired by the removed curated edges.
  for (const slug of LEGACY_SUPERSEDE_TARGETS) {
    const item = await store.get(nestId, slug);
    if (!item || item.status !== "superseded") continue;
    try {
      if (await store.restoreSeedSuperseded(nestId, item.id, SEED_ACTOR)) result.recovered++;
    } catch (err: unknown) {
      if (err instanceof KnowledgeDomainError) {
        result.errors.push({ slug, code: err.code });
        continue;
      }
      throw err;
    }
  }

  // Supersede chains — second pass so both ends exist. Existing chains are
  // already in their intended state and therefore count as successful skips.
  // A legacy superseded row is intentionally not revived: superseded is a
  // terminal audit state, and removing a stale source link must not rewrite
  // history during a normal seed run.
  for (const d of SEED_DECISIONS) {
    if (!d.supersedes) continue;
    const replaced = await store.get(nestId, d.supersedes);
    const replacement = await store.get(nestId, d.slug);
    if (!replaced || !replacement) {
      result.errors.push({ slug: d.supersedes, code: "knowledge_not_found" });
      continue;
    }
    if (replaced.supersededByItemId === replacement.id) continue;
    try {
      await store.supersede(nestId, d.supersedes, SEED_ACTOR, { bySlug: d.slug });
      result.superseded++;
    } catch (err: unknown) {
      if (err instanceof KnowledgeDomainError) {
        result.errors.push({ slug: d.supersedes, code: err.code });
        continue;
      }
      throw err;
    }
  }

  return result;
}
