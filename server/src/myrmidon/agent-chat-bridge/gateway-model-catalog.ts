// myrmidon(F06-A): the model catalog behind the Telegram bridge's `/model` for
// a gateway adapter (hermes_gateway) — the choices a chat of such an agent can
// actually pick.
//
// Two tiers, narrowest first:
//   1. this agent's own gateway key against `/v1/models`: that key's allowlist,
//      i.e. the models this agent may run at all. myrmidon(F06-D): "this
//      agent's key" is the key the bot really sends — the card's own binding of
//      MYRMIDON_BOT_LLM_API_KEY_ENV, else the shared company secret (the same
//      precedence the profile compiler uses, litellm-costs/bot-keys.ts) — and
//      only then the minted per-agent secret `llm-gateway-key-<name>-<id>`.
//      The first version looked up only that minted secret, which the bot
//      profile never uses, so on a fleet without minted keys this tier always
//      came back empty and `/model` silently listed the whole catalog;
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
import { logger } from "../../middleware/logger.js";
import { redactSensitiveText } from "../../redaction.js";
import { secretService } from "../../services/index.js";
import { readGatewayBotKeySettings, resolveGatewayBotKeys } from "../litellm-costs/bot-keys.js";
import {
  createLitellmGatewayClient,
  listLitellmModels,
  type LitellmGatewayClient,
} from "../litellm-costs/litellm-costs.js";
import type {
  ChatModelCatalog,
  ChatModelCatalogReader,
  GatewayCatalogKeyFailure,
} from "./commands/models.js";

export interface GatewayModelCatalogDeps {
  db: Db;
  companyId: string;
  agentId: string;
  /** `agents.name` — an agent's own key is stored under its id and slug
   *  (agent-keys.ts), so both are needed to name the secret. */
  agentSlug: string | null;
  /** myrmidon(F06-D): the agent's adapter type and card config — the card's own
   *  key binding is where a bot's gateway key really comes from. */
  adapterType?: string;
  adapterConfig?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
  /** Injected in tests: the secret store read (the real one is the secrets service). */
  readSecretValue?: (companyId: string, secretName: string) => Promise<string | null>;
  /** Injected in tests: the key the card's own binding (else the shared
   *  company secret) resolves to; the real one goes through the secrets service. */
  readCardKey?: (input: { companyId: string; agentId: string; adapterType: string; adapterConfig: Record<string, unknown> }) => Promise<string | null>;
  /** Injected in tests: the gateway client, so no HTTP happens. */
  client?: Pick<LitellmGatewayClient, "listAvailableModels">;
  /** Injected in tests: builds the client for a resolved key. */
  clientFor?: (baseUrl: string, key: string) => Pick<LitellmGatewayClient, "listAvailableModels">;
  /** Injected in tests: the collected catalog rows. */
  readCollectedModels?: (db: Db) => Promise<Array<{ modelName: string; provider?: string | null; mode?: string | null }>>;
}

/** myrmidon(F06-A): the reader the chooser commands and `/new` pass down. */
export function createGatewayModelCatalogReader(deps: GatewayModelCatalogDeps): ChatModelCatalogReader {
  return () => readGatewayModelCatalog(deps);
}

/**
 * myrmidon(F06-A): this agent's own key allowlist if it can be read, otherwise
 * the collected catalog (marked as the whole catalog, with the reason the
 * per-key read was not available), otherwise null — the card's own values are
 * then all `/model` has.
 */
export async function readGatewayModelCatalog(deps: GatewayModelCatalogDeps): Promise<ChatModelCatalog | null> {
  const fromAgentKey = await readAgentKeyCatalog(deps);
  if (fromAgentKey.catalog) {
    // myrmidon(F06-D): `/v1/models` names the models but not what they do. The
    // board's collected catalog knows each model's family and declared mode, so
    // the chat-model filter reads them from there when it can (fail-soft: a
    // model the collection does not know falls back to the id rules).
    const collected = await readCollectedCatalog(deps);
    return collected
      ? { ...fromAgentKey.catalog, providers: collected.providers, modes: collected.modes }
      : fromAgentKey.catalog;
  }
  // myrmidon(F06-D): the per-key read used to fail without a trace. The reason
  // code is logged (never a key or a response body) and travels with the
  // fallback catalog so the reply can name it.
  logger.warn(
    {
      companyId: deps.companyId,
      agentId: deps.agentId,
      reason: fromAgentKey.failure,
      ...(fromAgentKey.detail ? { detail: fromAgentKey.detail } : {}),
    },
    "myrmidon(F06-D): /model could not read the agent's own gateway model list; falling back to the collected catalog",
  );
  const collected = await readCollectedCatalog(deps);
  return collected ? { ...collected, keyFailure: fromAgentKey.failure } : null;
}

