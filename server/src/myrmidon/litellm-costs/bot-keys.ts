// server/src/myrmidon/litellm-costs/bot-keys.ts
//
// myrmidon(M2-A): the bot gateway keys of a company, for spend attribution.
//
// Each bot's LLM gateway key reaches its hermes/.env under the env name the
// instance configured (MYRMIDON_BOT_LLM_API_KEY_ENV). The profile compiler
// takes the value from the card's own env binding of that name first and only
// falls back to the shared company secret (MYRMIDON_BOT_LLM_API_KEY_SECRET,
// falling back to the env name itself) when the card binds no value. This
// module follows the same precedence, per card that goes through the gateway,
// and hands back agentId + value; the sweep hashes it and matches the gateway
// ledger's api_key.
//
// myrmidon(M2-A secret_ref): the card's binding is normally a `secret_ref`
// ({ type: "secret_ref", secretId, version }), one company secret per bot, not
// an inline value. It is resolved here by secretId + version, the same
// reference the bot's container is compiled from (card-env.ts), so the hash is
// the hash of the key the bot really sends. A binding that cannot be resolved
// (deleted, inactive or foreign secret) skips the card: the bot cannot run on
// it either, and attributing its spend to the shared key would be a guess.
//
// Resolution goes through the secrets service without a binding context on
// purpose: the same "no audit event per secret per minute" rule the bot
// reconciler follows (profile-ports.ts) — this sweep runs on a timer too. The
// service still refuses a secret of another company. The key values never
// leave this process's memory and are never logged.

import { and, eq, ne } from "drizzle-orm";
import { agents, type Db } from "@paperclipai/db";
import { secretService } from "../../services/index.js";
import { cardUsesLlmGateway } from "../bot-containers/profile-input.js";

export const BOT_LLM_API_KEY_ENV_ENV = "MYRMIDON_BOT_LLM_API_KEY_ENV";
export const BOT_LLM_API_KEY_SECRET_ENV = "MYRMIDON_BOT_LLM_API_KEY_SECRET";

export interface GatewayBotKey {
  agentId: string;
  keyValue: string;
}

/** A bot card as the resolver needs it. */
export interface GatewayBotCard {
  agentId: string;
  adapterType: string;
  adapterConfig: unknown;
}

/** The secrets the resolver reads. Implemented over the secrets service; faked in tests. */
export interface GatewayBotKeyPorts {
  /** A secret's value by id and version; throws when it cannot be resolved (missing, inactive, foreign). */
  resolveSecretById(companyId: string, secretId: string, version: number | "latest"): Promise<string>;
  /** A company secret's latest value by name; null when there is no such secret. */
  readSecretByName(companyId: string, name: string): Promise<string | null>;
}

export interface GatewayBotKeySettings {
  /** MYRMIDON_BOT_LLM_API_KEY_ENV: the env name that carries the key; null = no key to attribute by. */
  keyEnv: string | null;
  /** MYRMIDON_BOT_LLM_API_KEY_SECRET, else keyEnv: the shared company secret. */
  keySecret: string | null;
}

export function readGatewayBotKeySettings(env: NodeJS.ProcessEnv): GatewayBotKeySettings {
  const keyEnv = env[BOT_LLM_API_KEY_ENV_ENV]?.trim() || null;
  const keySecret = env[BOT_LLM_API_KEY_SECRET_ENV]?.trim() || keyEnv;
  return { keyEnv, keySecret };
}

/**
 * agentId + gateway key value for every card of the company that goes
 * through the gateway. A card with its own provider has no gateway key and
 * is skipped (its spend never appears in the gateway ledger under our keys).
 */
export async function listGatewayBotKeys(
  db: Db,
  companyId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<GatewayBotKey[]> {
  const secrets = secretService(db);
  const rows = await db
    .select({
      agentId: agents.id,
      adapterType: agents.adapterType,
      adapterConfig: agents.adapterConfig,
    })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated")));

  return resolveGatewayBotKeys(companyId, rows, readGatewayBotKeySettings(env), {
    resolveSecretById: (id, secretId, version) => secrets.resolveSecretValue(id, secretId, version),
    async readSecretByName(id, name) {
      const secretRow = await secrets.getByName(id, name);
      if (!secretRow) return null;
      return secrets.resolveSecretValue(id, secretRow.id, "latest");
    },
  });
}

/** The pure core of {@link listGatewayBotKeys}: cards in, agentId + key value out. */
export async function resolveGatewayBotKeys(
  companyId: string,
  cards: readonly GatewayBotCard[],
  settings: GatewayBotKeySettings,
  ports: GatewayBotKeyPorts,
): Promise<GatewayBotKey[]> {
  const result: GatewayBotKey[] = [];
  // The shared secret is the same for every card: read it at most once per pass.
  let shared: Promise<string | null> | null = null;
  const readShared = () => {
    if (!settings.keySecret) return Promise.resolve(null);
    shared ??= ports.readSecretByName(companyId, settings.keySecret).catch(() => null);
    return shared;
  };

  for (const card of cards) {
    if (card.adapterType !== "hermes_gateway") continue;
    const config = asRecord(card.adapterConfig);
    if (!config || !cardUsesLlmGateway(config)) continue;
    if (!settings.keyEnv) continue; // the compiler gives such a bot no gateway key either

    // A card's own env binding wins (the profile compiler's precedence).
    const own = await resolveCardBinding(companyId, asRecord(config.env)?.[settings.keyEnv], ports);
    if (own === UNRESOLVABLE) continue;
    if (own) {
      result.push({ agentId: card.agentId, keyValue: own });
      continue;
    }
    const value = (await readShared())?.trim();
    if (value) result.push({ agentId: card.agentId, keyValue: value });
  }
  return result;
}

const UNRESOLVABLE = Symbol("unresolvable");

/**
 * The card's binding of the key env name, as the compiler would see it:
 * the value, "" when the card binds nothing usable (the compiler then takes the
 * shared secret), or UNRESOLVABLE when it names a secret that cannot be read.
 */
async function resolveCardBinding(
  companyId: string,
  binding: unknown,
  ports: GatewayBotKeyPorts,
): Promise<string | typeof UNRESOLVABLE> {
  if (typeof binding === "string") return binding.trim();
  const record = asRecord(binding);
  if (!record) return "";
  if (record.type === "secret_ref") {
    const secretId = typeof record.secretId === "string" ? record.secretId.trim() : "";
    if (!secretId) return UNRESOLVABLE;
    const version = readVersion(record.version);
    if (version === null) return UNRESOLVABLE;
    try {
      return (await ports.resolveSecretById(companyId, secretId, version)).trim();
    } catch {
      return UNRESOLVABLE;
    }
  }
  // A per-user secret never reaches a container (card-env.ts drops it).
  if (record.type === "user_secret_ref") return "";
  return typeof record.value === "string" ? record.value.trim() : "";
}

function readVersion(value: unknown): number | "latest" | null {
  if (value === undefined || value === null || value === "latest") return "latest";
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
