// server/src/myrmidon/architect-data/mcp.ts
//
// myrmidon(1.6.6 ARCH-DATA): MCP server endpoint for the architect role.
// Provides MCP JSON-RPC 2.0 tools for querying operational metrics.

import { Router } from "express";
import type { Db } from "@myrmidon/db";
import {
  ARCHITECT_DATA_MCP_PATH,
  ARCHITECT_MCP_TOOL_DEFINITIONS,
  ARCHITECT_MCP_TOOLS,
} from "@myrmidon/shared";
import { assertCompanyAccess } from "../../routes/authz.js";
import {
  assertArchitectRoleOrGrant,
  getArchitectDataBundle,
  getChatgptPoolData,
  getHeartbeatRuns,
  getHermesCompressionEvents,
  getLlmCalls,
  type ArchitectDataServiceOptions,
} from "./service.js";

export function myrmidonArchitectDataMcpRoutes(
  db: Db,
  options: ArchitectDataServiceOptions = {},
) {
  const router = Router();

  router.post(ARCHITECT_DATA_MCP_PATH, async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    await assertArchitectRoleOrGrant(req, db, companyId, options.allowedRoles);

    const body = (req.body ?? {}) as {
      jsonrpc?: string;
      id?: unknown;
      method?: string;
      params?: {
        name?: string;
        arguments?: Record<string, unknown>;
      };
    };

    const id = body.id ?? null;
    const sendResult = (result: unknown) => res.json({ jsonrpc: "2.0", id, result });
    const sendError = (code: number, message: string) =>
      res.status(200).json({ jsonrpc: "2.0", id, error: { code, message } });

    // MCP lifecycle: initialize
    if (body.method === "initialize") {
      return sendResult({
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: {
          name: "myrmidon-architect-data",
          version: "1.6.6",
        },
      });
    }

    if (body.method === "notifications/initialized") {
      return res.status(204).end();
    }

    // MCP tools/list
    if (body.method === "tools/list") {
      return sendResult({
        tools: ARCHITECT_MCP_TOOL_DEFINITIONS,
      });
    }

    // MCP tools/call
    if (body.method === "tools/call") {
      const toolName = body.params?.name;
      const args = (body.params?.arguments ?? {}) as Record<string, unknown>;
      const hours = typeof args.hours === "number" ? args.hours : 48;
      const limit = typeof args.limit === "number" ? args.limit : 500;
      const agentId = typeof args.agentId === "string" ? args.agentId : undefined;

      try {
        let toolOutput: unknown;

        switch (toolName) {
          case ARCHITECT_MCP_TOOLS.GET_COMPRESSION_EVENTS: {
            toolOutput = await getHermesCompressionEvents(db, companyId, {
              agentId,
              limit,
              botVolumeRoot: options.botVolumeRoot,
            });
            break;
          }
          case ARCHITECT_MCP_TOOLS.GET_CHATGPT_LIMITS: {
            toolOutput = await getChatgptPoolData({
              hours,
              limit,
              dbPath: options.chatgptUsageDbPath,
            });
            break;
          }
          case ARCHITECT_MCP_TOOLS.GET_LLM_CALLS: {
            toolOutput = await getLlmCalls(db, companyId, {
              hours,
              limit,
              agentId,
            });
            break;
          }
          case ARCHITECT_MCP_TOOLS.GET_HEARTBEAT_RUNS: {
            toolOutput = await getHeartbeatRuns(db, companyId, {
              hours,
              limit,
              agentId,
            });
            break;
          }
          case ARCHITECT_MCP_TOOLS.GET_DATA_BUNDLE: {
            toolOutput = await getArchitectDataBundle(
              db,
              companyId,
              { hours, limit, agentId },
              options,
            );
            break;
          }
          default:
            return sendError(-32601, `Unknown MCP tool: ${toolName}`);
        }

        return sendResult({
          content: [
            {
              type: "text",
              text: JSON.stringify(toolOutput, null, 2),
            },
          ],
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return sendError(-32000, `Tool execution error: ${message}`);
      }
    }

    // Ping
    if (body.method === "ping") {
      return sendResult({});
    }

    return sendError(-32601, `Method not found: ${body.method}`);
  });

  return router;
}
