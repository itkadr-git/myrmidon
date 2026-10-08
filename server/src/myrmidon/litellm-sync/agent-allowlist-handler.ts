// server/src/myrmidon/litellm-sync/agent-allowlist-handler.ts
//
// myrmidon(1.6.1 MODEL-PROVIDERS B): agent key allowlist management.
//
// Keeps each agent's gateway virtual key pointed at the company's enabled
// model set: when models are enabled/disabled in the provider registry (or
// reconciled at startup), every agent key that exists is updated through the
// gateway's `/key/update` with `models` — the allowlist the key may call.
// `/key/update` with the alias but no `key` field keeps the installed value,
// so an agent's stored secret never needs a rotation to change its allowlist.
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

import { and, eq } from "drizzle-orm";
import { agents, modelProviderModels, modelProviders, type Db } from "@paperclipai/db";
import { agentKeySecretName, readGatewayKeySettings } from "@paperclipai/shared";
import { notFound, unprocessable } from "../../errors.js";
import { type AgentGatewayKeyDeps } from "../litellm-keys/agent-keys.js";

export interface AllowlistSyncResult {
  /** Agents whose key the pass tried to update. */
  attempted: number;
  /** Keys the gateway acknowledged. */
  updated: number;
  /** Machine-readable skip reasons (no secret names, no values). */
  skipped: string[];
}

/** The company's enabled model names as registered in the gateway. */
async function listEnabledModelNames(db: Db, companyId: string): Promise<string[]> {
  const rows = await db
    .select({ litellmModelName: modelProviderModels.litellmModelName })
    .from(modelProviderModels)
    .innerJoin(modelProviders, eq(modelProviderModels.providerId, modelProviders.id))
    .where(and(eq(modelProviders.companyId, companyId), eq(modelProviderModels.enabled, true)));
  return [...new Set(rows.map((row) => row.litellmModelName))];
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
): Promise<AllowlistSyncResult> {
  const skip = (reason: string): AllowlistSyncResult => ({ attempted: 0, updated: 0, skipped: [reason] });

  const env = agentGatewayKeys.env ?? process.env;
  const settings = readGatewayKeySettings(env);
  if (!settings.canManageKeys || !settings.baseUrl || !settings.adminKeySecret) {
    return skip("gateway-key-management-not-configured");
  }

  const models = await listEnabledModelNames(db, companyId);
  if (models.length === 0) {
    // Nothing enabled yet: leave keys unrestricted rather than locking the
    // fleet out with an empty allowlist.
    return skip("no-enabled-models");
  }

  // The env carries the secret NAME; the gateway needs the VALUE.
  const adminKey = await agentGatewayKeys.readSecretValue(companyId, settings.adminKeySecret);
  if (!adminKey) {
    return skip("admin-key-secret-unresolved");
  }
  const gateway = agentGatewayKeys.gateway({ baseUrl: settings.baseUrl, adminKey });
  if (!gateway.setKeyAllowedModels) {
    return skip("gateway-port-without-allowlist-support");
  }

  const companyAgents = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(eq(agents.companyId, companyId));

  let attempted = 0;
  let updated = 0;
  const skipped: string[] = [];
  for (const agent of companyAgents) {
    const alias = agentKeySecretName({ agentId: agent.id, agentSlug: agent.name });
    // An agent without a managed key yet has no allowlist to update; creating
    // keys is M2-B's job (the board), not this pass's.
    const secretId = await agentGatewayKeys.findSecretId(companyId, alias);
    if (!secretId) {
      skipped.push(`agent-without-key:${agent.id}`);
      continue;
    }
    attempted += 1;
    try {
      const applied = await gateway.setKeyAllowedModels({ alias, models });
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
    .select({ id: agents.id, name: agents.name })
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

  const applied = await gateway.setKeyAllowedModels({ alias, models: allowlist.models });
  return { secretName: alias, applied };
}
