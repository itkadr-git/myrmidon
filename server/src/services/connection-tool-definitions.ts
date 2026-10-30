import { CONNECTION_REQUEST_TOOL_DESCRIPTION, CONNECTIONS_SEARCH_TOOL_DESCRIPTION } from "@myrmidon/shared";

export const RUNTIME_CONNECTION_TOOL_DEFINITIONS = [
  {
    name: "connections_search",
    description: CONNECTIONS_SEARCH_TOOL_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "connection_request",
    description: CONNECTION_REQUEST_TOOL_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: { service: { type: "string" } },
      required: ["service"],
      additionalProperties: false,
    },
  },
  {
    name: "pull_request_ci_status",
    description: "Get board-verified GitHub check-runs and summary result for the exact head SHA of a pull request. When repository and pullNumber are omitted, defaults to the PR associated with the current issue.",
    inputSchema: {
      type: "object",
      properties: {
        repository: {
          type: "string",
          description: "GitHub repository in owner/repo format, e.g. 'itkadr-git/myrmidon' or 'itkadr-git/myrmidon-deploy'",
        },
        pullNumber: {
          type: "number",
          description: "Pull request number",
        },
      },
      additionalProperties: false,
    },
  },
] as const;

