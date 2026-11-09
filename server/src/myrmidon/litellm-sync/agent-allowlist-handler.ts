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
//  - The pass can run as a DRY RUN (`apply: false`): it reads every key and
//    reports what would be added and removed, and sends nothing. The startup
//    check and the provider-change hooks run this way; only an explicit admin
//    action applies the pass to the agents' keys (the board's
//    `POST .../litellm/keys/allowlist-sync?apply=true`). Applying adds every
//    enabled registry model to every restricted key, which can widen a curated
//    list, so it is never a side effect.

import { and, eq } from "drizzle-orm";
import { agents, modelProviderModels, modelProviders, type Db } from "@myrmidon/db";
import { agentKeySecretName, DISABLED_MODEL_SENTINEL, readGatewayKeySettings } from "@myrmidon/shared";
import { notFound, unprocessable } from "../../errors.js";
import { type AgentGatewayKeyDeps } from "../litellm-keys/agent-keys.js";

/** What a pass would change on one agent key. */
export interface AllowlistKeyChange {
  agentId: string;
  /** Model names the key does not hold and the pass would add. */
  add: string[];
  /** Model names the key holds and the pass would remove. */
  remove: string[];
}

/** The report of a dry run: nothing was sent to the gateway. */
export interface AllowlistDryRunReport {
  /** Keys whose list would change. */
  wouldChange: number;
  /** Keys whose list already is what the pass would set. */
  unchanged: number;
  /** Model name -> number of keys it would be added to. */
  added: Record<string, number>;
  /** Model name -> number of keys it would be removed from. */
  removed: Record<string, number>;
  /** The per-key changes (agent ids only, never secret names or values). */
  changes: AllowlistKeyChange[];
}

export interface AllowlistSyncResult {
  /** Agents whose key the pass tried to update (a dry run: examined). */
  attempted: number;
  /** Keys the gateway acknowledged (a dry run: always 0). */
  updated: number;
  /** Machine-readable skip reasons (no secret names, no values). */
  skipped: string[];
  /** Present only on a dry run (`apply: false`). */
  dryRun?: AllowlistDryRunReport;
}

export interface AllowlistSyncOptions {
  /**
   * false: read the keys and report the differences, send nothing.
   * Default true, the behavior every earlier caller relies on.
   */
  apply?: boolean;
  /**
   * false: leave the provider registry out, so the pass handles only the names
   * the caller passes (the plugin lifecycle does this). Default true.
   */
  includeRegistryModels?: boolean;
}

/** The company's model names and enabled state as registered in the gateway. */
async function listCompanyModels(db: Db, companyId: string): Promise<{ name: string; enabled: boolean }[]> {
  // Explicit, flat columns: a bare `select()` over a join returns the rows
  // keyed by the SQL table names (`model_provider_models`), not by the
  // drizzle export names, and the pass then saw no enabled model at all.
  const rows = await db
    .select({
      modelName: modelProviderModels.modelName,
      litellmModelName: modelProviderModels.litellmModelName,
      enabled: modelProviderModels.enabled,
    })
    .from(modelProviderModels)
    .innerJoin(modelProviders, eq(modelProviderModels.providerId, modelProviders.id))
    .where(eq(modelProviders.companyId, companyId));
  return rows.map((row: any) => {
    // The flat columns are the normal shape. A nested row (an adapter that
    // returns the joined tables under their names) is read as well.
    const model = row.model_provider_models ?? row.modelProviderModels ?? row;
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
  options: AllowlistSyncOptions = {},
): Promise<AllowlistSyncResult> {
  const dryRun = options.apply === false;
  const emptyReport = (): AllowlistDryRunReport => ({
    wouldChange: 0,
    unchanged: 0,
    added: {},
    removed: {},
    changes: [],
  });
  const skip = (reason: string): AllowlistSyncResult => ({
    attempted: 0,
    updated: 0,
    skipped: [reason],
    ...(dryRun ? { dryRun: emptyReport() } : {}),
  });

  const env = agentGatewayKeys.env ?? process.env;
  const settings = readGatewayKeySettings(env);
  if (!settings.canManageKeys || !settings.baseUrl || !settings.adminKeySecret) {
    return skip("gateway-key-management-not-configured");
  }

  const companyModels = options.includeRegistryModels === false ? [] : await listCompanyModels(db, companyId);
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
  // A dry run only reads the keys, so it does not need the write method.
  if (!gateway.setKeyAllowedModels && !dryRun) {
    return skip("gateway-port-without-allowlist-support");
  }
  const companyAgents = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(eq(agents.companyId, companyId));

  let attempted = 0;
  let updated = 0;
  const skipped: string[] = [];
  const report = emptyReport();
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
      if (!gateway.getKeyInfo) {
        skipped.push(`gateway-port-without-key-info:${agent.id}`);
        continue;
      }
      const keyInfo = await gateway.getKeyInfo({ alias });
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
      if (dryRun) {
        const nextSet = new Set(next);
        const currentSet = new Set(current);
        const add = [...nextSet].filter((name) => !currentSet.has(name));
        const remove = [...currentSet].filter((name) => !nextSet.has(name));
        if (add.length === 0 && remove.length === 0) {
          report.unchanged += 1;
        } else {
          report.wouldChange += 1;
          report.changes.push({ agentId: agent.id, add, remove });
          for (const name of add) report.added[name] = (report.added[name] ?? 0) + 1;
          for (const name of remove) report.removed[name] = (report.removed[name] ?? 0) + 1;
        }
        continue;
      }
      const applied = await gateway.setKeyAllowedModels!({ alias, models: next });
      if (applied) updated += 1;
      else skipped.push(`alias-unknown-to-gateway:${agent.id}`);
    } catch {
      // One failed key never stops the pass; the next enable/disable or
      // startup pass re-applies. The value is never part of any error text.
      skipped.push(`key-update-failed:${agent.id}`);
    }
  }
  return { attempted, updated, skipped, ...(dryRun ? { dryRun: report } : {}) };
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

  const applied = await gateway.setKeyAllowedModels({
    alias,
    // Same live-verified hazard as the company pass: models: [] REMOVES the
    // gateway's restrictions instead of denying everything (LiteLLM v1.103.2),
    // so an empty request is translated into the unregistered sentinel.
    models: allowlist.models.length > 0 ? allowlist.models : [DISABLED_MODEL_SENTINEL],
  });
  return { secretName: alias, applied };
}
