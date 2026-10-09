// ui/src/ui2/screens/knowledge/knowledgeApi.ts
//
// myrmidon(1.6.6 KNOWLEDGE-2.0 K-4): the read side of the knowledge module as
// the ui2 screen consumes it. The screen owns no fetch logic of its own — it
// asks this client, which speaks the facade contract of
// knowledge-architecture §3.4 (`/api/myrmidon/companies/{id}/knowledge/…`).
//
// Only reads plus the rollback verb live here: K-4 is the read / search /
// revision surface ("человек читает и одобряет без плагина"); the write path
// (the editor with the frontmatter form) stays out of this screen.

import { api } from "@/api/client";
import type {
  KnowledgeItemDetail,
  KnowledgeItemSummary,
  KnowledgeRevisionSummary,
} from "./knowledgeModel";

/** One knowledge space (the tree column groups by it). */
export interface KnowledgeSpace {
  key: string;
  title: string;
  itemCount?: number;
}

export interface KnowledgeItemListResponse {
  items: KnowledgeItemSummary[];
  total?: number;
}

/** One search hit: the list-level item plus the matching snippet. */
export interface KnowledgeSearchHit {
  item: KnowledgeItemSummary;
  snippet: string;
  score?: number;
}

export interface KnowledgeSearchResponse {
  mode: string;
  hits: KnowledgeSearchHit[];
}

export interface KnowledgeItemDetailResponse {
  item: KnowledgeItemDetail;
  revisions?: KnowledgeRevisionSummary[];
}

export interface KnowledgeRollbackResponse {
  item: KnowledgeItemDetail;
}

export type KnowledgeSearchMode = "fulltext" | "semantic";

const base = (companyId: string): string =>
  `/myrmidon/companies/${encodeURIComponent(companyId)}/knowledge`;

function queryString(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : "";
}

export const knowledgeApi = {
  spaces: (companyId: string) =>
    api.get<{ spaces: KnowledgeSpace[] }>(`${base(companyId)}/spaces`),

  /** The flat list the tree is built from — one request per company. */
  items: (
    companyId: string,
    params: { spaceKey?: string; kind?: string; status?: string } = {},
  ) =>
    api.get<KnowledgeItemListResponse>(
      `${base(companyId)}/items${queryString({
        space: params.spaceKey,
        kind: params.kind,
        status: params.status,
      })}`,
    ),

  /** A page, optionally as of an older revision (the diff's right side). */
  item: (
    companyId: string,
    spaceKey: string,
    slug: string,
    options: { revision?: number | null } = {},
  ) =>
    api.get<KnowledgeItemDetailResponse>(
      `${base(companyId)}/items/${encodeURIComponent(spaceKey)}/${encodeURIComponent(slug)}${
        options.revision ? `?revision=${options.revision}` : ""
      }`,
    ),

  search: (companyId: string, query: string, mode: KnowledgeSearchMode = "fulltext") =>
    api.get<KnowledgeSearchResponse>(
      `${base(companyId)}/search${queryString({ q: query, mode })}`,
    ),

  /** The only write of this screen: restore an earlier revision. */
  rollback: (companyId: string, spaceKey: string, slug: string, toRevision: number) =>
    api.post<KnowledgeRollbackResponse>(
      `${base(companyId)}/items/${encodeURIComponent(spaceKey)}/${encodeURIComponent(slug)}/rollback`,
      { to_revision: toRevision },
    ),
};

/** React Query keys for the knowledge screen. */
export const knowledgeQueryKeys = {
  spaces: (companyId: string) => ["knowledge", "spaces", companyId] as const,
  items: (companyId: string) => ["knowledge", "items", companyId] as const,
  item: (companyId: string, spaceKey: string, slug: string, revision: number | null) =>
    ["knowledge", "item", companyId, spaceKey, slug, revision] as const,
  search: (companyId: string, query: string, mode: KnowledgeSearchMode) =>
    ["knowledge", "search", companyId, query, mode] as const,
};