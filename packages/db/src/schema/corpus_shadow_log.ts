// myrmidon(1.6.6-CORPUS-SHADOW A): the shadow log of the corpus module
// comparison (OPE-6166 part A). One row per bot search call that went to the
// RAGFlow MCP tool while `corpus.shadow` was on: both the RAGFlow answer and
// the parallel corpus-module answer are recorded here, the bot always keeps
// receiving the RAGFlow one. Part B (OPE-6166) computes the switch-over
// report (p95 latency per branch, empty-result share) from this table; the
// column contract is frozen by the OPE-6171 ticket.
import { pgTable, uuid, text, integer, timestamp, jsonb, index } from "drizzle-orm/pg-core";

export const corpusShadowLog = pgTable(
  "corpus_shadow_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    /** Agent id of the bot whose run made the search call (null when the gateway session has no agent). */
    botId: text("bot_id"),
    /** Knowledge-base / dataset name the query was aimed at. */
    dataset: text("dataset"),
    /** Raw query text of the search call. */
    query: text("query"),
    /** Ordered list of top-N chunk ids returned by RAGFlow (JSONB array of strings). */
    ragflowChunkIds: jsonb("ragflow_chunk_ids"),
    /** End-to-end latency of the RAGFlow MCP call, ms. */
    ragflowLatencyMs: integer("ragflow_latency_ms"),
    /** Ordered list of top-N chunk ids returned by the corpus module (JSONB array of strings). */
    moduleChunkIds: jsonb("module_chunk_ids"),
    /** Latency of the corpus-module search call, ms. */
    moduleLatencyMs: integer("module_latency_ms"),
    /** Null on a clean module call; the error text when the module leg failed. */
    moduleError: text("module_error"),
  },
  (table) => ({
    tsIdx: index("corpus_shadow_log_ts_idx").on(table.ts),
  }),
);
