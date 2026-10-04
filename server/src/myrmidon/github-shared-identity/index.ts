// server/src/myrmidon/github-shared-identity/index.ts
//
// myrmidon(GITHUB-SHARED-IDENTITY): the board settings of the shared GitHub
// authorization's access rules.
//
//   GET /api/myrmidon/companies/:companyId/github-shared-identity
//       board, company access — the stored rules plus the shared GitHub
//       connections of the company (id, name, status, login, repository
//       count, installed for the company or not; never a token).
//   PUT /api/myrmidon/companies/:companyId/github-shared-identity
//       board with `tools:manage_connections` — replaces the rules. Every
//       rule must name a shared GitHub connection of this company, and every
//       agent id an agent of this company.
//
// The broker reads the rules on every credential request, so a saved change
// applies to the next git/gh operation without a restart. Every save is
// journaled (`myrmidon.github_shared.settings_saved`) with the previous and
// the next rules.

import { Router } from "express";
import type { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import {
  agents,
  connectionGrants,
  toolConnectionInstalls,
  toolConnections,
  type Db,
} from "@paperclipai/db";
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

export {
  GITHUB_SHARED_IDENTITY_GENERAL_KEY,
  DEFAULT_COMMIT_EMAIL_DOMAIN,
  defaultGitHubSharedIdentitySettings,
  isRepositoryAllowed,
  normalizeGitHubRepository,
  sharedRuleAllowsAgent,
  sharedConnectionIdsFor,
  agentCommitIdentity,
  type GitHubSharedIdentitySettings,
} from "./settings.js";
export { readGitHubSharedIdentitySettings, preserveGitHubSharedIdentityGeneralKey } from "./store.js";

export type SharedGitHubConnectionView = {
  id: string;
  name: string;
  enabled: boolean;
  status: string;
  installedForCompany: boolean;
  grant: {
    status: string;
    login: string | null;
    repositoryCount: number | null;
    repositorySelection: string | null;
  } | null;
};

/** Shared managed GitHub connections of a company, for the settings screen and validation. Metadata only. */
async function sharedGitHubConnections(db: Db, companyId: string): Promise<SharedGitHubConnectionView[]> {
  const rows = await db
    .select()
    .from(toolConnections)
    .where(and(eq(toolConnections.companyId, companyId), eq(toolConnections.credentialPolicy, "shared")));
  // Managed (OAuth, `github.code`) GitHub connections only — the same test the
  // credential resolver applies; a pasted MCP key is not a shared authorization.
  const github = rows.filter((connection) => {
    const config = connection.config && typeof connection.config === "object" ? (connection.config as Record<string, unknown>) : {};
    const oauth = config.oauth && typeof config.oauth === "object" ? (config.oauth as Record<string, unknown>) : {};
    return config.sourceTemplateKey === "github" && oauth.connectorProfile === "github.code";
  });
  if (github.length === 0) return [];
  const ids = github.map((connection) => connection.id);
  const [installs, grants] = await Promise.all([
    db
      .select()
      .from(toolConnectionInstalls)
      .where(and(eq(toolConnectionInstalls.companyId, companyId), inArray(toolConnectionInstalls.connectionId, ids))),
    db
      .select()
      .from(connectionGrants)
      .where(
        and(
          eq(connectionGrants.companyId, companyId),
          inArray(connectionGrants.connectionId, ids),
          eq(connectionGrants.kind, "organization"),
        ),
      ),
  ]);
  return github.map((connection) => {
    const grant = grants
      .filter((candidate) => candidate.connectionId === connection.id)
      .sort((a, b) => Number(b.status === "active") - Number(a.status === "active"))[0];
    const tenant = grant?.providerTenant?.github;
    return {
      id: connection.id,
      name: connection.name,
      enabled: connection.enabled,
      status: connection.status,
      installedForCompany: installs.some(
        (install) =>
          install.connectionId === connection.id && install.targetType === "company" && install.targetId === companyId,
      ),
      grant: grant
        ? {
            status: grant.status,
            login: tenant?.login ?? null,
            repositoryCount: typeof tenant?.repositoryCount === "number" ? tenant.repositoryCount : null,
            repositorySelection: tenant?.repositorySelection ?? null,
          }
        : null,
    };
  });
}

async function assertReferencesBelongToCompany(db: Db, companyId: string, settings: GitHubSharedIdentitySettings) {
  const connectionIds = settings.connections.map((rule) => rule.connectionId);
  if (connectionIds.length > 0) {
    const known = new Set((await sharedGitHubConnections(db, companyId)).map((connection) => connection.id));
    const missing = connectionIds.filter((id) => !known.has(id));
    if (missing.length > 0) {
      throw unprocessable("Every rule must name a shared GitHub connection of this company", {
        code: "github_shared_connection_invalid",
        connectionIds: missing,
      });
    }
  }
  const agentIds = [...new Set(settings.connections.flatMap((rule) => rule.agentIds))];
  if (agentIds.length === 0) return;
  const rows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), inArray(agents.id, agentIds)));
  const found = new Set(rows.map((row) => row.id));
  const missing = agentIds.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw unprocessable("Every listed agent must belong to this company", {
      code: "github_shared_agent_invalid",
      agentIds: missing,
    });
  }
}

export function myrmidonGitHubSharedIdentityRoutes(db: Db) {
  const router = Router();
  const base = "/myrmidon/companies/:companyId/github-shared-identity";

  const view = async (companyId: string) => ({
    settings: await readGitHubSharedIdentitySettings(db, companyId),
    connections: await sharedGitHubConnections(db, companyId),
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
          action: "myrmidon.github_shared.settings_saved",
          entityType: "github_shared_identity",
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
