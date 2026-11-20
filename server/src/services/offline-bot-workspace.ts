import { and, eq, sql } from "drizzle-orm";
import { agents, executionWorkspaces, issues, type Db } from "@myrmidon/db";
import { z } from "zod";
import { conflict, notFound } from "../errors.js";
import { readBotContainerAgentConfig } from "../myrmidon/bot-containers/agent-config.js";
import { gatewayApiBaseUrl } from "../myrmidon/bot-containers/card-sync.js";
import { fleetGatewayApiBaseUrl } from "../myrmidon/bot-containers/fleetd-placement.js";
import { cardFleetHost } from "../myrmidon/bot-containers/fleetd-hosts.js";
import { getFleetSite } from "../myrmidon/bot-containers/site-registry.js";
import { getBotContainerRuntime } from "../myrmidon/bot-containers/routes-wiring.js";
import { secretService } from "./secrets.js";
import { BOT_CONTAINER_WORKSPACE_STRATEGY } from "./bot-container-workspace.js";

export const offlineWorkspaceKey = "offlineBotWorkspace";
const uuid = z.string().regex(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
export const offlineWorkspaceRequest = z.object({ botId: uuid, action: z.enum(["reserve", "register"]) }).strict();
const runtimeIdentity = z.object({
  cwd: z.string(), fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  physicalId: z.string().regex(/^\d+:\d+$/),
});
export const offlineWorkspaceRegistration = z.object({
  botId: uuid,
  cwd: z.string(),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  physicalId: z.string().regex(/^\d+:\d+$/),
}).strict();
type Registration = z.infer<typeof offlineWorkspaceRegistration>;

export function allowedOfflineWorkspacePath(companyId: string, issueId: string, input: Pick<Registration, "cwd" | "botId">) {
  return ["/data/hermes", "/bot/hermes", `/bot-scope/${input.botId}/hermes`].some(
    (home) => input.cwd === `${home}/offline-workspaces/${companyId}/${issueId}`,
  );
}

function isManagedHermes(adapterType: string, config: Record<string, unknown>) {
  return readBotContainerAgentConfig(adapterType, config).ok;
}

async function probeRuntime(db: Db, companyId: string, issueId: string, botId: string,
  config: Record<string, unknown>, action: "reserve" | "register") {
  const status = await getBotContainerRuntime()?.driver.status(botId);
  if (status?.state !== "running") throw conflict("Target bot runtime is not running");
  const host = cardFleetHost(config);
  const site = host ? await getFleetSite(db, companyId, host) : null;
  if (host && (site?.status !== "active" || !status.gatewayPort)) throw conflict("Target fleet site is unavailable");
  const url = site ? fleetGatewayApiBaseUrl(site.url, status.gatewayPort, { source: "registry" }) : gatewayApiBaseUrl(botId);
  const ref = z.object({ type: z.literal("secret_ref"), secretId: uuid, version: z.number().int().positive() }).safeParse(config.apiKey);
  if (!ref.success || config.apiBaseUrl !== url) throw conflict("Target gateway card is not synchronized");
  const key = await secretService(db).resolveSecretValue(companyId, ref.data.secretId, ref.data.version,
    { consumerType: "agent", consumerId: botId });
  const response = await fetch(new URL("/v1/offline-workspace", url), {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(5_000),
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ companyId, issueId, botId, action }),
  }).catch(() => null);
  if (!response?.ok) throw conflict("Target bot did not validate the offline workspace");
  return response.json().catch(() => null) as Promise<unknown>;
}

