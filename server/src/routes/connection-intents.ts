import { connectionIntentDeliveryService } from "../services/connection-intent-delivery.js";
import { Router, type Request } from "express";
import type { Db } from "@myrmidon/db";
import { and, eq } from "drizzle-orm";
import { heartbeatRuns, issues } from "@myrmidon/db";
import { createPullRequestCiResolver } from "../services/github-pull-request-ci.js";
import {
  CONNECTION_REQUEST_TOOL_DESCRIPTION,
  CONNECTIONS_SEARCH_TOOL_DESCRIPTION,
  completeConnectionIntentSchema,
  connectionRequestInputSchema,
  connectionsSearchInputSchema,
  declineConnectionIntentSchema,
} from "@myrmidon/shared";
import { forbidden, unauthorized } from "../errors.js";
import { verifyRuntimeToolsToken } from "../runtime-tools-token.js";
import { connectionIntentService } from "../services/connection-intents.js";
import { logActivity } from "../services/activity-log.js";
import { accessService } from "../services/access.js";
import type { heartbeatService } from "../services/heartbeat.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { resolveGitHubOperationCredentials } from "../services/github-operation-credentials.js";

export const REPOSITORY_REGEX = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function bearer(req: Request) {
  const value = req.header("authorization") ?? "";
  return /^Bearer\s+/i.test(value) ? value.replace(/^Bearer\s+/i, "").trim() : "";
}

function runtimeClaims(req: Request) {
  const claims = verifyRuntimeToolsToken(bearer(req));
  if (!claims) throw unauthorized("Runtime tools token is missing, invalid, or expired");
  return claims;
}

