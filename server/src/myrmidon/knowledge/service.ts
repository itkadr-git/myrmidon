// server/src/myrmidon/knowledge/service.ts
//
// myrmidon(1.6.6 KNOWLEDGE-2.0 K-1): the composition layer of the knowledge
// module. The store (./store.js) carries the operations; this file binds them
// to one nest — today `nestId === companyId` (decision registry, 08.10: one
// knowledge container per company until K-4 splits nests) — and attaches the
// pg `SearchIndex` implementation from `@paperclipai/db`, keeping the module
// free of dialect SQL.
//
// K-2 (UI/API) and K-3 (delivery read path) call this module through the
// object returned here; the plugin bridge stays until the K-6 transfer.

import { createPgKnowledgeSearchIndex, type Db } from "@paperclipai/db";
import { createKnowledgeService, type KnowledgeServiceOptions } from "./store.js";
import type { SearchIndex } from "./domain.js";

export interface KnowledgeModuleOptions extends KnowledgeServiceOptions {
  /** Override the search index (tests inject the memory one). */
  searchIndex?: SearchIndex;
  /** Today one nest per company; K-4 will pass a real nest id. */
  nestId?: string;
}

/**
 * A store bound to one company/nest: the API layer passes the companyId from
 * auth, and every call is automatically nest-scoped — no call site can leak
 * into another company's knowledge (invariant §3.2: every row carries nest_id).
 */
export function createKnowledgeModule(db: Db, companyId: string, options: KnowledgeModuleOptions = {}) {
  const nestId = options.nestId ?? companyId;
  const service = createKnowledgeService(db, {
    ...options,
    searchIndex: options.searchIndex ?? createPgKnowledgeSearchIndex(db),
  });

  return {
    companyId,
    nestId,
    create: (input: Omit<Parameters<typeof service.create>[0], "companyId" | "nestId">, actor: Parameters<typeof service.create>[1]) =>
      service.create({ ...input, companyId, nestId }, actor),
    draft: (idOrSlug: string, input: Parameters<typeof service.draft>[2], actor: Parameters<typeof service.draft>[3]) =>
      service.draft(nestId, idOrSlug, input, actor),
    submit: (idOrSlug: string, actor: Parameters<typeof service.submit>[2], revisionId?: string) =>
      service.submit(nestId, idOrSlug, actor, revisionId),
    publish: (idOrSlug: string, actor: Parameters<typeof service.publish>[2], revisionId?: string) =>
      service.publish(nestId, idOrSlug, actor, revisionId),
    approve: (idOrSlug: string, actor: Parameters<typeof service.approve>[2], input?: Parameters<typeof service.approve>[3]) =>
      service.approve(nestId, idOrSlug, actor, input),
    rollback: (idOrSlug: string, actor: Parameters<typeof service.rollback>[2], input: Parameters<typeof service.rollback>[3]) =>
      service.rollback(nestId, idOrSlug, actor, input),
    archive: (idOrSlug: string, actor: Parameters<typeof service.archive>[2]) => service.archive(nestId, idOrSlug, actor),
    supersede: (idOrSlug: string, actor: Parameters<typeof service.supersede>[2], input: Parameters<typeof service.supersede>[3]) =>
      service.supersede(nestId, idOrSlug, actor, input),
    get: (idOrSlug: string) => service.get(nestId, idOrSlug),
    getRevision: (idOrSlug: string, revisionId: string) => service.getRevision(nestId, idOrSlug, revisionId),
    listRevisions: (idOrSlug: string) => service.listRevisions(nestId, idOrSlug),
    listItems: (filter?: Parameters<typeof service.listItems>[1]) => service.listItems(nestId, filter),
    backlinks: (idOrSlug: string) => service.backlinks(nestId, idOrSlug),
    listEvents: (itemId?: string, limit?: number) => service.listEvents(nestId, itemId, limit),
    search: (query: string, limit?: number) => service.search(nestId, query, limit),
    suggest: (actor: Parameters<typeof service.suggest>[1], input: Omit<Parameters<typeof service.suggest>[2], "companyId" | "targetSlug"> & { targetSlug?: string }) =>
      service.suggest(nestId, actor, { ...input, companyId }),
    decideSuggestion: (actor: Parameters<typeof service.decideSuggestion>[1], input: Omit<Parameters<typeof service.decideSuggestion>[2], "companyId"> & { suggestionId: string; decision: "accepted" | "declined" }) =>
      service.decideSuggestion(nestId, actor, { ...input, companyId }),
    listSuggestions: (status?: Parameters<typeof service.listSuggestions>[1]) => service.listSuggestions(nestId, status),
    exportTree: () => service.exportTree(nestId),
    importTree: (buf: Buffer, actor: Parameters<typeof service.importTree>[3], opts?: Parameters<typeof service.importTree>[4]) =>
      service.importTree(companyId, nestId, buf, actor, opts),
  };
}

export type KnowledgeModule = ReturnType<typeof createKnowledgeModule>;
