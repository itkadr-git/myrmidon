# Paperclip MCP Server

Model Context Protocol server for Paperclip.

This package is a thin MCP wrapper over the existing Paperclip REST API. It does
not talk to the database directly and it does not reimplement business logic.

## Authentication

The server reads its configuration from environment variables:

- `PAPERCLIP_API_URL` - Paperclip base URL, for example `http://localhost:3100`
- `PAPERCLIP_API_KEY` - bearer token used for `/api` requests
- `PAPERCLIP_COMPANY_ID` - optional default company for company-scoped tools
- `PAPERCLIP_AGENT_ID` - optional default agent for checkout helpers
- `PAPERCLIP_RUN_ID` - optional run id forwarded on mutating requests

Inside an active heartbeat, Paperclip also injects `PAPERCLIP_RUNTIME_TOOLS_*` variables. They enable the run-scoped `connections_search` and `connection_request` tools and expire with the run.

## Usage

```sh
npx -y @paperclipai/mcp-server
```

Or locally in this repo:

```sh
pnpm --filter @paperclipai/mcp-server build
node packages/mcp-server/dist/stdio.js
```

## Tool Surface

Since 1.7 all board tools are published under `myrmidon*` names. Each old
`paperclip*` name stays callable as a deprecated alias (marked in the tool
description) for exactly one release; update agent skills to the new names.
See [docs/myrmidon/guides/mcp-tool-names.md](../../docs/myrmidon/guides/mcp-tool-names.md).

Run-scoped connection tools (names unchanged):

- `connections_search`
- `connection_request`

Read tools:

- `myrmidonMe`
- `myrmidonInboxLite`
- `myrmidonListAgents`
- `myrmidonListSkills`
- `myrmidonGetAgent`
- `myrmidonListIssues`
- `myrmidonGetIssue`
- `myrmidonGetHeartbeatContext`
- `myrmidonListComments`
- `myrmidonGetComment`
- `myrmidonListIssueApprovals`
- `myrmidonListDocuments`
- `myrmidonGetDocument`
- `myrmidonListDocumentRevisions`
- `myrmidonListProjects`
- `myrmidonGetProject`
- `myrmidonGetIssueWorkspaceRuntime`
- `myrmidonWaitForIssueWorkspaceService`
- `myrmidonListGoals`
- `myrmidonGetGoal`
- `myrmidonListApprovals`
- `myrmidonGetApproval`
- `myrmidonGetApprovalIssues`
- `myrmidonListApprovalComments`

Write tools:

- `myrmidonCreateIssue`
- `myrmidonUpdateIssue`
- `myrmidonCheckoutIssue`
- `myrmidonReleaseIssue`
- `myrmidonAddComment`
- `myrmidonSuggestTasks`
- `myrmidonAskUserQuestions`
- `myrmidonRequestConfirmation`
- `myrmidonRequestCheckboxConfirmation`
- `myrmidonUpsertIssueDocument`
- `myrmidonRestoreIssueDocumentRevision`
- `myrmidonControlIssueWorkspaceServices`
- `myrmidonCreateApproval`
- `myrmidonLinkIssueApproval`
- `myrmidonUnlinkIssueApproval`
- `myrmidonApprovalDecision`
- `myrmidonAddApprovalComment`

Escape hatch:

- `myrmidonApiRequest`

`myrmidonApiRequest` is limited to paths under `/api` and JSON bodies. It is
meant for endpoints that do not yet have a dedicated MCP tool.