function resultContent(value: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

export { RUNTIME_CONNECTION_TOOL_DEFINITIONS } from "../services/connection-tool-definitions.js";
import {
  RUNTIME_CONNECTION_TOOL_DEFINITIONS,
  RUNTIME_INTENT_TOOL_DEFINITIONS,
} from "../services/connection-tool-definitions.js";
import { boardLoadRequestMiddleware } from "../myrmidon/monitoring/board-load/index.js";

/** Public, token-authenticated routes mounted before the general actor middleware. */
export function runtimeConnectionIntentRoutes(db: Db) {
  const router = Router();
  router.use(boardLoadRequestMiddleware());
  const service = connectionIntentService(db);

  router.post("/runtime-tools/github/credentials", async (req, res) => {
    // This capability is never accepted as board/session authentication.
    // Node fetch sends Sec-Fetch-Mode too; browsers additionally send Origin or Sec-Fetch-Site.
    if (req.headers.origin || req.headers.cookie || req.headers["sec-fetch-site"]) throw forbidden("GitHub credentials require runtime authentication");
    const claims = verifyRuntimeToolsToken(typeof req.headers["x-paperclip-github-capability"] === "string"
      ? req.headers["x-paperclip-github-capability"] : bearer(req), "github_credentials");
    if (!claims) throw unauthorized("Invalid GitHub runtime capability");
    res.setHeader("Cache-Control", "no-store");
    // myrmidon(GITHUB-SHARED-IDENTITY): the optional `repository` (owner/repo) the
    // git/gh operation targets; a GitHub App token is minted per repository.
    const repository = typeof req.body?.repository === "string" && req.body.repository.length <= 300
      ? req.body.repository : null;
    res.json(await resolveGitHubOperationCredentials(db, {
      companyId: claims.company_id, agentId: claims.sub, runId: claims.run_id, repository,
    }));
  });

  router.get("/mcp/runtime-tools", async (req, res) => {
    await service.validate(runtimeClaims(req));
    res.json({ name: "paperclip-runtime-tools", protocolVersion: "2025-03-26" });
  });

  router.post("/mcp/runtime-tools", async (req, res) => {
    const claims = runtimeClaims(req);
    // Streamable HTTP lifecycle calls are token uses too. Revalidate the bound
    // run before initialize/list as well as before an actual tool call so an
    // ended heartbeat cannot keep probing the endpoint with a once-valid token.
    await service.validate(claims);
    const request = req.body as { jsonrpc?: string; id?: unknown; method?: string; params?: unknown };
    const id = request.id ?? null;
    if (request.method === "initialize") {
      res.json({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "paperclip-runtime-tools", version: "1" },
        },
      });
      return;
    }
    if (request.method === "notifications/initialized") {
      res.status(202).end();
      return;
    }
    if (request.method === "tools/list") {
      res.json({
        jsonrpc: "2.0",
        id,
        result: {
          tools: RUNTIME_INTENT_TOOL_DEFINITIONS,
        },
      });
      return;
    }
    if (request.method === "tools/call") {
      const params = request.params && typeof request.params === "object"
        ? request.params as { name?: unknown; arguments?: unknown }
        : {};
      const name = typeof params.name === "string" ? params.name : "";
      if (name === "connections_search") {
        const input = connectionsSearchInputSchema.parse(params.arguments ?? {});
        const result = await service.search(claims, input.query);
        res.json({ jsonrpc: "2.0", id, result: resultContent(result) });
        return;
      }
      if (name === "connection_request") {
        const input = connectionRequestInputSchema.parse(params.arguments ?? {});
        const result = await service.request(claims, input.service);
        res.json({ jsonrpc: "2.0", id, result: resultContent(result) });
        return;
      }
      if (name === "pull_request_ci_status") {
        const args = (params.arguments && typeof params.arguments === "object"
          ? params.arguments
          : {}) as { repository?: unknown; pullNumber?: unknown };
        const ciResolver = createPullRequestCiResolver(db);

        if (args.repository !== undefined || args.pullNumber !== undefined) {
          if (
            typeof args.repository !== "string" ||
            !REPOSITORY_REGEX.test(args.repository) ||
            typeof args.pullNumber !== "number" ||
            !Number.isInteger(args.pullNumber) ||
            args.pullNumber <= 0
          ) {
            res.json({
              jsonrpc: "2.0",
              id,
              result: resultContent({
                error: "Invalid repository or pullNumber format. Expected repository as 'owner/repo' and pullNumber as a positive integer.",
              }),
            });
            return;
          }
          const [owner, repo] = args.repository.split("/");
          const result = await ciResolver.resolveForPullRequest(claims.company_id, {
            owner,
            repo,
            number: args.pullNumber,
          });
          res.json({ jsonrpc: "2.0", id, result: resultContent(result) });
          return;
        }

        const [run] = await db
          .select({ nativeIssueId: heartbeatRuns.nativeIssueId, contextSnapshot: heartbeatRuns.contextSnapshot })
          .from(heartbeatRuns)
          .where(and(eq(heartbeatRuns.id, claims.run_id), eq(heartbeatRuns.companyId, claims.company_id)));

        let issueId = run?.nativeIssueId ?? ((run?.contextSnapshot as any)?.issueId as string | undefined) ?? null;
        if (!issueId) {
          const [iss] = await db
            .select({ id: issues.id })
            .from(issues)
            .where(and(eq(issues.companyId, claims.company_id), eq(issues.executionRunId, claims.run_id)));
          issueId = iss?.id ?? null;
        }

        if (!issueId) {
          res.json({
            jsonrpc: "2.0",
            id,
            result: resultContent({ error: "No active issue associated with this run, and no repository/pullNumber provided" }),
          });
          return;
        }

        const prs = await ciResolver.resolveForIssue(claims.company_id, issueId);
        res.json({
          jsonrpc: "2.0",
          id,
          result: resultContent({
            issueId,
            pullRequests: prs,
            primaryCiResult: prs[0] ?? null,
          }),
        });
        return;
      }
      res.status(404).json({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Unknown tool: ${name || "missing"}` },
      });
      return;
    }
    res.status(404).json({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Unknown method: ${request.method ?? "missing"}` },
    });
  });

  router.post("/runtime-tools/connections/search", async (req, res) => {
    const input = connectionsSearchInputSchema.parse(req.body ?? {});
    res.json(await service.search(runtimeClaims(req), input.query));
  });
  router.post("/runtime-tools/connections/request", async (req, res) => {
    const input = connectionRequestInputSchema.parse(req.body ?? {});
    res.json(await service.request(runtimeClaims(req), input.service));
  });
  router.post("/runtime-tools/ci/status", async (req, res) => {
    const claims = runtimeClaims(req);
    await service.validate(claims);
    const ciResolver = createPullRequestCiResolver(db);
    const repository = req.body?.repository;
    const pullNumber = req.body?.pullNumber;

    if (repository !== undefined || pullNumber !== undefined) {
      if (
        typeof repository !== "string" ||
        !REPOSITORY_REGEX.test(repository) ||
        typeof pullNumber !== "number" ||
        !Number.isInteger(pullNumber) ||
        pullNumber <= 0
      ) {
        return res.status(400).json({
          error: "Invalid repository or pullNumber format. Expected repository as 'owner/repo' and pullNumber as a positive integer.",
        });
      }
      const [owner, repo] = repository.split("/");
      const result = await ciResolver.resolveForPullRequest(claims.company_id, {
        owner,
        repo,
        number: pullNumber,
      });
      return res.json(result);
    }

    const [run] = await db
      .select({ nativeIssueId: heartbeatRuns.nativeIssueId, contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id, claims.run_id), eq(heartbeatRuns.companyId, claims.company_id)));

    let issueId = run?.nativeIssueId ?? ((run?.contextSnapshot as any)?.issueId as string | undefined) ?? null;
    if (!issueId) {
      const [iss] = await db
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.companyId, claims.company_id), eq(issues.executionRunId, claims.run_id)));
      issueId = iss?.id ?? null;
    }

    if (!issueId) {
      return res.status(400).json({ error: "No issue found for run and no repository/pullNumber provided" });
    }

    const prs = await ciResolver.resolveForIssue(claims.company_id, issueId);
    return res.json({
      issueId,
      pullRequests: prs,
      primaryCiResult: prs[0] ?? null,
    });
  });
  return router;
}

