// myrmidon(1.6-AUTONOMY-GW): tool-name -> autonomy action class mapping.
//
// The autonomy matrix rules on action classes (merge / deploy /
// external_message / ...), not on tool names. This module is the translation
// layer the tool gateway consults before executing an agent's tool call:
// it maps the tool being called onto an action class, so the matrix verdict
// can be resolved. The mapping itself is configurable — see
// `server/src/myrmidon/autonomy/tool-mapping.ts` for the settings-backed
// store with the value source (stored settings -> env -> built-in defaults).
//
// Design rules:
// - A tool with no class is not governed by the matrix: it keeps today's
//   behaviour exactly. This is the "everything else -> no class" rule of the
//   design, and it is what keeps the gateway change additive — a tool nobody
//   classified into a class behaves as it did before the matrix existed.
// - Matching is by full tool name first (e.g. the connected-catalog name
//   `mcp.github-abc12345:merge_pull_request`), then by a short suffix match
//   against the upstream tool name (`merge_pull_request`), so a connected
//   GitHub tool is classified without configuring every connection id.
// - Only the three classes named in the design get default tool mappings:
//   merge, external_message, deploy. The other action classes exist in the
//   matrix, but no tool is classified into them by default — an operator adds
//   such a mapping from the settings key.

import type { AutonomyActionClass } from "@paperclipai/shared";

/** Entry shape of the configurable mapping (both the defaults and overrides). */
export interface ToolAutonomyMappingEntry {
  /** Full tool name (`mcp.github-abc:merge_pull_request`) or bare upstream tool name (`merge_pull_request`). */
  tool: string;
  actionClass: AutonomyActionClass;
}

/**
 * Built-in defaults. Kept deliberately small: exactly the three classes the
 * issue names, with the tool-name patterns that identify them in practice.
 */
export const DEFAULT_TOOL_AUTONOMY_MAPPING: ToolAutonomyMappingEntry[] = [
  // --- merge: PR merge/close tools ---
  { tool: "merge_pull_request", actionClass: "merge" },
  { tool: "merge_pr", actionClass: "merge" },
  { tool: "merge", actionClass: "merge" },
  { tool: "update_pull_request", actionClass: "merge" },
  { tool: "update_pull", actionClass: "merge" },
  { tool: "close_pull_request", actionClass: "merge" },
  { tool: "close_pr", actionClass: "merge" },
  { tool: "create_pull_request", actionClass: "merge" },
  { tool: "create_pr", actionClass: "merge" },
  // --- deploy ---
  { tool: "deploy", actionClass: "deploy" },
  { tool: "create_deployment", actionClass: "deploy" },
  { tool: "create_release", actionClass: "deploy" },
  { tool: "publish", actionClass: "deploy" },
  { tool: "promote", actionClass: "deploy" },
  { tool: "rollback_release", actionClass: "deploy" },
  { tool: "kubernetes_apply", actionClass: "deploy" },
  { tool: "helm_upgrade", actionClass: "deploy" },
  { tool: "terraform_apply", actionClass: "deploy" },
  // --- external_message: chat / mail / social publishing ---
  { tool: "send_message", actionClass: "external_message" },
  { tool: "send_chat_message", actionClass: "external_message" },
  { tool: "post_message", actionClass: "external_message" },
  { tool: "create_message", actionClass: "external_message" },
  { tool: "reply_to_message", actionClass: "external_message" },
  { tool: "send_email", actionClass: "external_message" },
  { tool: "create_email", actionClass: "external_message" },
  { tool: "create_issue_comment", actionClass: "external_message" },
  { tool: "create_pull_request_comment", actionClass: "external_message" },
  { tool: "create_pull_request_review_comment", actionClass: "external_message" },
  { tool: "post_tweet", actionClass: "external_message" },
  { tool: "create_post", actionClass: "external_message" },
  { tool: "publish_message", actionClass: "external_message" },
];

function normalizeToolName(toolName: string): string {
  // Connected-catalog gateway names slugify the upstream tool name
  // (`merge_pull_request` -> `merge-pull-request`), so `_` and `-` compare
  // equal: one mapping entry covers both spellings.
  return toolName.trim().toLowerCase().replace(/_/g, "-");
}

/** The bare upstream tool name of a connected-catalog tool name (`mcp.github-abc:merge_pr` -> `merge_pr`), null when the name has no segment after `:`. */
export function upstreamToolNameOf(toolName: string): string | null {
  const separator = toolName.lastIndexOf(":");
  if (separator === -1 || separator === toolName.length - 1) return null;
  return normalizeToolName(toolName.slice(separator + 1));
}

/**
 * Resolve the action class of a tool from a mapping list. Full tool name wins
 * over the bare upstream name; the first matching entry wins within a tier.
 */
export function resolveToolAutonomyClass(
  toolName: string,
  entries: ToolAutonomyMappingEntry[],
): AutonomyActionClass | null {
  const full = normalizeToolName(toolName);
  const upstream = upstreamToolNameOf(toolName);
  for (const entry of entries) {
    if (normalizeToolName(entry.tool) === full) return entry.actionClass;
  }
  if (upstream) {
    for (const entry of entries) {
      if (normalizeToolName(entry.tool) === upstream) return entry.actionClass;
    }
  }
  return null;
}

/** The action class of a tool under the built-in defaults alone. */
export function defaultToolAutonomyClass(toolName: string): AutonomyActionClass | null {
  return resolveToolAutonomyClass(toolName, DEFAULT_TOOL_AUTONOMY_MAPPING);
}