type AgentKeyRead =
  | { catalog: ChatModelCatalog; failure?: undefined; detail?: undefined }
  | { catalog?: undefined; failure: GatewayCatalogKeyFailure; detail?: string };

function safeDetail(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return redactSensitiveText(text).slice(0, 200);
}

/**
 * The key this agent's bot sends to the gateway: the card's own binding, else
 * the shared company secret (what the profile compiler does), else the minted
 * per-agent secret. A failure to read a secret is reported, not swallowed.
 */
async function resolveAgentGatewayKey(
  deps: GatewayModelCatalogDeps,
): Promise<{ key: string } | { failure: GatewayCatalogKeyFailure; detail?: string }> {
  const env = deps.env ?? process.env;
  const readSecret = deps.readSecretValue ?? defaultReadSecretValue(deps.db);
  const readCardKey = deps.readCardKey ?? defaultReadCardKey(deps.db, env);

  let cardError: unknown = null;
  try {
    const fromCard = (
      await readCardKey({
        companyId: deps.companyId,
        agentId: deps.agentId,
        adapterType: deps.adapterType ?? "hermes_gateway",
        adapterConfig: deps.adapterConfig ?? {},
      })
    )?.trim();
    if (fromCard) return { key: fromCard };
  } catch (error) {
    cardError = error;
  }

  const secretName = agentKeySecretName({ agentId: deps.agentId, agentSlug: deps.agentSlug });
  try {
    const minted = (await readSecret(deps.companyId, secretName))?.trim();
    if (minted) return { key: minted };
  } catch (error) {
    return { failure: "secret_error", detail: safeDetail(error) };
  }
  if (cardError) return { failure: "secret_error", detail: safeDetail(cardError) };
  return { failure: "no_key" };
}

/** `/v1/models` with the agent's own key — the models that key may run. */
async function readAgentKeyCatalog(deps: GatewayModelCatalogDeps): Promise<AgentKeyRead> {
  const settings = readGatewayKeySettings(deps.env ?? process.env);
  if (!settings.baseUrl) return { failure: "no_gateway_url" };

  const resolved = await resolveAgentGatewayKey(deps);
  if (!("key" in resolved)) return resolved;

  const client =
    deps.client ??
    (deps.clientFor ?? createLitellmGatewayClient)(settings.baseUrl, resolved.key);
  try {
    const models = await client.listAvailableModels();
    const cleaned: string[] = [];
    for (const model of models) {
      const id = model.trim();
      if (id) cleaned.push(id);
    }
    if (cleaned.length === 0) return { failure: "empty_list" };
    return { catalog: { models: cleaned, scope: "agentKey" } };
  } catch (error) {
    // Unreachable gateway, a key the gateway refuses, or an endpoint that is
    // not a model list at all: the collected catalog answers, and the reply
    // says it is the whole one — and why.
    return { failure: "gateway_error", detail: safeDetail(error) };
  }
}

/** The catalog the board collects (the cost sweep's rows) — every model the
 *  gateway serves, not just this agent's. */
async function readCollectedCatalog(deps: GatewayModelCatalogDeps): Promise<ChatModelCatalog | null> {
  let rows: Array<{ modelName: string; provider?: string | null; mode?: string | null }> = [];
  try {
    rows = await (deps.readCollectedModels ?? listLitellmModels)(deps.db);
  } catch {
    return null;
  }

  const models: string[] = [];
  const providers: Record<string, string> = {};
  const modes: Record<string, string> = {};
  const seen = new Set<string>();
  for (const row of rows) {
    const id = row.modelName?.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push(id);
    const provider = typeof row.provider === "string" ? row.provider.trim() : "";
    if (provider) providers[id] = provider;
    const mode = typeof row.mode === "string" ? row.mode.trim().toLowerCase() : "";
    if (mode) modes[id] = mode;
  }
  if (models.length === 0) return null;
  return { models, providers, modes, scope: "catalog" };
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

/** myrmidon(F06-D): the card's own key, resolved as the profile compiler would. */
function defaultReadCardKey(db: Db, env: NodeJS.ProcessEnv): NonNullable<GatewayModelCatalogDeps["readCardKey"]> {
  return async (input) => {
    const secrets = secretService(db);
    const keys = await resolveGatewayBotKeys(
      input.companyId,
      [{ agentId: input.agentId, adapterType: input.adapterType, adapterConfig: input.adapterConfig }],
      readGatewayBotKeySettings(env),
      {
        resolveSecretById: (companyId, secretId, version) => secrets.resolveSecretValue(companyId, secretId, version),
        async readSecretByName(companyId, name) {
          const row = await secrets.getByName(companyId, name);
          return row ? secrets.resolveSecretValue(companyId, row.id, "latest") : null;
        },
      },
    );
    return keys.find((entry) => entry.agentId === input.agentId)?.keyValue ?? null;
  };
}
