// ui/src/ui2/screens/knowledge/knowledgeApi.ts
//
// myrmidon(1.6.6 KNOWLEDGE-2.0 K-4): adapter from the K-2 knowledge REST
// contract to the reader's compact view model. K-1 stores one nest per company;
// `folderPath` is the UI space and slugs remain the stable item identity.

import { api } from "@/api/client";
import type {
  KnowledgeItemDetail,
  KnowledgeItemSummary,
  KnowledgeRevisionSummary,
  KnowledgeSourceRef,
} from "./knowledgeModel";

interface KnowledgeItemApi {
  id: string;
  slug: string;
  title: string;
  summary: string | null;
  status: string;
  folderPath: string;
  currentRevisionNumber: number;
  updatedAt: string;
  deliveredRevisionId: string | null;
  kind: string;
  deliveredContent?: string | null;
}

interface KnowledgeRevisionApi {
  id: string;
  revisionNumber: number;
  content: string;
  changeSummary: string | null;
  createdAt: string;
  approvedBy: string | null;
  sources: Array<{ kind: string; ref: string; note: string | null }>;
}

interface KnowledgeBacklinkApi {
  sourceSlug: string;
  sourceTitle: string;
  targetSlug: string;
}

export interface KnowledgeSpace {
  key: string;
  title: string;
  itemCount?: number;
}

export interface KnowledgeItemListResponse {
  items: KnowledgeItemSummary[];
  total?: number;
}

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

function itemPath(companyId: string, slug: string): string {
  return `${base(companyId)}/items/${slug.split("/").map(encodeURIComponent).join("/")}`;
}

function spaceKey(item: Pick<KnowledgeItemApi, "folderPath">): string {
  return item.folderPath || "knowledge";
}

function parentSlug(slug: string): string | null {
  const separator = slug.lastIndexOf("/");
  return separator > 0 ? slug.slice(0, separator) : null;
}

function toSummary(item: KnowledgeItemApi): KnowledgeItemSummary {
  return {
    id: item.id,
    spaceKey: spaceKey(item),
    slug: item.slug,
    title: item.title,
    parentSlug: parentSlug(item.slug),
    status: item.status,
    kind: item.kind,
    revision: item.currentRevisionNumber,
    updatedAt: item.updatedAt,
  };
}

function toSource(source: { kind: string; ref: string; note?: string | null }): KnowledgeSourceRef {
  return { kind: source.kind, ref: source.ref, label: source.note ?? null };
}

function toRevision(revision: KnowledgeRevisionApi): KnowledgeRevisionSummary {
  return {
    revision: revision.revisionNumber,
    at: revision.createdAt,
    by: revision.approvedBy ?? "",
    note: revision.changeSummary,
  };
}

async function detail(
  companyId: string,
  slug: string,
  options: { revision?: number | null } = {},
): Promise<KnowledgeItemDetailResponse> {
  const [itemResponse, revisionsResponse, backlinksResponse] = await Promise.all([
    api.get<{ item: KnowledgeItemApi }>(itemPath(companyId, slug)),
    api.get<{ revisions: KnowledgeRevisionApi[] }>(`${itemPath(companyId, slug)}/revisions`),
    api.get<{ backlinks: KnowledgeBacklinkApi[] }>(`${itemPath(companyId, slug)}/backlinks`),
  ]);
  const selected = options.revision == null
    ? revisionsResponse.revisions.find((revision) => revision.id === itemResponse.item.deliveredRevisionId)
    : revisionsResponse.revisions.find((revision) => revision.revisionNumber === options.revision);
  const revisions = revisionsResponse.revisions.map(toRevision);
  return {
    item: {
      ...toSummary(itemResponse.item),
      body: selected?.content ?? itemResponse.item.deliveredContent ?? "",
      sources: selected?.sources.map(toSource) ?? [],
      backlinks: backlinksResponse.backlinks.map((backlink) => ({
        kind: "knowledge",
        ref: backlink.sourceSlug,
        label: backlink.sourceTitle,
      })),
      revisions,
    },
    revisions,
  };
}

export const knowledgeApi = {
  async spaces(companyId: string): Promise<{ spaces: KnowledgeSpace[] }> {
    const { items } = await this.items(companyId);
    const counts = new Map<string, number>();
    for (const item of items) counts.set(item.spaceKey, (counts.get(item.spaceKey) ?? 0) + 1);
    return {
      spaces: [...counts.entries()].map(([key, itemCount]) => ({ key, title: key, itemCount })),
    };
  },

  async items(
    companyId: string,
    params: { spaceKey?: string; kind?: string; status?: string } = {},
  ): Promise<KnowledgeItemListResponse> {
    const query = new URLSearchParams();
    if (params.kind) query.set("kind", params.kind);
    if (params.status) query.set("status", params.status);
    const suffix = query.size > 0 ? `?${query}` : "";
    const response = await api.get<{ items: KnowledgeItemApi[] }>(`${base(companyId)}/items${suffix}`);
    const items = response.items.map(toSummary).filter((item) => !params.spaceKey || item.spaceKey === params.spaceKey);
    return { items, total: items.length };
  },

  item: (companyId: string, _spaceKey: string, slug: string, options: { revision?: number | null } = {}) =>
    detail(companyId, slug, options),

  async search(companyId: string, query: string, _mode: KnowledgeSearchMode = "fulltext"): Promise<KnowledgeSearchResponse> {
    const [response, listedResponse] = await Promise.all([
      api.get<{ items: Array<{ itemId: string; slug: string; title: string }> }>(
        `${base(companyId)}/search?q=${encodeURIComponent(query)}`,
      ),
      api.get<{ items: KnowledgeItemApi[] }>(`${base(companyId)}/items`),
    ]);
    const listed = listedResponse.items.map(toSummary);
    const byId = new Map(listed.map((item) => [item.id, item]));
    return {
      mode: "fulltext",
      hits: response.items.map((item) => ({
        item: byId.get(item.itemId) ?? {
          id: item.itemId,
          spaceKey: "knowledge",
          slug: item.slug,
          title: item.title,
          parentSlug: parentSlug(item.slug),
          status: "published",
          revision: 0,
          updatedAt: "",
        },
        snippet: "",
      })),
    };
  },

  async rollback(companyId: string, _spaceKey: string, slug: string, toRevision: number): Promise<KnowledgeRollbackResponse> {
    const { item } = await detail(companyId, slug);
    const revisions = await api.get<{ revisions: KnowledgeRevisionApi[] }>(`${itemPath(companyId, slug)}/revisions`);
    const target = revisions.revisions.find((revision) => revision.revisionNumber === toRevision);
    if (!target) throw new Error(`Knowledge revision ${toRevision} no longer exists.`);
    await api.post<{ item: KnowledgeItemApi }>(`${itemPath(companyId, slug)}/rollback`, {
      toRevisionId: target.id,
    });
    return { item: (await detail(companyId, item.slug)).item };
  },
};

export const knowledgeQueryKeys = {
  spaces: (companyId: string) => ["knowledge", "spaces", companyId] as const,
  items: (companyId: string) => ["knowledge", "items", companyId] as const,
  item: (companyId: string, spaceKey: string, slug: string, revision: number | null) =>
    ["knowledge", "item", companyId, spaceKey, slug, revision] as const,
  search: (companyId: string, query: string, mode: KnowledgeSearchMode) =>
    ["knowledge", "search", companyId, query, mode] as const,
};
