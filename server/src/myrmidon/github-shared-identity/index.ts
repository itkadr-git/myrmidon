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
import { z } from "zod";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { agents, companySecrets, type Db } from "@paperclipai/db";
import { logActivity } from "../../services/activity-log.js";
import { assertActorCompanyPermission, assertBoard, assertCompanyAccess, getActorInfo } from "../../routes/authz.js";
import { validate } from "../../middleware/validate.js";
import { unprocessable, notFound } from "../../errors.js";
import {
  githubSharedIdentitySettingsInputSchema,
  toStoredGitHubSharedIdentitySettings,
  type GitHubSharedIdentitySettings,
} from "./settings.js";
import { readGitHubSharedIdentitySettings, writeGitHubSharedIdentitySettings } from "./store.js";
import { vendorGitHubConnectorEnabled } from "./vendor-connector.js";
// myrmidon(GITHUB-APP-MANIFEST): one-click GitHub App registration (manifest flow)
import {
  AppManifestError,
  buildGitHubAppManifest,
  completeGitHubAppManifest,
  consumeGitHubAppManifestState,
  gitHubAppInstallUrl,
  issueGitHubAppManifestState,
  settingsRedirectUrl,
} from "./app-manifest.js";

// myrmidon(GITHUB-APP-MANIFEST): input of POST .../app-manifest/begin. The
// owner rule (login alphabet) mirrors the repo owner regex of settings.ts.
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const githubAppManifestBeginSchema = z
  .object({
    ownerKind: z.enum(["user", "org"]),
    orgLogin: z.string().trim().regex(GITHUB_OWNER, "Not a GitHub organization name").optional(),
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().min(1).max(1000).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.ownerKind === "org" && !value.orgLogin) {
      ctx.addIssue({ code: "custom", path: ["orgLogin"], message: "orgLogin is required for an organization app" });
    }
  });

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
export { GITHUB_APP_TOKEN_PERMISSIONS, mintGitHubAppInstallationToken } from "./app-token.js";
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

  // myrmidon(GITHUB-APP-MANIFEST): one-click GitHub App registration — start.
  // Returns the GitHub form URL, the manifest JSON the UI auto-submits and
  // the unguessable anti-CSRF `state` GitHub echoes back on the callback
  // redirect; the state is bound to this company and this actor and is valid
  // once for a few minutes.
  router.post(
    `${base}/app-manifest/begin`,
    validate(githubAppManifestBeginSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertBoard(req);
      await assertActorCompanyPermission(req, db, companyId, "tools:manage_connections");
      const input = req.body as z.output<typeof githubAppManifestBeginSchema>;
      try {
        const built = buildGitHubAppManifest({ companyId, ...input });
        res.json({ ...built, state: issueGitHubAppManifestState(companyId, getActorInfo(req)) });
      } catch (error) {
        if (error instanceof AppManifestError) throw unprocessable(error.message);
        throw error;
      }
    },
  );

  // myrmidon(GITHUB-APP-MANIFEST): the browser redirect back from GitHub with
  // the one-time manifest code. Always a 302 to the company settings — with
  // `github_app_created=1` on success or `github_app_error=<short message>`
  // on failure; the App key is vaulted before any response and never leaves
  // the server. A code without the `state` `begin` issued for this company
  // and actor — missing, expired, used, or issued elsewhere — is refused
  // before GitHub is called: the callback must never convert a code a
  // third party could deliver to this URL.
  router.get(`${base}/app-manifest/callback`, async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    await assertActorCompanyPermission(req, db, companyId, "tools:manage_connections");
    const actor = getActorInfo(req);
    const state = typeof req.query.state === "string" ? req.query.state.trim() : "";
    if (!consumeGitHubAppManifestState({ companyId, actor, state })) {
      res.redirect(settingsRedirectUrl(companyId, { ok: false, message: "The app registration did not start from this session (or expired); start over." }));
      return;
    }
    const code = typeof req.query.code === "string" ? req.query.code.trim() : "";
    if (!code) {
      res.redirect(settingsRedirectUrl(companyId, { ok: false, message: "GitHub returned no manifest code; start over." }));
      return;
    }
    try {
      await completeGitHubAppManifest(db, { companyId, code, actor: getActorInfo(req) });
    } catch (error) {
      const message =
        error instanceof AppManifestError
          ? error.message
          : "The app could not be registered; try again or register it manually.";
      res.redirect(settingsRedirectUrl(companyId, { ok: false, message }));
      return;
    }
    res.redirect(settingsRedirectUrl(companyId, { ok: true }));
  });

  // myrmidon(GITHUB-APP-MANIFEST): the "Install on GitHub" URL of a stored
  // App entry; the UI navigates there and the user comes back by themselves.
  router.get(`${base}/apps/:entryId/install`, async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    await assertActorCompanyPermission(req, db, companyId, "tools:manage_connections");
    const settings = await readGitHubSharedIdentitySettings(db, companyId);
    const entry = settings.apps.find((app) => app.id === (req.params.entryId as string));
    if (!entry) throw notFound("GitHub App entry not found");
    const installUrl = gitHubAppInstallUrl(entry);
    if (!installUrl) {
      throw unprocessable("This entry has no GitHub app slug; it was registered manually — open the app's page on GitHub to install it.");
    }
    res.json({ installUrl });
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
