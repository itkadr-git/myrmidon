// server/src/myrmidon/litellm-keys/run-keys.ts
//
// myrmidon(1.8 KEY-TTL / OPE-12931): run-scoped LLM gateway keys.
//
// Every heartbeat run that talks to models or tooling through the LiteLLM
// gateway gets its own virtual key, minted at run prep and revoked at every
// terminal run outcome. The contract reuses OPE-12930's agent key machinery
// (`AgentGatewayKeyDeps`, `GatewayKeyAdminPort`, `keyExpiry`,
// `generateGatewayKeyValue`): one deadline computation, one value generator,
// the same gateway-first write order, the same fail-closed secret expiry —
// only the secret-name prefix and the lifetime differ.
//
// Ownership rules, mirroring agent-keys.ts:
//  - The key value lives in exactly two places: the company secret store and
//    the gateway's key table. The board keeps no copy and no cache; the value
//    is returned to the caller ONCE (it is projected into the run environment)
//    and never logged. Only its sha256 is ever derived.
//  - The secret name is derived from the run id (`llm-gateway-run-<runId>`),
//    so nothing collides across concurrent runs and a revoke touches one
//    secret and one gateway key.
//  - A revoke is idempotent: a second call (or a call after the gateway
//    already dropped the key) deletes nothing twice and does not throw past
//    the caller; the gateway alias delete is still attempted when the store
//    entry is already gone, so a half-written mint cannot leak a live key.

import type { Db } from "@myrmidon/db";
import { readGatewayKeySettings, type GatewayKeySettings } from "@myrmidon/shared";
import { unprocessable } from "../../errors.js";
import {
  type AgentGatewayKeyDeps,
  keyExpiry,
  generateGatewayKeyValue,
} from "./agent-keys.js";

/** Secret-store name prefix owned by this module. Deliberately disjoint from the per-agent `llm-gateway-key-` prefix, whose guard (`assertManagedKeySecretName`) keeps rejecting run-key names. */
export const RUN_KEY_SECRET_PREFIX = "llm-gateway-run-";

/** Default lifetime of a run key: the run itself plus slack for the revoke hooks. Still bounded by the 24-hour gateway maximum through `keyExpiry`. */
export const RUN_KEY_DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;

/** The env variable a run key is projected into when the instance names no override. Mirrors the adapter default (`MYRMIDON_LLM_API_KEY`). */
export const DEFAULT_RUN_KEY_ENV_NAME = "MYRMIDON_LLM_API_KEY";

/** The secret-store name of one run's key. Run ids are UUIDs, so no slug step. */
export function runKeySecretName(runId: string): string {
  return `${RUN_KEY_SECRET_PREFIX}${runId}`;
}

export interface MintRunGatewayKeyInput {
  companyId: string;
  runId: string;
  /** Optional lifetime override; `keyExpiry` bounds it to (0, 24h]. */
  ttlMs?: number;
}

export interface MintedRunGatewayKey {
  /** The key value itself. Handed to the caller once; never persisted by the board and never logged. */
  value: string;
  /** ISO 8601 instant both halves (gateway `expires`, secret `expiresAt`) were written with. */
  expiresAt: string;
  secretName: string;
}

export interface RevokedRunGatewayKey {
  secretName: string;
  /** True when the gateway acknowledged a delete for the alias (or had already dropped it). */
  gatewayDeleted: boolean;
  /** True when a store entry existed and was deleted. */
  secretDeleted: boolean;
}

/**
 * Mints one run's gateway key: writes the gateway half first, then the store
 * half, both with the same deadline. The gateway half is written first so a
 * failed store write can only leave a key the gateway holds but nothing
 * reads — the terminal revoke deletes the alias regardless of the store
 * state, so the leaked half still dies with the run.
 */
export async function mintRunGatewayKey(
  deps: AgentGatewayKeyDeps,
  input: MintRunGatewayKeyInput,
): Promise<MintedRunGatewayKey> {
  const settings = requireKeyManagement(deps.env ?? process.env);
  // Validate the requested lifetime FIRST: a bad ttlMs is a 400 even when
  // nothing else is wrong, the same order agent-keys.ts mints with.
  const expiresAt = keyExpiry(input.ttlMs ?? RUN_KEY_DEFAULT_TTL_MS);

  const secretName = runKeySecretName(input.runId);
  const adminKey = await requireAdminKey(deps, input.companyId, settings);
  const value = generateGatewayKeyValue();
  await deps.gateway({ baseUrl: settings.baseUrl, adminKey }).createKey({
    alias: secretName,
    value,
    // No `models`: a run key is unrestricted, like the instance's default
    // agent key — the agent allowlist path is the per-agent restriction story.
    expiresAt,
  });
  await deps.createSecret({
    companyId: input.companyId,
    name: secretName,
    value,
    description: "LLM gateway key of one heartbeat run; the board revokes it when the run ends",
    expiresAt,
  });
  return {
    value,
    expiresAt: expiresAt.toISOString(),
    secretName,
  };
}

/**
 * Revokes one run's gateway key. Deletes the gateway key under the run's
 * alias even when the store entry is already gone (a half-written mint), and
 * deletes the store entry when present. Idempotent: neither half existing is
 * a successful no-op. Never throws for an absent key — absent is revoked.
 */
export async function revokeRunGatewayKey(
  deps: AgentGatewayKeyDeps,
  input: { companyId: string; runId: string },
): Promise<RevokedRunGatewayKey> {
  const settings = requireKeyManagement(deps.env ?? process.env);
  const secretName = runKeySecretName(input.runId);

  const adminKey = await requireAdminKey(deps, input.companyId, settings);
  await deps.gateway({ baseUrl: settings.baseUrl, adminKey }).deleteKey({ alias: secretName });

  const secretId = await deps.findSecretId(input.companyId, secretName);
  if (secretId && deps.deleteSecret) {
    await deps.deleteSecret(secretId);
  }
  return {
    secretName,
    gatewayDeleted: true,
    secretDeleted: Boolean(secretId),
  };
}

function requireKeyManagement(env: NodeJS.ProcessEnv): GatewayKeySettings & { baseUrl: string } {
  const settings = readGatewayKeySettings(env);
  if (!settings.canManageKeys || !settings.baseUrl) {
    throw unprocessable(
      "gateway key management is not enabled on this instance: no gateway address or admin key secret is configured",
      { code: "gateway_keys_disabled" },
    );
  }
  return { ...settings, baseUrl: settings.baseUrl };
}

async function requireAdminKey(
  deps: AgentGatewayKeyDeps,
  companyId: string,
  settings: GatewayKeySettings,
): Promise<string> {
  const name = settings.adminKeySecret;
  const value = name ? await deps.readSecretValue(companyId, name) : null;
  if (!value) {
    throw unprocessable("the gateway admin key is not available to the board", {
      code: "gateway_admin_key_missing",
    });
  }
  return value;
}
