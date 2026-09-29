// server/src/myrmidon/bot-containers/board-gateway-ports.ts
//
// myrmidon(W2a): the database-bound operations behind board-gateway.ts, kept thin:
// every rule (when a gateway is made, when its token rotates, what is released)
// lives in board-gateway.ts, tested against fakes. What is left here is the glue
// to the board's tool access and tool gateway services.
//
// The agent's assignment is resolved the way a hermes_local run resolves it
// (buildPaperclipRuntimeMcpServers in services/heartbeat.ts): the same profiles,
// the same enabled/active filter, the same digest and the same immutable
// `native:<agentId>:<digest>` profile with deny by default, so a bot and a local
// run of one agent with one assignment share a profile. The difference is that a
// container has no run, hence no responsible user: a connection that needs the
// run's personal identity (a user's own GitHub OAuth) is left out and reported.
// When the run-scoped resolution is extracted into a shared module, this function
// is replaced by a call to it.

import { createHash } from "node:crypto";

import { toolMcpGateways, toolMcpGatewayTokens, toolProfiles, type Db } from "@paperclipai/db";
import { and, eq, isNull } from "drizzle-orm";
import { filterResolvedGitHubConnectionsForRun } from "../../services/git-credentials.js";
import { toolAccessService } from "../../services/tool-access.js";
import { createToolGatewayService } from "../../services/tool-gateway.js";
import { isRunSelectableConnection, isRunUnavailableConnection } from "../tool-gateway-run-selection.js";
import {
  BOT_GATEWAY_SOURCE,
  BOT_GATEWAY_TOKEN_NAME,
  type BotBoardGatewayDeps,
  type BotGatewayRecord,
  type BotToolAssignment,
} from "./board-gateway.js";

export interface BotGatewayAgent {
  id: string;
  companyId: string;
  name: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function nameList(items: ReadonlyArray<{ name: string }>): string {
  return items
    .map((item) => item.name)
    .sort((a, b) => a.localeCompare(b))
    .join(", ");
}

export async function resolveBotToolAssignment(
  db: Db,
  agent: BotGatewayAgent,
): Promise<{ assignment: BotToolAssignment | null; warnings: string[] }> {
  const access = toolAccessService(db);
  const warnings: string[] = [];
  const effective = await access.getEffectiveProfilesForAgent(agent.companyId, agent.id);
  // No run means no responsible user: only what the agent's own (managed) identity opens is kept.
  const resolvedInstalledConnections = await filterResolvedGitHubConnectionsForRun({
    db,
    companyId: agent.companyId,
    agentId: agent.id,
    responsibleUserId: null,
    connections: effective.installedConnections,
  });
  const permittedConnectionIds = new Set([
    ...effective.entries
      .filter((entry) => entry.effect === "include" && entry.connectionId)
      .map((entry) => entry.connectionId!),
    ...effective.allowedTools.map((tool) => tool.connectionId),
  ]);
  const assignedConnections = resolvedInstalledConnections.filter(
    (connection) => permittedConnectionIds.has(connection.id) && isRunSelectableConnection(connection),
  );
  const unavailable = resolvedInstalledConnections.filter(
    (connection) => permittedConnectionIds.has(connection.id) && isRunUnavailableConnection(connection),
  );
  const resolvedIds = new Set(resolvedInstalledConnections.map((connection) => connection.id));
  const needsRunIdentity = effective.installedConnections.filter(
    (connection) => permittedConnectionIds.has(connection.id) && !resolvedIds.has(connection.id),
  );
  if (unavailable.length) {
    warnings.push(`board gateway: assigned connections that are disabled or inactive are left out: ${nameList(unavailable)}`);
  }
  if (needsRunIdentity.length) {
    warnings.push(
      `board gateway: assigned connections that need a run's personal identity are left out of a container: ${nameList(needsRunIdentity)}`,
    );
  }
  if (assignedConnections.length === 0) return { assignment: null, warnings };

  const assignedConnectionIds = new Set(assignedConnections.map((connection) => connection.id));
  const assignedTools = effective.allowedTools.filter((tool) => assignedConnectionIds.has(tool.connectionId));
  const assignmentDigest = createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        agentId: agent.id,
        connections: assignedConnections.map((connection) => connection.id).sort(),
        tools: assignedTools.map((tool) => tool.id).sort(),
      }),
    )
    .digest("hex");

  async function ensureProfile(): Promise<string> {
    const profileKey = `native:${agent.id}:${assignmentDigest}`;
    const findProfile = async () => {
      const [row] = await db
        .select({ id: toolProfiles.id })
        .from(toolProfiles)
        .where(and(eq(toolProfiles.companyId, agent.companyId), eq(toolProfiles.profileKey, profileKey)))
        .limit(1);
      return row?.id ?? null;
    };
    const existing = await findProfile();
    if (existing) return existing;

    const fullConnectionIds = new Set(
      effective.entries
        .filter((entry) => entry.effect === "include" && entry.selectorType === "connection" && entry.connectionId)
        .map((entry) => entry.connectionId!),
    );
    const entries = [
      ...assignedConnections
        .filter((connection) => fullConnectionIds.has(connection.id))
        .map((connection) => ({
          selectorType: "connection" as const,
          effect: "include" as const,
          applicationId: connection.applicationId,
          connectionId: connection.id,
        })),
      ...assignedTools
        .filter((tool) => !fullConnectionIds.has(tool.connectionId))
        .map((tool) => ({
          selectorType: "catalog_entry" as const,
          effect: "include" as const,
          applicationId: tool.applicationId,
          connectionId: tool.connectionId,
          catalogEntryId: tool.id,
        })),
    ];
    try {
      const created = await access.createProfile(agent.companyId, {
        profileKey,
        name: `Native ${agent.id.slice(0, 8)} ${assignmentDigest.slice(0, 12)}`,
        description: "Immutable Paperclip Runner MCP assignment profile.",
        status: "active",
        defaultAction: "deny",
        metadata: {
          source: "paperclip_runner",
          agentId: agent.id,
          assignmentDigest,
        },
        entries,
      });
      return created.id;
    } catch (err) {
      // A parallel create (a local run of the same agent) won: use its profile.
      const raced = await findProfile();
      if (!raced) throw err;
      return raced;
    }
  }

  return { assignment: { digest: assignmentDigest, ensureProfile }, warnings };
}