type Heartbeat = ReturnType<typeof heartbeatService>;

export { wakeConnectionIntentAfterResolution } from "../services/connection-intent-delivery.js";
export function connectionIntentBoardRoutes(db: Db, heartbeat: Heartbeat) {
  const router = Router();
  const service = connectionIntentService(db);
  const access = accessService(db);

  function bypassCurrentMembershipCheck(req: Request) {
    return req.actor.source === "local_implicit" || req.actor.isInstanceAdmin === true;
  }

  async function canManageCompanyConnections(req: Request, companyId: string) {
    if (bypassCurrentMembershipCheck(req)) return true;
    return Boolean(req.actor.userId && await access.hasPermission(
      companyId,
      "user",
      req.actor.userId,
      "tools:manage_connections",
    ));
  }

  async function addressedIntent(req: Request) {
    assertBoard(req);
    const loaded = await service.loadIntent(req.params.interactionId as string);
    assertCompanyAccess(req, loaded.issue.companyId);
    const userId = req.actor.userId ?? "local-board";
    if (loaded.interaction.addresseeUserId !== userId) {
      throw forbidden("Only the addressed user can act on this connection request");
    }
    return { loaded, userId };
  }

  async function wakeAfterResolution(input: {
    loaded: Awaited<ReturnType<typeof service.loadIntent>>;
    status: string;
    actorId: string;
  }) {
    await connectionIntentDeliveryService(db, heartbeat).tryDeliver(input.loaded.interaction.id);
  }

  router.get("/connection-intents/:interactionId/setup-options", async (req, res) => {
    const { loaded } = await addressedIntent(req);
    res.json(await service.setupOptions(req.params.interactionId as string, {
      canManageOrganizationGrant: await canManageCompanyConnections(req, loaded.issue.companyId),
    }));
  });

  router.post("/connection-intents/:interactionId/phase", async (req, res) => {
    const { userId } = await addressedIntent(req);
    const phase = req.body?.phase;
    if (phase !== "requested" && phase !== "authorizing" && phase !== "needs_retry") {
      res.status(422).json({ error: "phase must be requested, authorizing, or needs_retry" });
      return;
    }
    res.json(await service.updatePhase(req.params.interactionId as string, phase, userId, {
      bypassCurrentMembershipCheck: bypassCurrentMembershipCheck(req),
    }));
  });

  router.post("/connection-intents/:interactionId/complete", async (req, res) => {
    const { loaded, userId } = await addressedIntent(req);
    const input = completeConnectionIntentSchema.parse(req.body);
    const interaction = await service.complete(loaded.interaction.id, input.connectionId, userId, {
      canManageOrganizationGrant: await canManageCompanyConnections(req, loaded.issue.companyId),
      bypassCurrentMembershipCheck: bypassCurrentMembershipCheck(req),
    });
    await logActivity(db, {
      companyId: loaded.issue.companyId,
      actorType: "user",
      actorId: userId,
      action: "issue.connection_intent_connected",
      entityType: "issue",
      entityId: loaded.issue.id,
      details: {
        interactionId: interaction.id,
        connectionId: interaction.result?.connectionId ?? null,
        requestingAgentId: interaction.payload.requestingAgentId,
      },
    });
    await wakeAfterResolution({ loaded, status: interaction.status, actorId: userId });
    res.json(interaction);
  });

  router.post("/connection-intents/:interactionId/decline", async (req, res) => {
    const { loaded, userId } = await addressedIntent(req);
    const input = declineConnectionIntentSchema.parse(req.body ?? {});
    const interaction = await service.decline(loaded.interaction.id, userId, input.reason, {
      bypassCurrentMembershipCheck: bypassCurrentMembershipCheck(req),
    });
    await logActivity(db, {
      companyId: loaded.issue.companyId,
      actorType: "user",
      actorId: userId,
      action: "issue.connection_intent_declined",
      entityType: "issue",
      entityId: loaded.issue.id,
      details: { interactionId: interaction.id, reason: input.reason ?? null },
    });
    await wakeAfterResolution({ loaded, status: interaction.status, actorId: userId });
    res.json(interaction);
  });

  return router;
}
