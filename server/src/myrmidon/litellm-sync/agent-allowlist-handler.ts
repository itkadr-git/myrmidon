// server/src/myrmidon/litellm-sync/agent-allowlist-handler.ts
//
// myrmidon(1.6.1 MODEL-PROVIDERS B): agent key allowlist management.
//
// Keeps each agent's gateway virtual key pointed at the company's enabled
// model set: when models are enabled/disabled in the provider registry (or
// reconciled at startup), every agent key that exists is updated through the
// gateway's `/key/update` with `models` — the allowlist the key may call.
// `/key/update` is a merge patch, so an agent's stored secret never needs a
// rotation to change its allowlist.
//
// Where an agent's key is found (first hit wins):
//  1. the card's env binding `adapter_config.env.MYRMIDON_LLM_API_KEY` (or the
//     env name `MYRMIDON_LITELLM_AGENT_KEY_ENV` names) — a `secret_ref` to the
//     company secret that carries the key the bot authenticates with;
//  2. the card's `apiKey` binding, a `secret_ref` too, when the card has no env
//     binding;
//  3. the board-managed secret `llm-gateway-key-<name>-<id>` that
//     `createAgentGatewayKey` writes (addressed by its alias, as before).
// Bindings 1 and 2 are followed to the secret VALUE; the gateway is addressed
// by its sha256 (`/key/update` `key`): LiteLLM v1.104.1 reads a `key` that does
// not start with "sk-" as an already-hashed token, and the board's keys are
// 64 hex characters, so only the hash is correct for every key shape.
//
// Rules this module keeps:
//  - The admin key is a company secret NAME in the env
//    (MYRMIDON_LITELLM_ADMIN_KEY_SECRET); the gateway authenticates with the
//    resolved VALUE, never the name (agent-keys.readSecretValue pattern).
//  - A company whose registry has no enabled models leaves agent keys
//    untouched: an empty allowlist would lock the whole fleet out of the
//    gateway, and "nothing registered yet" is not the same as "everything is
//    forbidden" — the operator opts in by enabling models.
//  - One agent's failure never stops the company pass: results count every
//    attempted key and name every skip; nothing here throws per agent.

import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { agents, modelProviderModels, modelProviders, type Db } from "@myrmidon/db";
import { agentKeySecretName, DISABLED_MODEL_SENTINEL, readGatewayKeySettings } from "@myrmidon/shared";
import { notFound, unprocessable } from "../../errors.js";
import { type AgentGatewayKeyDeps } from "../litellm-keys/agent-keys.js";

/** sha256 hex of a key value: the form the gateway stores (same as `gatewayKeyValueHash`). */
function keyValueHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** The env name the card projects an agent's gateway key into when no instance setting names another. */
const DEFAULT_AGENT_KEY_ENV = "MYRMIDON_LLM_API_KEY";

