// server/src/myrmidon/github-shared-identity/webhook-sync.ts
//
// myrmidon(GITHUB-APP-WEBHOOK): point one self-hosted GitHub App's webhook at
// this board.
//
//   1. the App entry gets a webhook secret — a company secret created once
//      (32 random bytes, hex) and referenced by `webhookSecretId`; a second
//      sync reuses it, so the secret GitHub holds and the secret the receiver
//      verifies with stay the same;
//   2. the App's webhook configuration is set with the App's own JWT
//      (`PATCH /app/hook/config`: url, JSON content type, TLS verification on,
//      the secret) — the same call the chat channel uses for its App;
//   3. the configuration is read back from GitHub (`GET /app/hook/config`) and
//      that — never the secret — is what the caller gets.
//
// The App's "Active" webhook switch is a GitHub-side setting no API reaches;
// the operator turns it on once on the App's settings page (see the guide).

import { randomBytes } from "node:crypto";
import type { Db } from "@myrmidon/db";
import { logActivity } from "../../services/activity-log.js";
import { badGateway, notFound, unprocessable } from "../../errors.js";
import { secretService } from "../../services/secrets.js";
import {
  readGitHubAppWebhookConfig,
  resyncGitHubAppWebhook,
} from "../../services/chat-github-webhook-config.js";
import type { getActorInfo } from "../../routes/authz.js";
import { githubAppJwt, GitHubAppTokenError } from "./app-token.js";
import {
  clearGitHubAppWebhookDisabledSignal,
  recordGitHubAppWebhookDisabledSignal,
} from "./webhook-disabled-signal.js";
import { readGitHubSharedIdentitySettings, writeGitHubSharedIdentitySettings } from "./store.js";

export async function syncGitHubAppWebhook(
  db: Db,
  input: {
    companyId: string;
    entryId: string;
    webhookUrl: string;
    actor: ReturnType<typeof getActorInfo>;
    fetchImpl?: typeof fetch;
  },
): Promise<{ url: string; contentType: "json" | "form" }> {
  const secrets = secretService(db);
  const settings = await readGitHubSharedIdentitySettings(db, input.companyId);
  const entry = settings.apps.find((app) => app.id === input.entryId);
  if (!entry) throw notFound("GitHub App entry not found");

  const webhookUrl = (() => {
    try {
      return new URL(input.webhookUrl);
    } catch {
      return null;
    }
  })();
  if (!webhookUrl || webhookUrl.protocol !== "https:" || webhookUrl.username || webhookUrl.password || webhookUrl.search || webhookUrl.hash) {
    throw unprocessable("The webhook URL must be a plain https URL without credentials, query or fragment", {
      code: "github_webhook_url_invalid",
    });
  }

  const readSecret = (secretId: string, configPath: string): Promise<string> =>
    secrets.resolveSecretValue(input.companyId, secretId, "latest", {
      accessContext: {
        consumerType: "system",
        consumerId: "github-app-webhook-sync",
        configPath,
        actorType: input.actor.actorType === "agent" ? "agent" : "user",
        actorId: input.actor.actorId,
      },
    });

  // 1. The webhook secret: created once, saved on the entry before GitHub is
  // called, so a failed GitHub call is retried with the same secret.
  let webhookSecretId = entry.webhookSecretId ?? null;
  let webhookSecret: string;
  if (webhookSecretId) {
    try {
      webhookSecret = await readSecret(webhookSecretId, `github_app:${entry.appId}:webhook`);
    } catch {
      throw unprocessable("The App's webhook secret is missing or inactive", { code: "github_app_secret_invalid" });
    }
  } else {
    webhookSecret = randomBytes(32).toString("hex");
    const created = await secrets.create(
      input.companyId,
      {
        name: `GitHub App ${entry.appId} webhook secret (${entry.id})`,
        provider: "local_encrypted",
        value: webhookSecret,
        description: "Webhook secret of a self-hosted GitHub App (HMAC key of X-Hub-Signature-256).",
      },
      { userId: input.actor.actorType === "user" ? input.actor.actorId : null, agentId: input.actor.agentId },
    );
    webhookSecretId = created.id;
    const current = await readGitHubSharedIdentitySettings(db, input.companyId);
    const { previous, next, changed } = await writeGitHubSharedIdentitySettings(db, input.companyId, {
      ...current,
      apps: current.apps.map((app) => (app.id === entry.id ? { ...app, webhookSecretId } : app)),
    });
    if (changed) {
      try {
        await logActivity(db, {
          companyId: input.companyId,
          actorType: input.actor.actorType,
          actorId: input.actor.actorId,
          agentId: input.actor.agentId,
          runId: input.actor.runId,
          agentApiKeyId: input.actor.agentApiKeyId,
          action: "myrmidon.github_app.settings_saved",
          entityType: "github_app_identity",
          entityId: input.companyId,
          details: { previous, next },
        });
      } catch {
        // A failed journal entry must not lose a saved setting.
      }
    }
  }

  // 2. The App JWT (the key is read as a system consumer, like the broker does).
  let appToken: string;
  try {
    appToken = githubAppJwt(entry.appId, await readSecret(entry.privateKeySecretId, `github_app:${entry.appId}`));
  } catch (error) {
    throw unprocessable(
      error instanceof GitHubAppTokenError ? error.message : "The GitHub App private key could not be read",
      { code: "github_app_secret_invalid" },
    );
  }

  // 3. Set, then read back. GitHub's answers never reach the caller: the
  // helpers raise closed, secret-free messages only.
  const fetchImpl = input.fetchImpl ?? fetch;
  try {
    await resyncGitHubAppWebhook({ fetch: fetchImpl, appToken, webhookUrl: input.webhookUrl, webhookSecret });
    const config = await readGitHubAppWebhookConfig({ fetch: fetchImpl, appToken });
    // myrmidon(OPE-12868): a confirmed sync clears the webhook-disabled latch —
    // the attention card exists exactly while the webhook is still broken.
    clearGitHubAppWebhookDisabledSignal(input.companyId, entry.id);
    try {
      await logActivity(db, {
        companyId: input.companyId,
        actorType: input.actor.actorType,
        actorId: input.actor.actorId,
        agentId: input.actor.agentId,
        runId: input.actor.runId,
        agentApiKeyId: input.actor.agentApiKeyId,
        action: "myrmidon.github_app.webhook_synced",
        entityType: "github_app_identity",
        entityId: input.companyId,
        details: { entryId: entry.id, appId: entry.appId, url: config.url, contentType: config.contentType },
      });
    } catch {
      // The webhook is configured; a failed journal entry must not hide that.
    }
    return { url: config.url, contentType: config.contentType };
  } catch (error) {
    // myrmidon(OPE-12868): GitHub answers 404 on the /app/hook/config PATCH
    // while the App's webhook is not "Active" on the App's settings page — the
    // one GitHub-side switch no API reaches. Raise the attention latch so the
    // board says "webhook disabled" instead of failing silently for days.
    // Match on our own closed PATCH-failure message (the constant prefix plus
    // the status), not on provider content; the read-back stage's 404 is a
    // different failure and must not trip this latch.
    if (
      error instanceof Error &&
      error.message.includes("could not update this App's webhook") &&
      error.message.includes("HTTP 404")
    ) {
      recordGitHubAppWebhookDisabledSignal({
        companyId: input.companyId,
        entryId: entry.id,
        appId: entry.appId,
        webhookHost: webhookUrl.host,
      });
    }
    throw badGateway(error instanceof Error ? error.message : "GitHub webhook configuration could not be confirmed", {
      code: "github_webhook_sync_failed",
    });
  }
}
