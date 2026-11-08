// 1.7 REBRAND D: every board MCP tool is published under its `myrmidon*`
// name; the old `paperclip*` names remain callable for exactly one release as
// deprecated aliases bound to the SAME handler, so installed systems and
// agent skills do not break.
//
// The literal old names keep living in `tools.ts` (makeTool calls) on purpose:
// packages/paperclip-runner parses them (name, description, line number) out
// of that file for the capability-inventory contract checks. Renaming the
// literals is the final step when the aliases are removed — see
// docs/myrmidon/guides/mcp-tool-names.md.
import type { ToolDefinition } from "./tools.js";

/** Old vendor-prefixed MCP tool name -> new product-prefixed name. */
export const MYRMIDON_TOOL_NAME_MAP: Readonly<Record<string, string>> = Object.freeze({
  paperclipMe: "myrmidonMe",
  paperclipInboxLite: "myrmidonInboxLite",
  paperclipListAgents: "myrmidonListAgents",
  paperclipListSkills: "myrmidonListSkills",
  paperclipGetAgent: "myrmidonGetAgent",
  paperclipListIssues: "myrmidonListIssues",
  paperclipGetIssue: "myrmidonGetIssue",
  paperclipGetHeartbeatContext: "myrmidonGetHeartbeatContext",
  paperclipListComments: "myrmidonListComments",
  paperclipGetComment: "myrmidonGetComment",
  paperclipListIssueApprovals: "myrmidonListIssueApprovals",
  paperclipListDocuments: "myrmidonListDocuments",
  paperclipGetDocument: "myrmidonGetDocument",
  paperclipListDocumentRevisions: "myrmidonListDocumentRevisions",
  paperclipListProjects: "myrmidonListProjects",
  paperclipGetProject: "myrmidonGetProject",
  paperclipGetIssueWorkspaceRuntime: "myrmidonGetIssueWorkspaceRuntime",
  paperclipControlIssueWorkspaceServices: "myrmidonControlIssueWorkspaceServices",
  paperclipWaitForIssueWorkspaceService: "myrmidonWaitForIssueWorkspaceService",
  paperclipListGoals: "myrmidonListGoals",
  paperclipGetGoal: "myrmidonGetGoal",
  paperclipListApprovals: "myrmidonListApprovals",
  paperclipCreateApproval: "myrmidonCreateApproval",
  paperclipGetApproval: "myrmidonGetApproval",
  paperclipGetApprovalIssues: "myrmidonGetApprovalIssues",
  paperclipListApprovalComments: "myrmidonListApprovalComments",
  paperclipCreateIssue: "myrmidonCreateIssue",
  paperclipUpdateIssue: "myrmidonUpdateIssue",
  paperclipCheckoutIssue: "myrmidonCheckoutIssue",
  paperclipReleaseIssue: "myrmidonReleaseIssue",
  paperclipAddComment: "myrmidonAddComment",
  paperclipSuggestTasks: "myrmidonSuggestTasks",
  paperclipAskUserQuestions: "myrmidonAskUserQuestions",
  paperclipRequestConfirmation: "myrmidonRequestConfirmation",
  paperclipRequestCheckboxConfirmation: "myrmidonRequestCheckboxConfirmation",
  paperclipUpsertIssueDocument: "myrmidonUpsertIssueDocument",
  paperclipRestoreIssueDocumentRevision: "myrmidonRestoreIssueDocumentRevision",
  paperclipLinkIssueApproval: "myrmidonLinkIssueApproval",
  paperclipUnlinkIssueApproval: "myrmidonUnlinkIssueApproval",
  paperclipApprovalDecision: "myrmidonApprovalDecision",
  paperclipAddApprovalComment: "myrmidonAddApprovalComment",
  paperclipApiRequest: "myrmidonApiRequest",
});

export function toMyrmidonToolName(name: string): string {
  return MYRMIDON_TOOL_NAME_MAP[name] ?? name;
}

/**
 * Re-keys each tool definition under its `myrmidon*` name and appends the old
 * `paperclip*` name as a deprecated alias bound to the very same schema and
 * execute reference, so both names hit one handler.
 */
export function withMyrmidonToolNames(tools: readonly ToolDefinition[]): ToolDefinition[] {
  const renamed: ToolDefinition[] = [];
  const aliases: ToolDefinition[] = [];
  for (const tool of tools) {
    const newName = toMyrmidonToolName(tool.name);
    if (newName === tool.name) {
      renamed.push(tool);
      continue;
    }
    renamed.push({ ...tool, name: newName });
    aliases.push({
      ...tool,
      name: tool.name,
      description: `${tool.description} (deprecated alias for ${newName}; will be removed after the 1.7 release)`,
    });
  }
  return [...renamed, ...aliases];
}
