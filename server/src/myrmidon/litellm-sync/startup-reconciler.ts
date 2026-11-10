// server/src/myrmidon/litellm-sync/startup-reconciler.ts
//
// myrmidon(1.6.1 MODEL-PROVIDERS B): startup reconciliation.
//
// Reconciles the LiteLLM model registry with the database state at server
// startup: every model enabled in the company's provider registry is
// registered in LiteLLM, and every model LiteLLM holds under one of that
// company's provider credentials but no longer enabled in the database is
// unregistered. Registrations the board does not own (static gateway config,
// another tenant) are never touched.
//
// Configuration is the single pair the whole gateway surface already reads
// (M2-A/M2-B, docs/myrmidon/SETTINGS.md): MYRMIDON_LITELLM_BASE_URL (the
// gateway address) and MYRMIDON_LITELLM_ADMIN_KEY_SECRET (the NAME of the
// company secret holding the gateway admin key). Either unset — reconciliation
// is skipped with one log line per process: the board runs without a gateway,
// nothing is dialled by default and the secret NAME is never sent as a key.
// The admin key VALUE is resolved per company through the secret store, and so
// is every provider credential: LiteLLM has no secret manager, the registration
// carries the key value (resolved on the board, per company), never the name.
//
// The agent key allowlists are only CHECKED at startup: the pass runs as a
// dry run and logs how many keys it would change and which model names it would
// add or remove. It sends nothing. Applying it adds every enabled registry
// model to every restricted key, so it is an explicit admin action
// (`POST .../litellm/keys/allowlist-sync?apply=true`), never a boot side effect.

import type { Db } from "@myrmidon/db";
import { companies } from "@myrmidon/db";
import { isNotNull } from "drizzle-orm";
import { readGatewayKeySettings } from "@myrmidon/shared";
import { logger } from "../../middleware/logger.js";
import { secretService } from "../../services/index.js";
import { createLitellmSyncClient } from "./client.js";
import { createLitellmSyncService } from "./service.js";
import { defaultAgentGatewayKeyDeps } from "../litellm-keys/agent-keys.js";
import { updateAgentAllowlistsForCompany } from "./agent-allowlist-handler.js";
import { summarizeAllowlistResult } from "./allowlist-report.js";
import { withCompanySyncGuard } from "./lock.js";

export interface LitellmReconcilePorts {
  listCompanyIds(db: Db): Promise<string[]>;
  /** Resolves the admin key VALUE for one company; null when the store has no value. */
  readAdminKey(db: Db, companyId: string, secretName: string): Promise<string | null>;
  /**
   * Resolves a provider credential VALUE by its secret name within one company;
   * null when the store has no value.
   */
  resolveCredential(db: Db, companyId: string, secretName: string): Promise<string | null>;
  /**
   * Checks the company's enabled-model allowlist against the agent gateway
   * keys and reports the differences. Must NOT change any key.
   */
  reportAgentAllowlists(db: Db, companyId: string, env: NodeJS.ProcessEnv): Promise<unknown>;
  log: {
    info(fields: object, message: string): void;
    warn(fields: object, message: string): void;
  };
}

/** One company secret by name -> its latest value; null when the company has no such secret. */
async function readCompanySecretValue(db: Db, companyId: string, secretName: string): Promise<string | null> {
  const secrets = secretService(db);
  const row = await secrets.getByName(companyId, secretName);
  if (!row) return null;
  return secrets.resolveSecretValue(companyId, row.id, "latest");
}

const defaultPorts: LitellmReconcilePorts = {
  async listCompanyIds(db) {
    const rows = await db.select({ id: companies.id }).from(companies).where(isNotNull(companies.id));
    return rows.map((row) => row.id);
  },
  readAdminKey: readCompanySecretValue,
  resolveCredential: readCompanySecretValue,
  async reportAgentAllowlists(db, companyId, env) {
    return updateAgentAllowlistsForCompany(
      db,
      defaultAgentGatewayKeyDeps(db, env),
      companyId,
      [],
      [],
      false,
      { apply: false },
    );
  },
  log: logger,
};

/**
 * Reconciles each company's enabled models with the gateway once, at startup.
 * A no-op when the gateway settings are absent; one company's failure never
 * stops the others; nothing here rejects the caller's promise.
 */
export async function startLitellmModelReconciliation(
  db: Db,
  opts: { env?: NodeJS.ProcessEnv; ports?: Partial<LitellmReconcilePorts> } = {},
): Promise<void> {
  const env = opts.env ?? process.env;
  const ports: LitellmReconcilePorts = { ...defaultPorts, ...opts.ports };
  const settings = readGatewayKeySettings(env);
  if (!settings.canManageKeys || !settings.baseUrl || !settings.adminKeySecret) {
    ports.log.info(
      {},
      "litellm model sync skipped at startup: MYRMIDON_LITELLM_BASE_URL or MYRMIDON_LITELLM_ADMIN_KEY_SECRET is not set",
    );
    return;
  }
  const baseUrl = settings.baseUrl;
  const adminKeySecret = settings.adminKeySecret;

  let companyIds: string[];
  try {
    companyIds = await ports.listCompanyIds(db);
  } catch (err) {
    ports.log.warn({ err }, "litellm model sync skipped at startup: companies could not be listed");
    return;
  }

  for (const companyId of companyIds) {
    try {
      const adminKey = await ports.readAdminKey(db, companyId, adminKeySecret);
      if (!adminKey) {
        // The env names a secret this company does not have: skip, never send
        // the secret NAME to the gateway as if it were the value.
        ports.log.info(
          { companyId, secretName: adminKeySecret },
          "litellm model sync skipped for company: admin key secret has no value in the store",
        );
        continue;
      }
      // Under the same per-company guard the board routes use: the startup
      // pass and a concurrent board mutation never race the gateway registry.
      await withCompanySyncGuard(companyId, async () => {
        const client = createLitellmSyncClient({
          litellmBaseUrl: baseUrl,
          litellmAdminKey: adminKey,
        });
        // Same resolver as the board routes (model-providers/wiring.ts
        // syncForCompany): without it the first enabled model of the company
        // fails with "credential could not be resolved" and nothing registers.
        await createLitellmSyncService({
          db,
          litellm: client,
          resolveCredential: (ownerCompanyId, secretName) => ports.resolveCredential(db, ownerCompanyId, secretName),
        }).reconcileWithLitellm(companyId);
        const allowlists = await ports.reportAgentAllowlists(db, companyId, env);
        ports.log.info(
          { companyId, ...summarizeAllowlistResult(allowlists as Parameters<typeof summarizeAllowlistResult>[0]) },
          "litellm agent key allowlists checked at startup (dry run, nothing applied)",
        );
      });
    } catch (err) {
      ports.log.warn({ err, companyId }, "litellm model reconciliation failed at startup for one company");
    }
  }
}
