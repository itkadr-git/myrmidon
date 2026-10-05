import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PaperclipApiClient } from "./client.js";
import { readConfigFromEnv, type PaperclipMcpConfig } from "./config.js";
import { createToolDefinitions } from "./tools.js";
import { withMyrmidonToolNames } from "./tool-aliases.js";

export function createPaperclipMcpServer(config: PaperclipMcpConfig = readConfigFromEnv()) {
  const server = new McpServer({
    name: "paperclip",
    version: "0.1.0",
  });

  const client = new PaperclipApiClient(config);
  // REBRAND D: the tool list is published under `myrmidon*` names; each old
  // `paperclip*` name stays registered as a deprecated alias bound to the
  // same handler for one release. `createToolDefinitions` itself keeps the
  // vendor names untouched because packages/paperclip-runner parses its
  // `makeTool` literals (names, descriptions, line anchors) for the
  // capability-inventory contract checks.
  const tools = withMyrmidonToolNames(createToolDefinitions(client));
  for (const tool of tools) {
    server.tool(tool.name, tool.description, tool.schema.shape, tool.execute);
  }

  return {
    server,
    tools,
    client,
  };
}

export async function runServer(config: PaperclipMcpConfig = readConfigFromEnv()) {
  const { server } = createPaperclipMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
