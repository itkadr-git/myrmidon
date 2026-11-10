// server/src/myrmidon/github-app-webhook/index.ts
//
// myrmidon(GITHUB-APP-WEBHOOK): the public receiver of our own GitHub App's
// webhook — the way CI events (check_run, check_suite, workflow_run) and
// pull-request events reach the board without the vendor cloud connector.
//
//   POST /api/myrmidon/github-app/webhook
//       No board credentials: GitHub calls it. The credential is the HMAC
//       `X-Hub-Signature-256` over the exact request bytes, checked against
//       the webhook secret of the App entry whose App id GitHub names in
//       `X-GitHub-Hook-Installation-Target-ID`.
//
//         204  the App id is not configured here (no entry with a webhook
//              secret): nothing to do, nothing recorded
//         401  missing or wrong signature: nothing recorded
//         400  a verified delivery with no usable event name / delivery id / body
//         503  the event service of this process is not up yet (GitHub shows
//              the delivery as failed and it can be redelivered)
//         202  accepted; the body counts what happened per matched company
//
// The secret is a company secret referenced by `webhookSecretId` on the App
// entry (created by `POST .../apps/:entryId/webhook-sync`); it is never in a
// response or a log line. The delivery is handed to the SAME event service
// the connector poll uses (`githubConnectionEvents.ingestAppWebhook`), which
// the server creates after the app: the route binds to it through a getter.

import { createHmac, timingSafeEqual } from "node:crypto";
import { Router, type Request } from "express";
import type { Db } from "@myrmidon/db";
import { secretService } from "../../services/secrets.js";
import type { GitHubAppWebhookIngestResult } from "../../services/github-connection-events.js";
import { listGitHubAppEntriesByAppId } from "../github-shared-identity/store.js";

export const GITHUB_APP_WEBHOOK_PATH = "/api/myrmidon/github-app/webhook";

/** The slice of the GitHub connection event service this receiver needs. */
export type GitHubAppWebhookIngest = {
  ingestAppWebhook(input: {
    appId: string;
    deliveryId: string;
    eventName: string;
    payload: Record<string, unknown>;
  }): Promise<GitHubAppWebhookIngestResult>;
};

export type GitHubAppWebhookRouteOptions = {
  /** The live event service; `null` while the server is still starting. */
  ingest: () => GitHubAppWebhookIngest | null;
  /** How long a resolved webhook secret is reused (default 60 s). */
  secretTtlMs?: number;
};

const DEFAULT_SECRET_TTL_MS = 60_000;

/** True when `header` (`sha256=<hex>`) is the HMAC-SHA256 of `rawBody` under `secret`. */
export function verifyGitHubWebhookSignature(secret: string, rawBody: Buffer, header: string | undefined): boolean {
  const match = /^sha256=([0-9a-f]{64})$/i.exec(header?.trim() ?? "");
  if (!match || !secret) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const given = Buffer.from(match[1]!, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function headerValue(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === "string" ? value.trim() : undefined;
}

export function myrmidonGitHubAppWebhookRoutes(db: Db, options: GitHubAppWebhookRouteOptions) {
  const router = Router();
  // Built on the first delivery: the app is assembled long before any arrives.
  let secrets: ReturnType<typeof secretService> | undefined;
  const ttl = options.secretTtlMs ?? DEFAULT_SECRET_TTL_MS;
  // Every delivery is verified; resolving the secret each time would write a
  // secret-access event per delivery, so a resolved value is reused briefly.
  const cache = new Map<string, { value: string; expiresAt: number }>();

  async function webhookSecret(companyId: string, secretId: string): Promise<string | null> {
    const key = `${companyId}:${secretId}`;
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    try {
      secrets ??= secretService(db);
      const value = await secrets.resolveSecretValue(companyId, secretId, "latest", {
        accessContext: {
          consumerType: "system",
          consumerId: "github-app-webhook",
          configPath: "github_app:webhook",
          actorType: "system",
        },
      });
      cache.set(key, { value, expiresAt: Date.now() + ttl });
      return value;
    } catch {
      // A deleted or unreadable secret verifies nothing; never echo the cause.
      cache.delete(key);
      return null;
    }
  }

  router.post(GITHUB_APP_WEBHOOK_PATH, async (req, res) => {
    const appId = headerValue(req, "x-github-hook-installation-target-id");
    const candidates = appId && /^[0-9]{1,20}$/.test(appId)
      ? (await listGitHubAppEntriesByAppId(db, appId)).filter(({ entry }) => entry.webhookSecretId)
      : [];
    if (!appId || candidates.length === 0) {
      res.status(204).end();
      return;
    }

    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    const signature = headerValue(req, "x-hub-signature-256");
    let verified = false;
    if (rawBody && signature) {
      for (const { companyId, entry } of candidates) {
        const secret = await webhookSecret(companyId, entry.webhookSecretId!);
        if (secret && verifyGitHubWebhookSignature(secret, rawBody, signature)) {
          verified = true;
          break;
        }
      }
    }
    if (!verified) {
      res.status(401).json({ error: "Invalid webhook signature" });
      return;
    }

    const eventName = headerValue(req, "x-github-event");
    const deliveryId = headerValue(req, "x-github-delivery");
    const payload = req.body;
    if (
      !eventName || !/^[a-z][a-z_]{0,63}$/.test(eventName)
      || !deliveryId || !/^[A-Za-z0-9-]{8,128}$/.test(deliveryId)
      || !payload || typeof payload !== "object" || Array.isArray(payload)
    ) {
      res.status(400).json({ error: "Malformed GitHub webhook delivery" });
      return;
    }

    const ingest = options.ingest();
    if (!ingest) {
      res.status(503).json({ error: "GitHub event intake is not ready" });
      return;
    }
    const result = await ingest.ingestAppWebhook({
      appId,
      deliveryId,
      eventName,
      payload: payload as Record<string, unknown>,
    });
    res.status(202).json(result);
  });

  return router;
}
