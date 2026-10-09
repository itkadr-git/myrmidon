// myrmidon(F06-A): the model catalog behind the Telegram bridge's `/model` for
// a gateway adapter (hermes_gateway) — the choices a chat of such an agent can
// actually pick.
//
// Two tiers, narrowest first:
//   1. this agent's own gateway key against `/v1/models`: that key's allowlist,
//      i.e. the models this agent may run at all;
//   2. the gateway catalog the board already collects into its own table (the
//      cost sweep's rows), used when the per-key read is not available — no key
//      on the board, gateway unreachable, or a gateway without `/v1/models`.
//      That list is a superset of one agent's, so the reply marks it as the
//      whole catalog (`scope: "catalog"`).
// The per-key read goes through the LLM gateway client the cost module already
// owns (same base URL, same secret store) instead of a second HTTP path.
// This is a fork-owned module (server/src/myrmidon/...).

import type { Db } from "@paperclipai/db";
import { agentKeySecretName, readGatewayKeySettings } from "@paperclipai/shared";
import { secretService } from "../../services/index.js";
import {
  createLitellmGatewayClient,
  listLitellmModels,
  type LitellmGatewayClient,
} from "../litellm-costs/litellm-costs.js";
import type { ChatModelCatalog, ChatModelCatalogReader } from "./commands/models.js";

export interface GatewayModelCatalogDeps {
  db: Db;
  companyId: string;
  agentId: string;
  /** `agents.name` — an agent's own key is stored under its id and slug
   *  (agent-keys.ts), so both are needed to name the secret. */
  agentSlug: string | null;
  env?: NodeJS.ProcessEnv;
  /** Injected in tests: the secret store read (the real one is the secrets service). */
  readSecretValue?: (companyId: string, secretName: string) => Promise<string | null>;
  /** Injected in tests: the gateway client, so no HTTP happens. */
  client?: Pick<LitellmGatewayClient, "listAvailableModels">;
  /** Injected in tests: the collected catalog rows. */
  readCollectedModels?: (db: Db) => Promise<Array<{ modelName: string; provider?: string | null }>>;
}

/** myrmidon(F06-A): the reader the chooser commands and `/new` pass down. */
export function createGatewayModelCatalogReader(deps: GatewayModelCatalogDeps): ChatModelCatalogReader {
  return () => readGatewayModelCatalog(deps);
}

/**
 * myrmidon(F06-A): this agent's own key allowlist if it can be read, otherwise
 * the collected catalog (marked as the whole catalog), otherwise null — the
 * card's own values are then all `/model` has.
 */
export async function readGatewayModelCatalog(deps: GatewayModelCatalogDeps): Promise<ChatModelCatalog | null> {
  const fromAgentKey = await readAgentKeyCatalog(deps);
  if (fromAgentKey) return fromAgentKey;
  return readCollectedCatalog(deps);
}

/** `/v1/models` with the agent's own key — the models that key may run. */
async function readAgentKeyCatalog(deps: GatewayModelCatalogDeps): Promise<ChatModelCatalog | null> {
  const settings = readGatewayKeySettings(deps.env ?? process.env);
  if (!settings.baseUrl) return null;

  const secretName = agentKeySecretName({ agentId: deps.agentId, agentSlug: deps.agentSlug });
  let keyValue: string | null = null;
  try {
    keyValue = await (deps.readSecretValue ?? defaultReadSecretValue(deps.db))(deps.companyId, secretName);
  } catch {
    return null;
  }
  const trimmedKey = keyValue?.trim();
  if (!trimmedKey) return null;

  const client = deps.client ?? createLitellmGatewayClient(settings.baseUrl, trimmedKey);
  try {
    const models = await client.listAvailableModels();
    const cleaned: string[] = [];
    for (const model of models) {
      const id = model.trim();
      if (id) cleaned.push(id);
    }
    if (cleaned.length === 0) return null;
    return { models: cleaned, scope: "agentKey" };
  } catch {
    // Unreachable gateway, or an endpoint that is not a model list at all: the
    // collected catalog below answers, and the reply says it is the whole one.
    return null;
  }
}

/** The catalog the board collects (the cost sweep's rows) — every model the
 *  gateway serves, not just this agent's. */
async function readCollectedCatalog(deps: GatewayModelCatalogDeps): Promise<ChatModelCatalog | null> {
  let rows: Array<{ modelName: string; provider?: string | null }> = [];
  try {
    rows = await (deps.readCollectedModels ?? listLitellmModels)(deps.db);
  } catch {
    return null;
  }

  const models: string[] = [];
  const providers: Record<string, string> = {};
  const seen = new Set<string>();
  for (const row of rows) {
    const id = row.modelName?.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push(id);
    const provider = typeof row.provider === "string" ? row.provider.trim() : "";
    if (provider) providers[id] = provider;
  }
  if (models.length === 0) return null;
  return { models, providers, scope: "catalog" };
}

/** The real secret read — the same two calls agent-keys.ts makes for an
 *  agent's gateway key. */
function defaultReadSecretValue(db: Db) {
  return async (companyId: string, secretName: string): Promise<string | null> => {
    const secrets = secretService(db);
    const row = await secrets.getByName(companyId, secretName);
    return row ? secrets.resolveSecretValue(companyId, row.id, "latest") : null;
  };
}