export async function registerOfflineBotWorkspace(db: Db, companyId: string, issueId: string,
  request: z.infer<typeof offlineWorkspaceRequest>, probe = probeRuntime) {
  return db.transaction(async (tx) => {
    const [issue] = await tx.select().from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId))).for("update");
    if (!issue) throw notFound("Issue not found");
    if (issue.workMode !== "standard" || !issue.projectId) throw conflict("A standard project issue is required");
    const [bot] = await tx.select().from(agents)
      .where(and(eq(agents.id, request.botId), eq(agents.companyId, companyId)));
    if (!bot || !isManagedHermes(bot.adapterType, bot.adapterConfig)) throw conflict("Managed Hermes bot required");

    const rows = await tx.select().from(executionWorkspaces).where(and(
      eq(executionWorkspaces.companyId, companyId), eq(executionWorkspaces.sourceIssueId, issueId),
      sql`${executionWorkspaces.metadata} ? ${offlineWorkspaceKey}`,
    ));
    if (!rows.length && (issue.executionRunId || issue.checkoutRunId || issue.executionWorkspaceId ||
        issue.assigneeAgentId || issue.assigneeUserId)) {
      throw conflict("Reserve/register before swarm assignment; existing bindings are not replaced");
    }
    const measured = await probe(db, companyId, issueId, request.botId, bot.adapterConfig, request.action);
    const path = z.object({ cwd: z.string() }).safeParse(measured);
    if (!path.success || !allowedOfflineWorkspacePath(companyId, issueId, { ...path.data, botId: request.botId })) {
      throw conflict("Invalid offline workspace path");
    }
    if (request.action === "reserve") {
      if (rows.length) throw conflict("Issue already has an offline workspace binding");
      return { id: null, cwd: path.data.cwd };
    }
    const identity = runtimeIdentity.safeParse(measured);
    if (!identity.success) throw conflict("Target bot did not attest an existing standalone checkout");
    const input = { botId: request.botId, ...identity.data };
    if (rows.length > 0) {
      const [existing] = rows;
      const saved = offlineWorkspaceRegistration.safeParse(existing.metadata?.[offlineWorkspaceKey]);
      if (rows.length !== 1 || existing.id !== issue.executionWorkspaceId || existing.status !== "active" ||
          existing.cwd !== input.cwd || !saved.success || saved.data.botId !== input.botId ||
          saved.data.fingerprint !== input.fingerprint || saved.data.physicalId !== input.physicalId || saved.data.cwd !== input.cwd) {
        throw conflict("Offline workspace already exists with a different binding");
      }
      return existing;
    }
    // Serialize claims even across different issue rows. Be conservative if devices on
    // different hosts report the same device/inode pair.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`offline-workspace:${input.physicalId}`}, 0))`);
    const [claimed] = await tx.select({ id: executionWorkspaces.id }).from(executionWorkspaces)
      .where(sql`${executionWorkspaces.metadata} -> ${offlineWorkspaceKey} ->> 'physicalId' = ${input.physicalId}`).limit(1);
    if (claimed) throw conflict("Physical directory already belongs to another issue");
    const [workspace] = await tx.insert(executionWorkspaces).values({
      companyId, projectId: issue.projectId, projectWorkspaceId: issue.projectWorkspaceId,
      sourceIssueId: issueId, name: issue.identifier ?? issueId, mode: "isolated_workspace",
      strategyType: BOT_CONTAINER_WORKSPACE_STRATEGY, providerType: "adapter_managed",
      cwd: input.cwd, metadata: { [offlineWorkspaceKey]: input },
    }).returning();
    await tx.update(issues).set({
      executionWorkspaceId: workspace.id, executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { ...issue.executionWorkspaceSettings, mode: "isolated_workspace" },
      updatedAt: new Date(),
    }).where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)));
    return workspace;
  });
}

export function listOfflineBotWorkspaceBindings(db: Db, companyId: string, issueId: string) {
  return db.select().from(executionWorkspaces).where(and(
    eq(executionWorkspaces.companyId, companyId), eq(executionWorkspaces.sourceIssueId, issueId),
    sql`${executionWorkspaces.metadata} ? ${offlineWorkspaceKey}`,
  ));
}

export async function offlineBotAcceptsIssue(db: Db, companyId: string, issueId: string, botId: string) {
  const rows = await listOfflineBotWorkspaceBindings(db, companyId, issueId);
  if (rows.length === 0) return true;
  const binding = offlineWorkspaceRegistration.safeParse(rows[0].metadata?.[offlineWorkspaceKey]);
  return rows.length === 1 && rows[0].status === "active" && binding.success && binding.data.botId === botId;
}

export async function resolveOfflineBotWorkspace(db: Db, input: {
  companyId: string; issueId: string; requestedId: string | null; projectId: string | null;
  botId: string; adapterType: string; adapterConfig: Record<string, unknown>;
  mode: string; wakeReason: string | null;
}) {
  const owned = await db.select().from(executionWorkspaces).where(and(
    eq(executionWorkspaces.companyId, input.companyId), eq(executionWorkspaces.sourceIssueId, input.issueId),
    sql`${executionWorkspaces.metadata} ? ${offlineWorkspaceKey}`,
  ));
  if (!owned.length) {
    if (input.requestedId) {
      const [requested] = await db.select({ metadata: executionWorkspaces.metadata }).from(executionWorkspaces)
        .where(eq(executionWorkspaces.id, input.requestedId));
      if (requested?.metadata && offlineWorkspaceKey in requested.metadata) {
        throw conflict("Offline workspace is owned by a different issue; refusing fallback");
      }
    }
    return null;
  }
  const [row] = owned;
  const saved = offlineWorkspaceRegistration.safeParse(row.metadata?.[offlineWorkspaceKey]);
  if (owned.length !== 1 || row.id !== input.requestedId || row.projectId !== input.projectId ||
      row.status !== "active" || row.strategyType !== BOT_CONTAINER_WORKSPACE_STRATEGY ||
      input.mode !== "isolated_workspace" || !isManagedHermes(input.adapterType, input.adapterConfig) ||
      !["swarm_matched", "swarm_claim_queue", "idle_pickup"].includes(input.wakeReason ?? "") ||
      !saved.success || saved.data.botId !== input.botId || row.cwd !== saved.data.cwd ||
      !allowedOfflineWorkspacePath(input.companyId, input.issueId, saved.data)) {
    throw conflict("Offline bot workspace binding or runtime is incompatible; refusing fallback");
  }
  const measured = runtimeIdentity.safeParse(await probeRuntime(db, input.companyId, input.issueId, input.botId,
    input.adapterConfig, "register"));
  if (!measured.success || measured.data.cwd !== saved.data.cwd ||
      measured.data.fingerprint !== saved.data.fingerprint || measured.data.physicalId !== saved.data.physicalId) {
    throw conflict("Offline workspace changed in the target runtime; refusing fallback");
  }
  return { id: row.id, cwd: saved.data.cwd, field: {
    offlineCompanyId: input.companyId, offlineIssueId: input.issueId,
    offlineBotId: input.botId, offlineFingerprint: saved.data.fingerprint,
  } };
}
