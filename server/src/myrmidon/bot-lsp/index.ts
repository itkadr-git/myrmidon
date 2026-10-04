// Bot language-server policy (myrmidon BOT-LSP-DEFAULTS) entry point.
//
// No startup apply and no live object: the profile compiler re-reads the
// settings row on every reconcile tick (profile-ports.ts botLsp). Wired here:
// the routes and the read-only walk over the container bots the view reports.

import { agents as agentsTable, type Db } from "@paperclipai/db";
import { and, eq, ne, sql } from "drizzle-orm";
import { HERMES_GATEWAY_ADAPTER_TYPE } from "../bot-containers/agents-query.js";
import { botLspRoutes } from "./routes.js";
import { botLspService, type BotLspService } from "./service.js";

export { botLspService, BOT_LSP_ACTION, mergeBotLspSettings } from "./service.js";
export type { BotLspService, BotLspView } from "./service.js";

/** Router for app.ts: GET/PATCH /api/myrmidon/bot-lsp. */
export function myrmidonBotLspRoutes(db: Db) {
  const service: BotLspService = botLspService(db, {
    // Every live hermes_gateway agent across companies (the setting is
    // instance-level). Only the card's `lsp` block is read, not the whole card.
    listBots: async () =>
      db
        .select({
          id: agentsTable.id,
          name: agentsTable.name,
          role: agentsTable.role,
          lsp: sql<unknown>`${agentsTable.adapterConfig} -> 'lsp'`.mapWith(agentsTable.adapterConfig),
        })
        .from(agentsTable)
        .where(and(eq(agentsTable.adapterType, HERMES_GATEWAY_ADAPTER_TYPE), ne(agentsTable.status, "terminated")))
        .then((rows) =>
          rows.map((row) => ({
            id: row.id,
            name: row.name,
            role: row.role,
            adapterConfig: row.lsp === null || row.lsp === undefined ? {} : { lsp: row.lsp },
          })),
        ),
  });
  return botLspRoutes(db, service);
}
