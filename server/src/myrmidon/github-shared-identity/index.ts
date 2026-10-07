// server/src/myrmidon/github-shared-identity/index.ts
//
// myrmidon(GITHUB-SHARED-IDENTITY): the board settings of the self-hosted
// GitHub App identities.
//
//   GET /api/myrmidon/companies/:companyId/github-shared-identity
//       board, company access — the stored rules (App ids, key secret ids,
//       installation ids, agents, repositories; never a key or a token) and
//       whether the vendor cloud GitHub connector is enabled on the instance.
//   PUT /api/myrmidon/companies/:companyId/github-shared-identity
//       board with `tools:manage_connections` — replaces the rules. Every key
//       secret must be an active company-scope secret of this company and
//       every agent id an agent of this company.
//
// The broker reads the rules on every credential request, so a saved change
// applies to the next git/gh operation without a restart. Every save is
// journaled (`myrmidon.github_app.settings_saved`) with the previous and the
// next rules (metadata only — the document holds no secret values).

import { Router } from "express";
import type { z } from "zod";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { agents, companySecrets, type Db } from "@paperclipai/db";
import { logActivity } from "../../services/activity-log.js";
import { assertActorCompanyPermission, assertBoard, assertCompanyAccess, getActorInfo } from "../../routes/authz.js";
import { validate } from "../../middleware/validate.js";
import { unprocessable } from "../../errors.js";
import {
  githubSharedIdentitySettingsInputSchema,
  toStoredGitHubSharedIdentitySettings,
  type GitHubSharedIdentitySettings,
} from "./settings.js";
import { readGitHubSharedIdentitySettings, writeGitHubSharedIdentitySettings } from "./store.js";
import { vendorGitHubConnectorEnabled } from "./vendor-connector.js";

export {
  GITHUB_SHARED_IDENTITY_GENERAL_KEY,
  DEFAULT_COMMIT_EMAIL_DOMAIN,
  defaultGitHubSharedIdentitySettings,
  isRepositoryAllowed,
  normalizeGitHubRepository,
  appEntryAllowsAgent,
  githubAppsFor,
  agentCommitIdentity,
  type GitHubSharedIdentitySettings,
  type GitHubAppEntry,
} from "./settings.js";
export { readGitHubSharedIdentitySettings, preserveGitHubSharedIdentityGeneralKey } from "./store.js";
export { resolveGitHubAppCredential, type GitHubAppResolution } from "./resolve.js";
export {
  GITHUB_APP_TOKEN_PERMISSION_KEYS,
  DEFAULT_GITHUB_APP_PERMISSIONS,
  githubAppTokenPermissionsFor,
  type GitHubAppPermissionKey,
  type GitHubAppPermissionLevel,
  type GitHubAppPermissions,
  mintGitHubAppInstallationToken,
} from "./app-token.js";
export { normalizeGitHubAppPermissions } from "./settings.js";
export { vendorGitHubConnectorEnabled, GITHUB_VENDOR_CONNECTOR_ENV } from "./vendor-connector.js";

async function assertReferencesBelongToCompany(db: Db, companyId: string, settings: GitHubSharedIdentitySettings) {
  const secretIds = [...new Set(settings.apps.map((app) => app.privateKeySecretId))];
  if (secretIds.length > 0) {
    const rows = await db
      .select({ id: companySecrets.id })
      .from(companySecrets)
      .where(
        and(
          eq(companySecrets.companyId, companyId),
          inArray(companySecrets.id, secretIds),
          eq(companySecrets.scope, "company"),
          eq(companySecrets.status, "active"),
          isNull(companySecrets.deletedAt),
        ),
      );
    const found = new Set(rows.map((row) => row.id));
    const missing = secretIds.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw unprocessable("Every private key must be an active company secret of this company", {
        code: "github_app_secret_invalid",
        secretIds: missing,
      });
    }
  }
  const agentIds = [...new Set(settings.apps.flatMap((app) => app.agentIds))];
  if (agentIds.length > 0) {
    const rows = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), inArray(agents.id, agentIds)));
    const found = new Set(rows.map((row) => row.id));
    const missing = agentIds.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw unprocessable("Every listed agent must belong to this company", {
        code: "github_app_agent_invalid",
        agentIds: missing,
      });
    }
  }
}

export function myrmidonGitHubSharedIdentityRoutes(db: Db) {
  const router = Router();
  const base = "/myrmidon/companies/:companyId/github-shared-identity";

  const view = async (companyId: string) => ({
    settings: await readGitHubSharedIdentitySettings(db, companyId),
    vendorConnectorEnabled: vendorGitHubConnectorEnabled(),
  });

  router.get(base, async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    res.json(await view(companyId));
  });

  router.put(base, validate(githubSharedIdentitySettingsInputSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    await assertActorCompanyPermission(req, db, companyId, "tools:manage_connections");
    // `validate` already replaced the body with the schema's parsed output.
    const next = toStoredGitHubSharedIdentitySettings(
      req.body as z.output<typeof githubSharedIdentitySettingsInputSchema>,
    );
    await assertReferencesBelongToCompany(db, companyId, next);
    const { previous, changed } = await writeGitHubSharedIdentitySettings(db, companyId, next);
    if (changed) {
      const actor = getActorInfo(req);
      try {
        await logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          agentApiKeyId: actor.agentApiKeyId,
          action: "myrmidon.github_app.settings_saved",
          entityType: "github_app_identity",
          entityId: companyId,
          details: { previous, next },
        });
      } catch {
        // A failed journal entry must not lose a saved setting.
      }
    }
    res.json(await view(companyId));
  });

  return router;
}
