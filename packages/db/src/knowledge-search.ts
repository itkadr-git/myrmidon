// packages/db/src/knowledge-search.ts
//
// myrmidon(1.6.6 KNOWLEDGE-2.0 K-1): the pg implementation of the knowledge
// module's `SearchIndex` port (server/src/myrmidon/knowledge/domain.ts).
//
// The knowledge module itself contains zero dialect SQL — this is the only
// place that knows `knowledge_search` is a tsvector/pg_trgm/unaccent table.
// Rows mirror the DELIVERED revision only (the store upserts on publish /
// rollback / approve and removes on archive), so search == delivery.
//
// Ranking: exact lexeme match via `@@ websearch_to_tsvector` first, then a
// pg_trgm `%` similarity pass over the trgm columns for typo/substring
// queries, deduped by item, capped at `limit`.

import { sql } from "drizzle-orm";
import type { Db } from "./client.js";

export interface KnowledgeSearchPage {
  itemId: string;
  nestId: string;
  slug: string;
  title: string;
  summary: string | null;
  content: string;
}

export interface KnowledgeSearchHit {
  itemId: string;
  slug: string;
  title: string;
}

export interface KnowledgeSearchIndex {
  upsert(page: KnowledgeSearchPage): Promise<void>;
  remove(itemId: string): Promise<void>;
  search(nestId: string, query: string, limit: number): Promise<KnowledgeSearchHit[]>;
}

export function createPgKnowledgeSearchIndex(db: Db): KnowledgeSearchIndex {
  return {
    async upsert(page) {
      // INSERT … ON CONFLICT (item_id) DO UPDATE — one row per item, keyed by
      // the delivered revision's content. `search_vector`/`body_trgm` are
      // stored generated columns and refresh with the row automatically.
      await db.execute(sql`
        insert into "knowledge_search" ("item_id", "nest_id", "slug", "title", "summary", "body")
        values (${page.itemId}, ${page.nestId}, ${page.slug}, ${page.title}, ${page.summary}, ${page.content})
        on conflict ("item_id") do update
          set "nest_id" = excluded."nest_id",
              "slug" = excluded."slug",
              "title" = excluded."title",
              "summary" = excluded."summary",
              "body" = excluded."body"
      `);
    },
    async remove(itemId) {
      await db.execute(sql`delete from "knowledge_search" where "item_id" = ${itemId}`);
    },
    async search(nestId, query, limit) {
      const trimmed = query.trim();
      if (!trimmed) return [];
      const rows = (await db.execute(sql`
        with lex as (
          select "item_id" as "id", "slug", "title",
                 ts_rank("search_vector", websearch_to_tsquery('simple',
                   knowledge_unaccent(${trimmed}))) as "rank"
            from "knowledge_search"
           where "nest_id" = ${nestId}
             and "search_vector" @@ websearch_to_tsquery('simple',
                   knowledge_unaccent(${trimmed}))
        ),
        trg as (
          select "item_id" as "id", "slug", "title",
                 greatest(word_similarity(lower(${trimmed}), "body_trgm"),
                          similarity("slug", lower(${trimmed}))) as "rank"
            from "knowledge_search"
           where "nest_id" = ${nestId}
             and (
               "body_trgm" %> lower(${trimmed})
               or "slug" % lower(${trimmed})
               or "title" ilike '%' || ${trimmed} || '%'
             )
        ),
        merged as (
          select "id", "slug", "title", "rank" from lex
          union all
          select "id", "slug", "title", "rank" * 0.4 from trg
        ),
        best as (
          select "id", max("slug") as "slug", max("title") as "title", max("rank") as "rank"
            from merged
           group by "id"
        )
        select "id" as "item_id", "slug", "title"
          from best
         order by "rank" desc, "slug" asc
         limit ${limit}
      `)) as unknown as Array<{ item_id: string; slug: string; title: string }>;
      return rows.map((row) => ({ itemId: row.item_id, slug: row.slug, title: row.title }));
    },
  };
}