/** How an agent's gateway key is addressed for one update. */
interface AgentKeyRef {
  /** The board-derived alias (`llm-gateway-key-<name>-<id>`). */
  alias: string;
  /** sha256 of the key value found through the card's bindings; absent: address by alias. */
  keyHash?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A `secret_ref` binding -> the secret id and the version selector; null for anything else. */
function secretRefOf(value: unknown): { secretId: string; version: number | "latest" } | null {
  if (!isRecord(value) || value.type !== "secret_ref") return null;
  const secretId = typeof value.secretId === "string" ? value.secretId.trim() : "";
  if (!secretId) return null;
  const version =
    typeof value.version === "number" && Number.isInteger(value.version) && value.version > 0
      ? value.version
      : "latest";
  return { secretId, version };
}

/** The key bindings of a card, in lookup order. */
function cardKeyBindings(
  adapterConfig: unknown,
  agentKeyEnv: string | null,
): Array<{ secretId: string; version: number | "latest" }> {
  const config = isRecord(adapterConfig) ? adapterConfig : {};
  const env = isRecord(config.env) ? config.env : {};
  const bindings: Array<{ secretId: string; version: number | "latest" }> = [];
  for (const name of new Set([agentKeyEnv, DEFAULT_AGENT_KEY_ENV])) {
    const ref = name ? secretRefOf(env[name]) : null;
    if (ref) bindings.push(ref);
  }
  if (bindings.length === 0) {
    const ref = secretRefOf(config.apiKey);
    if (ref) bindings.push(ref);
  }
  return bindings;
}

/**
 * Finds how to address one agent's gateway key: through the card's bindings
 * (secret value -> sha256) first, then the board-managed secret by alias.
 * `bindingUnresolved` tells "the card names a key secret that holds no value"
 * from "the agent has no key at all".
 */
async function resolveAgentKeyRef(
  deps: AgentGatewayKeyDeps,
  companyId: string,
  agent: { id: string; name: string; adapterConfig?: unknown },
  agentKeyEnv: string | null,
): Promise<{ ref: AgentKeyRef | null; bindingUnresolved: boolean }> {
  const alias = agentKeySecretName({ agentId: agent.id, agentSlug: agent.name });
  let bindingUnresolved = false;
  if (deps.readSecretValueById) {
    for (const binding of cardKeyBindings(agent.adapterConfig, agentKeyEnv)) {
      const value = await deps.readSecretValueById(companyId, binding.secretId, binding.version);
      if (value) return { ref: { alias, keyHash: keyValueHash(value) }, bindingUnresolved: false };
      bindingUnresolved = true;
    }
  }
  // An agent without a managed key yet has no allowlist to update; creating
  // keys is M2-B's job (the board), not this pass's.
  const secretId = await deps.findSecretId(companyId, alias);
  if (secretId) return { ref: { alias }, bindingUnresolved: false };
  return { ref: null, bindingUnresolved };
}

/** The address fields a gateway call takes. */
function keyAddress(ref: AgentKeyRef): { alias: string; keyHash?: string } {
  return ref.keyHash ? { alias: ref.alias, keyHash: ref.keyHash } : { alias: ref.alias };
}

export interface AllowlistSyncResult {
  /** Agents whose key the pass tried to update. */
  attempted: number;
  /** Keys the gateway acknowledged. */
  updated: number;
  /** Machine-readable skip reasons (no secret names, no values). */
  skipped: string[];
}

/** The company's model names and enabled state as registered in the gateway. */
async function listCompanyModels(db: Db, companyId: string): Promise<{ name: string; enabled: boolean }[]> {
  const rows = await db
    .select()
    .from(modelProviderModels)
    .innerJoin(modelProviders, eq(modelProviderModels.providerId, modelProviders.id))
    .where(eq(modelProviders.companyId, companyId));
  return rows.map((row: any) => {
    // Drizzle returns joined tables under their table keys; keeping the flat
    // fallback makes this port easy to exercise with lightweight adapters.
    const model = row.modelProviderModels ?? row;
    return {
      name: model.litellmModelName ?? model.modelName,
      enabled: model.enabled === true,
    };
  });
}

/**
 * Re-applies the company's enabled-model allowlist to every agent key.
 * Skips (with a reason) when key management is off on the instance, when the
 * admin-key secret resolves to no value, when the registry has no enabled
 * models, or when the port cannot update an allowlist without rotating.
 */
export async function updateAgentAllowlistsForCompany(
  db: Db,
  agentGatewayKeys: AgentGatewayKeyDeps,
  companyId: string,
  additionalModelNames: readonly string[] = [],
  removedModelNames: readonly string[] = [],
  allowEmpty = false,
): Promise<AllowlistSyncResult> {
  const skip = (reason: string): AllowlistSyncResult => ({ attempted: 0, updated: 0, skipped: [reason] });

  const env = agentGatewayKeys.env ?? process.env;
  const settings = readGatewayKeySettings(env);
  if (!settings.canManageKeys || !settings.baseUrl || !settings.adminKeySecret) {
    return skip("gateway-key-management-not-configured");
  }

  const companyModels = await listCompanyModels(db, companyId);
  const enabledNames = companyModels.filter((model) => model.enabled).map((model) => model.name);
  const models = [...new Set([
    ...enabledNames,
    ...additionalModelNames,
  ])].filter((model) => !removedModelNames.includes(model));
  if (models.length === 0 && !allowEmpty) {
    // Nothing enabled yet: leave keys at their current lists rather than
    // churning them on a pass with nothing to say.
    return skip("no-enabled-models");
  }
  // LiteLLM (verified live against v1.103.2, isolated instance) treats
  // /key/update with models:[] as "restrictions removed": the key may call
  // EVERY registered model, including ones it never held. A disable pass that
  // removed the last plugin's models must therefore never send an empty
  // list — it would unlock the whole gateway for every agent key in the
  // company. A sentinel name that is never registered denies every model
  // instead (verified live: 403 for held and never-held models alike, and the
  // key recovers when a real list is applied later).
  const payloadModels = models.length > 0 ? models : [DISABLED_MODEL_SENTINEL];

  // The env carries the secret NAME; the gateway needs the VALUE. Resolve it
  // before the empty-registry guard so a configured-but-broken deployment is
  // reported distinctly, while still leaving all keys untouched.
  const adminKey = await agentGatewayKeys.readSecretValue(companyId, settings.adminKeySecret);
  if (!adminKey) {
    return skip("admin-key-secret-unresolved");
  }
  const gateway = agentGatewayKeys.gateway({ baseUrl: settings.baseUrl, adminKey });
  if (!gateway.setKeyAllowedModels) {
    return skip("gateway-port-without-allowlist-support");
  }
  const companyAgents = await db
    .select({ id: agents.id, name: agents.name, adapterConfig: agents.adapterConfig })
    .from(agents)
    .where(eq(agents.companyId, companyId));

  let attempted = 0;
  let updated = 0;
  const skipped: string[] = [];
  for (const agent of companyAgents) {
    let found: Awaited<ReturnType<typeof resolveAgentKeyRef>>;
    try {
      found = await resolveAgentKeyRef(agentGatewayKeys, companyId, agent, settings.agentKeyEnv);
    } catch {
      // A secret store hiccup on one agent never stops the pass; the value is
      // never part of any error text.
      skipped.push(`key-lookup-failed:${agent.id}`);
      continue;
    }
    const { ref } = found;
    if (!ref) {
      skipped.push(found.bindingUnresolved ? `key-binding-unresolved:${agent.id}` : `agent-without-key:${agent.id}`);
      continue;
    }
    attempted += 1;
    try {
      if (!gateway.getKeyInfo) {
        skipped.push(`gateway-port-without-key-info:${agent.id}`);
        continue;
      }
      const keyInfo = await gateway.getKeyInfo(keyAddress(ref));
      if (!keyInfo) {
        skipped.push(`alias-unknown-to-gateway:${agent.id}`);
        continue;
      }
      const current = keyInfo.models ?? [];
      if (current.length === 0 && !allowEmpty) {
        // An empty gateway list means ALL models. Never turn that into a
        // restrictive list merely because the board owns some models. On the
        // disable path (allowEmpty) we still proceed: the operator asked to
        // lock the fleet out, and the sentinel below denies every model.
        skipped.push(`key-all-models:${agent.id}`);
        continue;
      }
      // Merge: keep models the board does not own (other pools/tenants),
      // add/revoke only the board-owned ones. The disable path (models empty)
      // subtracts owned and explicitly removed names; a fully-empty result is
      // replaced by the sentinel so we never send models:[] (which LiteLLM
      // treats as "remove restrictions"). The enable path adds enabled and
      // additional names on top of surviving non-board models.
      const ownedNames = new Set(companyModels.map((model) => model.name));
      const survivors = current.filter((name) => !ownedNames.has(name) && !removedModelNames.includes(name));
      const next = models.length > 0
        ? [...survivors, ...payloadModels]
        : survivors.length > 0
          ? survivors
          : [DISABLED_MODEL_SENTINEL];
      const applied = await gateway.setKeyAllowedModels({ ...keyAddress(ref), models: next });
      if (applied) updated += 1;
      else skipped.push(`alias-unknown-to-gateway:${agent.id}`);
    } catch {
      // One failed key never stops the pass; the next enable/disable or
      // startup pass re-applies. The value is never part of any error text.
      skipped.push(`key-update-failed:${agent.id}`);
    }
  }
  return { attempted, updated, skipped };
}

/**
 * Updates one agent's gateway key allowlist through the gateway.
 *
 * The single-agent primitive behind the company pass: resolves the agent,
 * requires key management configured and the admin-key secret resolvable to a
 * value, and reports what the gateway answered. Throws only for the caller's
 * own mistakes (unknown agent, gateway not configured); a gateway that does
 * not know the alias answers `applied: false`.
 */
export async function updateAgentGatewayKeyWithAllowlist(
  agentGatewayKeys: AgentGatewayKeyDeps,
  input: { agentId: string; companyId: string },
  allowlist: { models: string[] },
): Promise<{ secretName: string; applied: boolean }> {
  const rows = await agentGatewayKeys.db
    .select({ id: agents.id, name: agents.name, adapterConfig: agents.adapterConfig })
    .from(agents)
    .where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)))
    .limit(1);
  const agent = rows[0];
  if (!agent) {
    throw notFound(`Agent ${input.agentId} not found in company ${input.companyId}`, {
      code: "agent_not_found",
    });
  }
  const alias = agentKeySecretName({ agentId: agent.id, agentSlug: agent.name });

  const settings = readGatewayKeySettings(agentGatewayKeys.env ?? process.env);
  if (!settings.canManageKeys || !settings.baseUrl || !settings.adminKeySecret) {
    throw unprocessable("gateway key management is not configured", { code: "gateway_keys_disabled" });
  }

  // Secret NAME in, VALUE out: the gateway authenticates with the resolved
  // admin key, never with the name the env carries.
  const adminKey = await agentGatewayKeys.readSecretValue(input.companyId, settings.adminKeySecret);
  if (!adminKey) {
    throw unprocessable("gateway admin key secret has no value in the store", {
      code: "gateway_admin_key_unresolved",
    });
  }
  const gateway = agentGatewayKeys.gateway({ baseUrl: settings.baseUrl, adminKey });
  if (!gateway.setKeyAllowedModels) {
    throw unprocessable("gateway port cannot update key allowlists", { code: "gateway_allowlist_unsupported" });
  }

  // The card's key binding, when it has one, addresses the key by hash; else
  // the derived alias, as before.
  const { ref } = await resolveAgentKeyRef(agentGatewayKeys, input.companyId, agent, settings.agentKeyEnv);
  const applied = await gateway.setKeyAllowedModels({
    ...(ref ? keyAddress(ref) : { alias }),
    // Same live-verified hazard as the company pass: models: [] REMOVES the
    // gateway's restrictions instead of denying everything (LiteLLM v1.103.2),
    // so an empty request is translated into the unregistered sentinel.
    models: allowlist.models.length > 0 ? allowlist.models : [DISABLED_MODEL_SENTINEL],
  });
  return { secretName: alias, applied };
}
