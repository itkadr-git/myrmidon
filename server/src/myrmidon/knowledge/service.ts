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
import { redactNestText } from "../redact/service.js";
import { createKnowledgeService, type KnowledgeServiceOptions } from "./store.js";
import type { KnowledgeRevisionLang, SearchIndex } from "./domain.js";

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
    create: async (input: Omit<Parameters<typeof service.create>[0], "companyId" | "nestId">, actor: Parameters<typeof service.create>[1]) => {
      const redacted = await redactNestText(db, nestId, input.content);
      return service.create({ ...input, content: redacted.text, companyId, nestId }, actor);
    },
    draft: async (idOrSlug: string, input: Parameters<typeof service.draft>[2], actor: Parameters<typeof service.draft>[3]) => {
      const redacted = await redactNestText(db, nestId, input.content);
      return service.draft(nestId, idOrSlug, { ...input, content: redacted.text }, actor);
    },
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
    get: (idOrSlug: string, language?: KnowledgeRevisionLang) => service.get(nestId, idOrSlug, language),
    getRevision: (idOrSlug: string, revisionId: string) => service.getRevision(nestId, idOrSlug, revisionId),
    listRevisions: (idOrSlug: string, language?: KnowledgeRevisionLang) => service.listRevisions(nestId, idOrSlug, language),
    listItems: (filter?: Parameters<typeof service.listItems>[1]) => service.listItems(nestId, filter),
    backlinks: (idOrSlug: string) => service.backlinks(nestId, idOrSlug),
    listEvents: (itemId?: string, limit?: number) => service.listEvents(nestId, itemId, limit),
    /**
     * myrmidon(1.6.6 K-9): the evals gate's journal line — `eval_run_id` and
     * `delta` per judged publication. The gate calls this through the rollback
     * sink, so the quality journal shows the judge run for every rollout.
     */
    recordGateJournal: (idOrSlug: string, actor: Parameters<typeof service.recordGateJournal>[2], input: Parameters<typeof service.recordGateJournal>[3]) =>
      service.recordGateJournal(nestId, idOrSlug, actor, input),
    search: (query: string, limit?: number, language?: KnowledgeRevisionLang) => service.search(nestId, query, limit, language),
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
