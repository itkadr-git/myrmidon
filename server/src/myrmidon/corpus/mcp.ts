// server/src/myrmidon/corpus/mcp.ts
//
// myrmidon(1.6.6 CORPUS-2.0, part D): the corpus MCP endpoint a bot is pointed
// at — `POST /myrmidon/companies/:companyId/corpus/mcp`.
//
// The endpoint is the same shape as the OCR one, because a bot (or the runtime
// that configures it) already knows that shape: `initialize`, `tools/list`,
// `tools/call` over JSON-RPC, one endpoint per company, resolved per call. What
// is different is the gate. The owner's decision is that the corpus tools appear
// together with the module, so:
//
//   * module off  — `tools/list` answers with an empty list. A bot of an
//     instance that never switched the corpus on sees exactly the tool set it
//     saw before this module existed; nothing to call, nothing to fall back
//     from, which is what shadow mode (OPE-6166) leans on.
//   * module off  — a `tools/call` that names a corpus tool anyway is answered
//     as a *tool result* with `isError` and the stable code `corpus_disabled`, so
//     a bot whose configuration is older than the switch gets a sentence it can
//     report instead of a transport failure it can only retry.
//   * module on, data side missing — `corpus_unavailable`, the same way: the
//     tool surface exists, the answer says why it cannot be served.
//
// The settings are read on every call, so enabling the module takes effect on
// the next call without a restart, and the port is resolved lazily — an instance
// with the module off never needs a working data side to list its tools.
//
// Mounting lives one file up: `corpus/index.ts` builds the deps (the settings
// block read from `instance_settings`, part C's switch) and `app.ts` mounts the
// result next to its own routes. The port over `packages/corpus` arrives through
// `registerCorpusMcpPortProvider`, which part C calls at wiring time — until it
// does, the tools exist and answer `corpus_unavailable`.

import { Router } from "express";
import { assertCompanyAccess } from "../../routes/authz.js";
import {
  CORPUS_MCP_ROUTE,
  CORPUS_MCP_SERVER_NAME,
  type CorpusMcpDeps,
} from "./contract.js";
import { CORPUS_TOOL_NAMES, CorpusError, callCorpusTool, corpusToolDefinitions, isCorpusToolName } from "./tools.js";

/** The MCP protocol revision the endpoint answers with, as the OCR endpoint does. */
const CORPUS_MCP_PROTOCOL_VERSION = "2025-03-26";

/**
 * The company's corpus MCP endpoint. `deps` is the whole world this endpoint
 * has: settings, a lazily resolved port, and nothing else — which is why the
 * suite can drive it over supertest with a fixture port.
 */
export function myrmidonCorpusMcpRoutes(deps: CorpusMcpDeps) {
  const router = Router();

  router.post(CORPUS_MCP_ROUTE, async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const body = (req.body ?? {}) as { id?: unknown; method?: unknown; params?: unknown };
    const id = body.id ?? null;
    const send = (result: unknown) => res.json({ jsonrpc: "2.0", id, result });

    if (body.method === "initialize") {
      return send({
        protocolVersion: CORPUS_MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: CORPUS_MCP_SERVER_NAME, version: "1" },
      });
    }
    if (body.method === "notifications/initialized") return res.status(202).end();
    if (body.method === "tools/list") {
      // The gate: off means no tools at all, not tools that fail.
      const settings = await deps.settings();
      const tools = settings.enabled ? corpusToolDefinitions : [];
      return send({ tools });
    }
    if (body.method !== "tools/call") {
      return res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
    }

    const params = (body.params ?? {}) as { name?: unknown; arguments?: unknown };
    if (!isCorpusToolName(params.name)) {
      return res.json({
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: `Unknown tool: ${String(params.name)}` },
      });
    }
    try {
      const result = await callCorpusTool(params.name, params.arguments ?? {}, {
        settings: await deps.settings(),
        port: await deps.port(companyId),
      });
      return send({ content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result });
    } catch (error) {
      // A failed call is a tool result, not a transport error: the bot sees the
      // stable code and decides (another dataset, a report to its operator)
      // instead of retrying the same call blindly.
      const code = error instanceof CorpusError ? error.code : "query_failed";
      return send({
        isError: true,
        content: [{ type: "text", text: error instanceof Error ? error.message : "Corpus call failed" }],
        structuredContent: { code },
      });
    }
  });

  return router;
}

export { CORPUS_TOOL_NAMES, corpusToolDefinitions };
export type { CorpusMcpDeps };