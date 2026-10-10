// packages/shared/src/myrmidon-knowledge-tools.ts
//
// myrmidon(1.6.6 KNOWLEDGE-2.0 K-2): the shared contract of the knowledge
// surface — tool names (native + REST), the per-section `auto` rule and the
// zod shapes the REST routes validate against. The board server and any MCP
// wiring read these so a name never drifts between the gateway, the route
// and the doc.

import { z } from "zod";

/** The native/MCP tool names of the knowledge module (§3.4). */
export const KNOWLEDGE_TOOL_NAMES = [
  "knowledge_search",
  "knowledge_read",
  "knowledge_list",
  "knowledge_backlinks",
  "knowledge_propose",
  "knowledge_write_draft",
  "knowledge_publish",
  "rule_propose",
] as const;

export type KnowledgeToolName = (typeof KNOWLEDGE_TOOL_NAMES)[number];

/**
 * The sections an agent may publish into without an approval card (§3.6:
 * glossary, releases, "how it's built" architecture pages). A section is
 * `auto` when its folder path starts with one of these prefixes. The rule is
 * deliberately a pure function of the item's `folderPath` so the REST route,
 * the MCP tool and the tests resolve the same answer.
 */
export const KNOWLEDGE_AUTO_SECTION_PREFIXES = ["glossary", "releases", "architecture"] as const;

/** True when the folder path is one of the `auto` sections. */
export function isKnowledgeAutoSection(folderPath: string | null | undefined): boolean {
  const normalized = (folderPath ?? "").trim().replace(/^\/+|\/+$/g, "").toLowerCase();
  if (normalized.length === 0) return false;
  return KNOWLEDGE_AUTO_SECTION_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
  );
}

// ---------------------------------------------------------------------------
// REST wire shapes (§3.4). Bodies only; params and queries are validated in
// the routes.
// ---------------------------------------------------------------------------

export const knowledgeSourceInputSchema = z.object({
  kind: z.enum(["task", "pr", "issue", "run", "document", "decision", "url"]),
  ref: z.string().min(1).max(2000),
  note: z.string().max(2000).nullish(),
});
export type KnowledgeSourceInput = z.infer<typeof knowledgeSourceInputSchema>;

export const knowledgeCreateItemSchema = z.object({
  slug: z.string().min(1).max(200),
  title: z.string().min(1).max(300),
  content: z.string().min(1).max(500_000),
  kind: z.enum(["note", "wiki", "answer", "task_outcome", "rule"]).optional(),
  summary: z.string().max(1000).nullish(),
  folderPath: z.string().max(500).optional(),
  tags: z.array(z.string().min(1).max(64)).max(50).optional(),
  approverKind: z.string().max(120).nullish(),
  sources: z.array(knowledgeSourceInputSchema).max(50).optional(),
});
export type KnowledgeCreateItemInput = z.infer<typeof knowledgeCreateItemSchema>;

export const knowledgeDraftSchema = z.object({
  content: z.string().min(1).max(500_000),
  changeSummary: z.string().max(1000).optional(),
  title: z.string().min(1).max(300).optional(),
  summary: z.string().max(1000).nullish(),
  folderPath: z.string().max(500).optional(),
  tags: z.array(z.string().min(1).max(64)).max(50).optional(),
  sources: z.array(knowledgeSourceInputSchema).max(50).optional(),
});
export type KnowledgeDraftInput = z.infer<typeof knowledgeDraftSchema>;

export const knowledgePublishSchema = z.object({
  revisionId: z.string().min(1).max(200).optional(),
});
export type KnowledgePublishInput = z.infer<typeof knowledgePublishSchema>;

export const knowledgeApproveSchema = z.object({
  revisionId: z.string().min(1).max(200).optional(),
  comment: z.string().max(2000).optional(),
});
export type KnowledgeApproveInput = z.infer<typeof knowledgeApproveSchema>;

export const knowledgeRollbackSchema = z.object({
  toRevisionId: z.string().min(1).max(200),
});
export type KnowledgeRollbackInput = z.infer<typeof knowledgeRollbackSchema>;

export const knowledgeSupersedeSchema = z.object({
  replacementSlug: z.string().min(1).max(200),
});
export type KnowledgeSupersedeInput = z.infer<typeof knowledgeSupersedeSchema>;

export const knowledgeProposeSchema = z.object({
  kind: z.enum(["note", "wiki", "answer", "task_outcome", "rule"]).optional(),
  // The target item the proposal edits; null for a new page.
  targetItemId: z.string().min(1).max(200).nullish(),
  targetSlug: z.string().min(1).max(200).nullish(),
  title: z.string().min(1).max(300).optional(),
  body: z.string().min(1).max(500_000),
  folderPath: z.string().max(500).optional(),
  lang: z.string().max(16).optional(),
  sources: z.array(knowledgeSourceInputSchema).min(1, "knowledge_propose requires at least one source").max(50),
});
export type KnowledgeProposeInput = z.infer<typeof knowledgeProposeSchema>;

export const knowledgeSuggestionDecisionSchema = z.object({
  reason: z.string().max(2000).optional(),
});
export type KnowledgeSuggestionDecisionInput = z.infer<typeof knowledgeSuggestionDecisionSchema>;

export const knowledgeSearchQuerySchema = z.object({
  q: z.string().min(1).max(500),
  mode: z.enum(["fts", "semantic", "both"]).optional(),
  space: z.string().max(500).optional(),
  lang: z.string().max(16).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type KnowledgeSearchQuery = z.infer<typeof knowledgeSearchQuerySchema>;

export const knowledgeListQuerySchema = z.object({
  space: z.string().max(500).optional(),
  kind: z.enum(["note", "wiki", "answer", "task_outcome", "rule"]).optional(),
  status: z.enum(["draft", "in_review", "published", "archived", "superseded"]).optional(),
  q: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export type KnowledgeListQuery = z.infer<typeof knowledgeListQuerySchema>;

/** The status the REST route answers when the autonomy matrix parks a publish. */
export const KNOWLEDGE_APPROVAL_REQUIRED_CODE = "knowledge_approval_required" as const;
/** The machine token when an agent calls a knowledge route without a grant. */
export const KNOWLEDGE_TOOL_ACCESS_DENIED_CODE = "knowledge_tool_access_denied" as const;
/** The machine token when the injection scanner flags a write payload. */
export const KNOWLEDGE_INJECTION_FLAGGED_CODE = "knowledge_injection_flagged" as const;
/** The machine token for `rule_approve` attempted by an agent. */
export const KNOWLEDGE_RULE_APPROVE_FORBIDDEN_CODE = "knowledge_rule_approve_forbidden" as const;