/**
 * The gateway operations for one bot. `readSecret`/`storeSecret` are the bot's
 * gateway-token secret (profile-ports.ts owns the secrets service).
 */
export function createBotBoardGatewayDeps(
  db: Db,
  agent: BotGatewayAgent,
  secret: Pick<BotBoardGatewayDeps, "readSecret" | "storeSecret">,
): BotBoardGatewayDeps {
  const gateways = createToolGatewayService(db);

  function toRecord(row: typeof toolMcpGateways.$inferSelect): BotGatewayRecord {
    const digest = asRecord(row.metadata).assignmentDigest;
    return { id: row.id, publicId: row.gatewayPublicId, digest: typeof digest === "string" ? digest : "" };
  }

  return {
    resolveAssignment: () => resolveBotToolAssignment(db, agent),

    async listGateways() {
      const rows = await db
        .select()
        .from(toolMcpGateways)
        .where(
          and(
            eq(toolMcpGateways.companyId, agent.companyId),
            eq(toolMcpGateways.agentId, agent.id),
            eq(toolMcpGateways.status, "active"),
            isNull(toolMcpGateways.archivedAt),
          ),
        );
      // Only gateways made here: a gateway an operator made by hand for the same agent is not ours to disable.
      return rows.filter((row) => asRecord(row.metadata).source === BOT_GATEWAY_SOURCE).map(toRecord);
    },

    async createGateway({ digest, profileId }) {
      const slug = `container-${agent.id.replaceAll("-", "").slice(0, 12)}-${digest.slice(0, 16)}`;
      const findBySlug = async () => {
        const [row] = await db
          .select()
          .from(toolMcpGateways)
          .where(and(eq(toolMcpGateways.companyId, agent.companyId), eq(toolMcpGateways.slug, slug)))
          .limit(1);
        return row ?? null;
      };
      const adopt = async (row: typeof toolMcpGateways.$inferSelect): Promise<BotGatewayRecord> => {
        // The slug is derived from the bot and the digest, so a hit is ours unless something else took the name.
        if (row.agentId !== agent.id || asRecord(row.metadata).source !== BOT_GATEWAY_SOURCE || row.archivedAt) {
          throw new Error(`gateway slug ${slug} is taken by a gateway that is not this bot's`);
        }
        // An assignment that came back after another one: its gateway (and profile) are still there, disabled.
        if (row.status !== "active") {
          await gateways.updateNamedGateway({ companyId: agent.companyId, gatewayId: row.id, body: { status: "active" } });
        }
        return { id: row.id, publicId: row.gatewayPublicId, digest };
      };

      const existing = await findBySlug();
      if (existing) return adopt(existing);
      try {
        const created = await gateways.createNamedGateway({
          companyId: agent.companyId,
          body: {
            name: `Container ${agent.id.slice(0, 8)} ${digest.slice(0, 8)}`,
            slug,
            description: "Board tool gateway of a bot container.",
            profileId,
            defaultProfileMode: "gateway_only",
            contextScopeType: "none",
            agentId: agent.id,
            metadata: { source: BOT_GATEWAY_SOURCE, agentId: agent.id, assignmentDigest: digest },
          },
        });
        return { id: created.id, publicId: created.gatewayPublicId, digest };
      } catch (err) {
        const raced = await findBySlug();
        if (!raced) throw err;
        return adopt(raced);
      }
    },

    async disableGateway(gatewayId) {
      await gateways.updateNamedGateway({ companyId: agent.companyId, gatewayId, body: { status: "disabled" } });
    },

    readSecret: secret.readSecret,
    storeSecret: secret.storeSecret,

    async findLiveTokenByValue(gatewayId, token) {
      const [row] = await db
        .select({
          id: toolMcpGatewayTokens.id,
          createdAt: toolMcpGatewayTokens.createdAt,
          expiresAt: toolMcpGatewayTokens.expiresAt,
        })
        .from(toolMcpGatewayTokens)
        .where(
          and(
            eq(toolMcpGatewayTokens.companyId, agent.companyId),
            eq(toolMcpGatewayTokens.gatewayId, gatewayId),
            eq(toolMcpGatewayTokens.tokenHash, createHash("sha256").update(token).digest("hex")),
            isNull(toolMcpGatewayTokens.revokedAt),
          ),
        )
        .limit(1);
      return row ? { id: row.id, createdAt: row.createdAt, expiresAt: row.expiresAt } : null;
    },

    async listActiveTokens(gatewayId) {
      const rows = await db
        .select({
          id: toolMcpGatewayTokens.id,
          createdAt: toolMcpGatewayTokens.createdAt,
          expiresAt: toolMcpGatewayTokens.expiresAt,
        })
        .from(toolMcpGatewayTokens)
        .where(
          and(
            eq(toolMcpGatewayTokens.companyId, agent.companyId),
            eq(toolMcpGatewayTokens.gatewayId, gatewayId),
            eq(toolMcpGatewayTokens.name, BOT_GATEWAY_TOKEN_NAME),
            isNull(toolMcpGatewayTokens.revokedAt),
          ),
        );
      return rows.map((row) => ({ id: row.id, createdAt: row.createdAt, expiresAt: row.expiresAt }));
    },

    async createToken(gatewayId, expiresAt) {
      const created = await gateways.createNamedGatewayToken({
        companyId: agent.companyId,
        gatewayId,
        body: {
          name: BOT_GATEWAY_TOKEN_NAME,
          subjectType: "gateway_client",
          clientLabel: `${agent.name} bot container`,
          ownerNote: "Board tool gateway token of a bot container; issued and rotated by the board, stored as a company secret.",
          allowedActions: ["tools/list", "tools/call"],
          expiresAt,
        },
      });
      return { id: created.id, token: created.token };
    },

    async revokeToken(tokenId) {
      await gateways.revokeNamedGatewayToken({ companyId: agent.companyId, tokenId });
    },
  };
}
