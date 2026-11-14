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
import { agents, type Db } from "@myrmidon/db";
import { agentKeySecretName, isAgentKeySecretName } from "@myrmidon/shared";
import { secretService } from "../../services/index.js";
import { cardUsesLlmGateway } from "../bot-containers/profile-input.js";

export const BOT_LLM_API_KEY_ENV_ENV = "MYRMIDON_BOT_LLM_API_KEY_ENV";
export const BOT_LLM_API_KEY_SECRET_ENV = "MYRMIDON_BOT_LLM_API_KEY_SECRET";

export interface GatewayBotKey {
  agentId: string;
  keyValue: string;
}

/**
 * myrmidon(OPE-12932 KEY-TTL): the run-scoped projection of an agent's managed
 * gateway key. The run's compiled env carries only the REFERENCE
 * ({ type: "secret_ref", secretId, version: "latest" }); the secrets service
 * resolves it once at dispatch, masks the value, and records the access. The
 * raw key never enters the persisted adapter config or the profile.
 */
export interface RunScopedGatewayKeyRef {
  /** The env name the run receives the reference under (settings.keyEnv). */
  envKey: string;
  /** The secret store binding placed in the run env: reference, never a value. */
  secretRef: { type: "secret_ref"; secretId: string; version: "latest" };
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
    // myrmidon(OPE-12804): an omp_local engineer calls the gateway with its OWN key too
    // (env MYRMIDON_LLM_API_KEY -> {env:...} in its provider config), but this list used to
    // take hermes_gateway cards only, so every omp call was "unattributed" and never got a
    // heartbeat_run_id. omp has no profile compiler: only the card's own binding is its key,
    // never the shared secret (attributing by it would be a guess).
    const isOmp = card.adapterType === "omp_local";
    if (card.adapterType !== "hermes_gateway" && !isOmp) continue;
    const config = asRecord(card.adapterConfig);
    if (!config || (!isOmp && !cardUsesLlmGateway(config))) continue;
    if (!settings.keyEnv) continue; // the compiler gives such a bot no gateway key either

    // A card's own env binding wins (the profile compiler's precedence).
    const own = await resolveCardBinding(companyId, asRecord(config.env)?.[settings.keyEnv], ports);
    if (own === UNRESOLVABLE) continue;
    if (own) {
      result.push({ agentId: card.agentId, keyValue: own });
      continue;
    }
    if (isOmp) continue;
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

/**
 * myrmidon(OPE-12932 KEY-TTL): the run-scoped secret_ref for an agent's
 * managed gateway key, for the run env. Returns null when the agent does not
 * hold a managed key (nothing bound, foreign settings) — the run simply gets
 * no key reference, like before. The lookup never reads the key value: the
 * run env carries the reference, and the secrets service resolves it once at
 * dispatch (audited, masked), so the raw key never enters the compiled config
 * or profile.
 */
export async function findRunScopedGatewayKeyRef(
  db: Db,
  companyId: string,
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RunScopedGatewayKeyRef | null> {
  const settings = readGatewayBotKeySettings(env);
  if (!settings.keyEnv) return null;
  const secret = await secretService(db).getByName(companyId, agentKeySecretName({ agentId }));
  if (!secret || secret.status !== "active" || secret.scope !== "company") return null;
  return {
    envKey: settings.keyEnv,
    secretRef: { type: "secret_ref", secretId: secret.id, version: "latest" },
  };
}

/**
 * myrmidon(OPE-12932 KEY-TTL): deletes the agent's managed gateway key secret,
 * which revokes the run-scoped projection with it — the next resolution of a
 * stale run ref fails with `secret_deleted` instead of authenticating. Best
 * effort by design: a missing secret (never created, already revoked) is
 * success, and a provider outage must not fail the run that is finishing.
 * Returns whether a secret was actually deleted.
 */
export async function removeRunScopedGatewayKeyRef(
  db: Db,
  companyId: string,
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const settings = readGatewayBotKeySettings(env);
  const secretName = agentKeySecretName({ agentId });
  if (!isAgentKeySecretName(secretName)) return false;
  const secrets = secretService(db);
  const secret = await secrets.getByName(companyId, secretName).catch(() => null);
  if (!secret) return false;
  try {
    await secrets.remove(secret.id);
    return true;
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
