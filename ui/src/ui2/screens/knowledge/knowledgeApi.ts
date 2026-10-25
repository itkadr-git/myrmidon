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
  KnowledgeSourceRef,
} from "./knowledgeModel";

interface KnowledgeItemDto {
  id: string;
  slug: string;
  folderPath: string;
  title: string;
  status: string;
  kind?: string | null;
  currentRevisionNumber: number;
  updatedAt: string;
  parentSlug: string | null;
  reviewDueAt: string | null;
  approverKind?: string | null;
}

interface KnowledgeRevisionDto {
  id: string;
  itemId: string;
  revisionNumber: number;
  status: string;
  content: string;
  changeSummary?: string | null;
  rolledBackFromRevisionId?: string | null;
  approvedByKind?: string | null;
  approvedBy?: string | null;
  approvedAt?: string | null;
  createdAt: string;
  sources: Array<{ kind: string; ref: string; note?: string | null }>;
}

interface KnowledgeItemListResponse {
  items: KnowledgeItemDto[];
}

function toSummary(item: KnowledgeItemDto): KnowledgeItemSummary {
  return {
    id: item.id,
    spaceKey: item.folderPath,
    slug: item.slug,
    title: item.title,
    parentSlug: item.parentSlug,
    kind: item.kind,
    status: item.status,
    revision: item.currentRevisionNumber,
    updatedAt: item.updatedAt,
    reviewDueAt: item.reviewDueAt,
  };
}

function toRevisionSummary(revision: KnowledgeRevisionDto): KnowledgeRevisionSummary {
  return {
    id: revision.id,
    revision: revision.revisionNumber,
    at: revision.createdAt,
    by: revision.approvedBy ?? "",
    note: revision.changeSummary,
  };
}

interface KnowledgeBacklinkDto {
  sourceItemId: string;
  sourceSlug: string;
  sourceTitle: string;
  targetSlug: string;
  resolved: boolean;
}

/** A page that links here, as a source row of kind `page`. */
export function toBacklinkRef(backlink: KnowledgeBacklinkDto, fallbackSpace: string): KnowledgeSourceRef {
  // The backlink row carries the slug only; the page is looked up in the
  // space of the page it links to (a slug with `/` is already a full path).
  return {
    kind: "page",
    ref: backlink.sourceSlug,
    label: backlink.sourceTitle || backlink.sourceSlug,
    space: fallbackSpace,
  };
}

/** One search hit: the list-level item plus the matching snippet. */
export interface KnowledgeSearchHit {
  item: KnowledgeItemSummary;
  snippet: string;
  score?: number;
}

interface KnowledgeSearchHitDto {
  itemId: string;
  slug: string;
  folderPath: string;
  title: string;
}

export interface KnowledgeSearchResponse {
  query: string;
  items: KnowledgeSearchHitDto[];
}

export interface KnowledgeItemDetailResponse {
  item: KnowledgeItemDto & {
    approverKind?: string | null;
    approvalRequired?: boolean;
  };
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
  /** K-2 exposes one flat catalog; the UI groups it into spaces locally. */
  items: async (
    companyId: string,
    params: { spaceKey?: string; kind?: string; status?: string } = {},
  ) => {
    const response = await api.get<KnowledgeItemListResponse>(
      `${base(companyId)}/items${queryString({
        space: params.spaceKey,
        kind: params.kind,
        status: params.status,
      })}`,
    );
    return { ...response, items: response.items.map(toSummary) };
  },

  /** A page, optionally loaded from a specific revision. */
  item: async (
    companyId: string,
    spaceKey: string,
    slug: string,
    options: { revision?: string | number | null } = {},
  ): Promise<{ item: KnowledgeItemDetail }> => {
    const idOrSlug = slug.includes("/") ? slug : `${spaceKey}/${slug}`;
    const encoded = encodeURIComponent(idOrSlug);
    const itemResponse = await api.get<KnowledgeItemDetailResponse>(
      `${base(companyId)}/items/${encoded}`,
    );
    const item = itemResponse.item;
    const revisionsResponse = await api.get<{ revisions: KnowledgeRevisionDto[] }>(
      `${base(companyId)}/items/${encoded}/revisions`,
    );
    const revisions = revisionsResponse.revisions;
    // Backlinks are an extra read: a failure there must not hide the page.
    const backlinks = await api
      .get<{ backlinks: KnowledgeBacklinkDto[] }>(`${base(companyId)}/items/${encodeURIComponent(idOrSlug)}/backlinks`)
      .then((response) => response.backlinks.map((backlink) => toBacklinkRef(backlink, spaceKey)))
      .catch(() => [] as KnowledgeSourceRef[]);
    const selected = options.revision == null
      ? revisions[revisions.length - 1]
      : revisions.find((revision) => revision.revisionNumber === options.revision || revision.id === options.revision);
    return {
      item: {
        ...toSummary(item),
        spaceKey,
        body: selected?.content ?? "",
        revisions: revisions.map(toRevisionSummary),
        sources: selected?.sources ?? [],
        backlinks,
      },
    };
  },

  search: async (companyId: string, query: string, mode: KnowledgeSearchMode = "fulltext") => {
    const response = await api.get<KnowledgeSearchResponse>(
      `${base(companyId)}/search${queryString({ q: query, mode: mode === "semantic" ? "semantic" : "fts" })}`,
    );
    const details = response.items.map((hit) => ({
      item: {
        id: hit.itemId,
        spaceKey: hit.folderPath,
        slug: hit.slug,
        title: hit.title,
        status: "",
        revision: 0,
        updatedAt: "",
      },
      snippet: hit.title,
    }));
    return {
      ...response,
      mode,
      hits: details,
    };
  },

  /** The only write of this screen: restore an earlier revision. */
  rollback: (companyId: string, spaceKey: string, slug: string, toRevisionId: string) =>
    api.post<KnowledgeRollbackResponse>(
      `${base(companyId)}/items/${encodeURIComponent(slug.includes("/") ? slug : `${spaceKey}/${slug}`)}/rollback`,
      { toRevisionId },
    ),
};

/** React Query keys for the knowledge screen. */
export const knowledgeQueryKeys = {
  spaces: (companyId: string) => ["knowledge", "spaces", companyId] as const,
  items: (companyId: string) => ["knowledge", "items", companyId] as const,
  item: (companyId: string, spaceKey: string, slug: string, revision: string | number | null) =>
    ["knowledge", "item", companyId, spaceKey, slug, revision] as const,
  search: (companyId: string, query: string, mode: KnowledgeSearchMode) =>
    ["knowledge", "search", companyId, query, mode] as const,
};