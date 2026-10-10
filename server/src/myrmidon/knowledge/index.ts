// server/src/myrmidon/knowledge/index.ts
//
// myrmidon(1.6.6 KNOWLEDGE-2.0 K-1): entry point of the knowledge module —
// part A (domain + store). K-2 (the API task) layers the HTTP/API surface on the
// module returned here; K-3 (the search task) reads delivery through
// `get`/`exportTree`; the plugin bridge stays until the K-6 transfer
// (decision registry, 08.10, 08.10).

export * from "./domain.js";
export {
  renderKnowledgeIndex,
  selectIndexPages,
  pageAppliesToCastes,
  ANY_CASTE,
  type KnowledgeIndexEntry,
  type KnowledgeIndexInput,
  type KnowledgeIndexPageInput,
} from "./delivery-index.js";
export {
  createKnowledgeService,
  type KnowledgeActor,
  type KnowledgeService,
  type KnowledgeServiceOptions,
  type KnowledgeItemDto,
  type KnowledgeRevisionDto,
  type KnowledgeEventDto,
  type KnowledgeBacklinkDto,
  type CreateKnowledgeInput,
  type DraftKnowledgeInput,
  type ApproveKnowledgeInput,
  type RollbackKnowledgeInput,
  type SupersedeKnowledgeInput,
  type ImportTreeResult,
} from "./store.js";
export { createKnowledgeModule, type KnowledgeModule, type KnowledgeModuleOptions } from "./service.js";
