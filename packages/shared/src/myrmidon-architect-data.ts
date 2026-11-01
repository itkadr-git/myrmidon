// packages/shared/src/myrmidon-architect-data.ts
//
// myrmidon(1.6.6 ARCH-DATA): read-only product access for the architect role
// (and configured allowed roles) to full operational metrics without secrets:
// 1. Hermes context compression events from agent logs
// 2. ChatGPT pool router limits & requests from sqlite /stats/usage.db
// 3. LiteLLM model spend calls without text bodies
// 4. Board heartbeat runs
//
// Shared contracts, types, Zod schemas, constants, and secret-scrubbing rules.

import { z } from "zod";

/** Default roles granted read-only access to architect data */
export const ARCHITECT_DATA_DEFAULT_ALLOWED_ROLES = ["architect"] as const;

/** API base route pattern */
export const ARCHITECT_DATA_API_BASE = "/myrmidon/companies/:companyId/architect-data";

/** MCP JSON-RPC endpoint pattern */
export const ARCHITECT_DATA_MCP_PATH = "/myrmidon/companies/:companyId/architect-data/mcp";

/** Secret scrubbing patterns to guarantee no secrets leak into product metrics */
const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /pcp_[A-Za-z0-9_\-]+/g,
  /sk-[A-Za-z0-9_\-]{20,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /(?:api[_-]?key|secret|token|password|auth(?:orization)?)\s*[:=]\s*["']?([A-Za-z0-9\-._~+/]{8,})["']?/gi,
];

/** Scrub all secrets and tokens from text strings */
export function scrubSecrets(input: string): string {
  if (!input) return "";
  let result = input;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, (match) => {
      if (match.toLowerCase().startsWith("bearer ")) {
        return "Bearer [REDACTED]";
      }
      return "[REDACTED]";
    });
  }
  return result;
}

/** 1. Hermes compression event */
export const hermesCompressionEventSchema = z.object({
  agent: z.string(),
  line: z.string(),
  timestamp: z.string().nullable().optional(),
});
export type HermesCompressionEvent = z.infer<typeof hermesCompressionEventSchema>;

/** 2. ChatGPT pool router limits */
export const chatgptPoolLimitSchema = z.object({
  acc: z.string(),
  ts: z.union([z.number(), z.string()]),
  plan: z.string().nullable().optional(),
  active_limit: z.number().nullable().optional(),
  p_used: z.number().nullable().optional(),
  p_window_min: z.number().nullable().optional(),
  p_reset_at: z.union([z.number(), z.string()]).nullable().optional(),
  s_used: z.number().nullable().optional(),
  s_window_min: z.number().nullable().optional(),
  s_reset_at: z.union([z.number(), z.string()]).nullable().optional(),
});
export type ChatgptPoolLimit = z.infer<typeof chatgptPoolLimitSchema>;

export const chatgptPoolReqSchema = z.object({
  id: z.union([z.number(), z.string()]).nullable().optional(),
  acc: z.string().nullable().optional(),
  ts: z.union([z.number(), z.string()]),
  model: z.string().nullable().optional(),
  status: z.union([z.number(), z.string()]).nullable().optional(),
});
export type ChatgptPoolReq = z.infer<typeof chatgptPoolReqSchema>;

export const chatgptPoolDataSchema = z.object({
  limits: z.array(chatgptPoolLimitSchema),
  reqs: z.array(chatgptPoolReqSchema),
});
export type ChatgptPoolData = z.infer<typeof chatgptPoolDataSchema>;

/** 3. LiteLLM model spend calls (strictly without text payloads or API keys) */
export const llmSpendCallSchema = z.object({
  agentId: z.string().nullable().optional(),
  issueId: z.string().nullable().optional(),
  heartbeatRunId: z.string().nullable().optional(),
  provider: z.string().nullable().optional(),
  model: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  costCents: z.number(),
  occurredAt: z.string(),
  requestId: z.string().nullable().optional(),
  spend: z.number().nullable().optional(),
});
export type LlmSpendCall = z.infer<typeof llmSpendCallSchema>;

