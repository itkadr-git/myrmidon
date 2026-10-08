// server/src/myrmidon/corpus/index.ts
//
// myrmidon(1.6.6 CORPUS-2.0, part D): what the server mounts, and the one hook
// the data side uses to reach the tools.
//
// `app.ts` mounts `myrmidonCorpusRoutes(db)`; the endpoint behind it is in
// `mcp.ts`. Two things have to come from outside: the module's switch, which
// lives in `instance_settings.general.corpus` (part C writes it, part E edits
// it), and the port over the corpus itself. The switch is read here, per call,
// straight from the row, so switching the module on takes effect without a
// restart. The port arrives through `registerCorpusMcpPortProvider`, called once
// by part C when its adapter over parts A and B is ready — until then the tools
// answer `corpus_unavailable` rather than pretending the corpus is empty.
//
// Nothing here touches the corpus or the network at import time: an instance
// that never enables the module pays one row read per MCP call and nothing else.

import { instanceSettings, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import type { CorpusMcpDeps, CorpusMcpPort, CorpusMcpPortProvider } from "./contract.js";
import { myrmidonCorpusMcpRoutes } from "./mcp.js";
import { CORPUS_SETTINGS_KEY, readCorpusModuleSettings } from "./settings.js";

/** The instance settings row the module's block lives in. */
const CORPUS_SETTINGS_ROW_KEY = "default";

let portProvider: CorpusMcpPortProvider | null = null;

/**
 * Hands the tools the company's corpus: part C calls this once, at wiring time,
 * with its adapter over `packages/corpus`. `null` (the default) means the data
 * side is not there, which the tools report as `corpus_unavailable`.
 */
export function registerCorpusMcpPortProvider(next: CorpusMcpPortProvider | null): void {
  portProvider = next;
}

/**
 * The endpoint's whole world: the stored switch, read per call, and the port the
 * data side registered. `options.port` lets a caller hand one in directly — the
 * embedded-database suite wires the fixture this way, and part C may prefer it
 * to the registry.
 */
export function myrmidonCorpusMcpDeps(
  db: Db,
  options: { port?: CorpusMcpPortProvider } = {},
): CorpusMcpDeps {
  return {
    settings: async () => {
      const row = await db
        .select({ general: instanceSettings.general })
        .from(instanceSettings)
        .where(eq(instanceSettings.singletonKey, CORPUS_SETTINGS_ROW_KEY))
        .then((rows) => rows[0] ?? null);
      return readCorpusModuleSettings(row?.general?.[CORPUS_SETTINGS_KEY]);
    },
    port: async (companyId: string): Promise<CorpusMcpPort | null> => {
      const resolve = options.port ?? portProvider;
      if (!resolve) return null;
      return resolve(companyId);
    },
  };
}

/** The company's corpus MCP endpoint, with the stored switch and the registered port. */
export function myrmidonCorpusRoutes(db: Db, options: { port?: CorpusMcpPortProvider } = {}) {
  return myrmidonCorpusMcpRoutes(myrmidonCorpusMcpDeps(db, options));
}

export { CORPUS_MCP_ROUTE } from "./contract.js";
export { myrmidonCorpusMcpRoutes } from "./mcp.js";
export type { CorpusMcpDeps, CorpusMcpPort, CorpusMcpPortProvider } from "./contract.js";