/** 4. Board heartbeat runs */
export const heartbeatRunSummarySchema = z.object({
  id: z.string(),
  agentId: z.string(),
  status: z.string(),
  startedAt: z.string().nullable().optional(),
  finishedAt: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type HeartbeatRunSummary = z.infer<typeof heartbeatRunSummarySchema>;

/** Complete bundle containing all four metrics sources */
export const architectDataBundleSchema = z.object({
  compressionEvents: z.array(hermesCompressionEventSchema),
  chatgptPool: chatgptPoolDataSchema,
  llmCalls: z.array(llmSpendCallSchema),
  heartbeatRuns: z.array(heartbeatRunSummarySchema),
  collectedAt: z.string(),
});
export type ArchitectDataBundle = z.infer<typeof architectDataBundleSchema>;

/** Query options for filtering and pagination */
export const architectDataQuerySchema = z.object({
  hours: z.coerce.number().int().min(1).max(720).optional().default(48),
  limit: z.coerce.number().int().min(1).max(2000).optional().default(500),
  agentId: z.string().optional(),
});
export type ArchitectDataQuery = z.infer<typeof architectDataQuerySchema>;

/** MCP Tool Names */
export const ARCHITECT_MCP_TOOLS = {
  GET_COMPRESSION_EVENTS: "architect_get_compression_events",
  GET_CHATGPT_LIMITS: "architect_get_chatgpt_limits",
  GET_LLM_CALLS: "architect_get_llm_calls",
  GET_HEARTBEAT_RUNS: "architect_get_heartbeat_runs",
  GET_DATA_BUNDLE: "architect_get_data_bundle",
} as const;

export const ARCHITECT_MCP_TOOL_DEFINITIONS = [
  {
    name: ARCHITECT_MCP_TOOLS.GET_COMPRESSION_EVENTS,
    description:
      "Get Hermes context compression/compaction events from bot logs for non-deleted agents (read-only, secret-free).",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "Optional filter by agent ID or name" },
        limit: { type: "integer", description: "Maximum lines to return (default: 500, max: 2000)" },
      },
    },
  },
  {
    name: ARCHITECT_MCP_TOOLS.GET_CHATGPT_LIMITS,
    description:
      "Get ChatGPT pool channel limits and usage requests for the last 48 hours from usage.db (read-only, secret-free).",
    inputSchema: {
      type: "object",
      properties: {
        hours: { type: "integer", description: "Lookback window in hours (default: 48, max: 720)" },
        limit: { type: "integer", description: "Maximum records to return (default: 500, max: 2000)" },
      },
    },
  },
  {
    name: ARCHITECT_MCP_TOOLS.GET_LLM_CALLS,
    description:
      "Get LiteLLM model calls and token spend logs without text payloads or keys (read-only, secret-free).",
    inputSchema: {
      type: "object",
      properties: {
        hours: { type: "integer", description: "Lookback window in hours (default: 48, max: 720)" },
        limit: { type: "integer", description: "Maximum records to return (default: 500, max: 2000)" },
        agentId: { type: "string", description: "Optional agent ID filter" },
      },
    },
  },
  {
    name: ARCHITECT_MCP_TOOLS.GET_HEARTBEAT_RUNS,
    description:
      "Get board heartbeat runs with status, execution timing, and error details (read-only, secret-free).",
    inputSchema: {
      type: "object",
      properties: {
        hours: { type: "integer", description: "Lookback window in hours (default: 48, max: 720)" },
        limit: { type: "integer", description: "Maximum runs to return (default: 500, max: 2000)" },
        agentId: { type: "string", description: "Optional agent ID filter" },
      },
    },
  },
  {
    name: ARCHITECT_MCP_TOOLS.GET_DATA_BUNDLE,
    description:
      "Get all operational data sources bundled together in one call: compression logs, pool limits, LLM calls, and runs.",
    inputSchema: {
      type: "object",
      properties: {
        hours: { type: "integer", description: "Lookback window in hours (default: 48, max: 720)" },
        limit: { type: "integer", description: "Maximum records per source (default: 500, max: 2000)" },
      },
    },
  },
];
