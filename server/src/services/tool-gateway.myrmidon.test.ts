// myrmidon(1.6-AUTONOMY-GW): the autonomy matrix in the tool gateway.
//
// Acceptance criteria of OPE-4139, proven against the real gateway service
// over an embedded database with a fake remote MCP upstream:
//   1. a merge tool called by a role with `merge=forbidden` is refused with
//      403 `autonomy_forbidden` even on a direct call — before the access
//      policy and before any provider dispatch;
//   2. `external_message=approval_required` creates a tool action request
//      (the existing holding conveyor) and the tool executes after the human
//      approves, with `approvedActionRequestId`;
//   3. a tool without an action class behaves exactly as before: it runs
//      through the ordinary access-policy path.
//
// Neutral data only: company/agent uuids, 127.0.0.1.

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueThreadInteractions,
  issues,
  projects,
  toolActionRequests,
  toolApplications,
  toolCatalogEntries,
  toolCallEvents,
  connectionGrants,
  toolConnections,
  toolInvocations,
  toolProfileBindings,
  toolProfileEntries,
  toolProfiles,
} from "@paperclipai/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createToolGatewayService,
  ToolGatewayHttpError,
} from "./tool-gateway.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { mutateAutonomyDocument } from "../myrmidon/autonomy/store.js";
import {
  DEFAULT_TOOL_AUTONOMY_MAPPING,
  resolveToolAutonomyClass,
} from "../myrmidon/autonomy/tool-mapping.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const testToolActionSigningSecret = "test-tool-action-signing-secret";

type Db = ReturnType<typeof createDb>;

// ---------------------------------------------------------------------------
// The mapping unit half: classification is the first acceptance question
// ("which tool is governed at all"), so it is pinned here without a database.
// ---------------------------------------------------------------------------

describe("myrmidon(1.6-AUTONOMY-GW) tool -> action class mapping", () => {
  it("classifies merge, deploy and external_message tool names by the built-in defaults", () => {
    expect(resolveToolAutonomyClass("merge_pull_request", DEFAULT_TOOL_AUTONOMY_MAPPING)).toBe("merge");
    expect(resolveToolAutonomyClass("mcp.github-abc12345:merge_pull_request", DEFAULT_TOOL_AUTONOMY_MAPPING)).toBe("merge");
    expect(resolveToolAutonomyClass("send_email", DEFAULT_TOOL_AUTONOMY_MAPPING)).toBe("external_message");
    expect(resolveToolAutonomyClass("mcp.gmail-ab12cd34:send_message", DEFAULT_TOOL_AUTONOMY_MAPPING)).toBe("external_message");
    expect(resolveToolAutonomyClass("deploy", DEFAULT_TOOL_AUTONOMY_MAPPING)).toBe("deploy");
    expect(resolveToolAutonomyClass("kubernetes_apply", DEFAULT_TOOL_AUTONOMY_MAPPING)).toBe("deploy");
  });

  it("leaves a tool without a class unclassified — it is not governed by the matrix", () => {
    expect(resolveToolAutonomyClass("kv_set", DEFAULT_TOOL_AUTONOMY_MAPPING)).toBeNull();
    expect(resolveToolAutonomyClass("mcp-remote-fixture:add", DEFAULT_TOOL_AUTONOMY_MAPPING)).toBeNull();
  });

  it("a custom mapping overrides the built-in defaults and can add classes", () => {
    const custom = [
      { tool: "kv_set", actionClass: "delete" as const },
    ];
    expect(resolveToolAutonomyClass("kv_set", custom)).toBe("delete");
    expect(resolveToolAutonomyClass("send_email", custom)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The gateway half: the three acceptance criteria over the real service.
// ---------------------------------------------------------------------------

describeEmbeddedPostgres("myrmidon(1.6-AUTONOMY-GW) gateway enforcement", () => {
  let db: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  // The fake remote MCP upstream: every tools/call answers ok, and the calls
  // are recorded so a forbidden action can be proven to never reach it.
  const upstreamCalls: Array<Record<string, unknown>> = [];
  let fakeUpstream: { url: string; close: () => Promise<void> };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tool-gateway-autonomy-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeAll(async () => {
    const server = createServer((req: IncomingMessage, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let body: Record<string, unknown> | null = null;
        try {
          body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
        } catch {
          body = null;
        }
        upstreamCalls.push(body ?? {});
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body?.id,
            result: {
              content: [
                {
                  type: "text",
                  text: `ok ${(body?.params as Record<string, unknown> | undefined)?.name ?? ""}`.trim(),
                },
              ],
            },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) {
      throw new Error("Fake upstream did not start");
    }
    fakeUpstream = {
      url: `http://127.0.0.1:${address.port}/mcp`,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  });

  afterAll(async () => {
    await fakeUpstream?.close();
    await tempDb?.cleanup();
  });

  beforeEach(() => {
    upstreamCalls.length = 0;
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(toolCallEvents);
    await db.delete(issueThreadInteractions);
    await db.delete(toolActionRequests);
    await db.delete(toolInvocations);
    await db.delete(toolCatalogEntries);
    await db.delete(toolConnections);
    await db.delete(connectionGrants);
    await db.delete(toolApplications);
    await db.delete(toolProfileEntries);
    await db.delete(toolProfileBindings);
    await db.delete(toolProfiles);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  async function createCompany() {
    const [row] = await db
      .insert(companies)
      .values({
        name: `Autonomy ${randomUUID()}`,
        issuePrefix: `AG${randomUUID().slice(0, 6).toUpperCase()}`,
      })
      .returning();
    return row!;
  }

  async function createAgent(companyId: string, role: string) {
    const [row] = await db
      .insert(agents)
      .values({
        companyId,
        name: `Agent ${randomUUID()}`,
        role,
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      })
      .returning();
    return row!;
  }

  async function createIssueAndRun(companyId: string, agentId: string) {
    const [project] = await db
      .insert(projects)
      .values({ companyId, name: `Project ${randomUUID()}` })
      .returning();
    const [issue] = await db
      .insert(issues)
      .values({
        companyId,
        projectId: project!.id,
        title: `Autonomy issue ${randomUUID()}`,
        status: "in_progress",
        assigneeAgentId: agentId,
      })
      .returning();
    const [run] = await db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "running",
        contextSnapshot: { issueId: issue!.id, projectId: project!.id },
      })
      .returning();
    return { project: project!, issue: issue!, run: run! };
  }

  async function allowToolForAgent(companyId: string, agentId: string, toolName: string) {
    const [profile] = await db
      .insert(toolProfiles)
      .values({
        companyId,
        profileKey: `autonomy-${randomUUID()}`,
        name: `Autonomy profile ${randomUUID()}`,
        defaultAction: "deny",
      })
      .returning();
    await db.insert(toolProfileBindings).values({
      companyId,
      profileId: profile!.id,
      targetType: "agent",
      targetId: agentId,
    });
    await db.insert(toolProfileEntries).values({
      companyId,
      profileId: profile!.id,
      selectorType: "tool_name",
      effect: "include",
      toolName,
    });
    return profile!;
  }

  /** Write the autonomy matrix the production store reads (instance settings). */
  async function setMatrix(rules: { role: string; actionClass: string; verdict: string }[]) {
    await mutateAutonomyDocument(db, (current) => ({
      next: {
        ...current,
        matrix: {
          ...current.matrix,
          version: current.matrix.version + 1,
          rules: rules.map((rule) => ({
            role: rule.role,
            actionClass: rule.actionClass as never,
            verdict: rule.verdict as never,
          })),
        },
      },
      result: null,
    }));
  }

  async function clearMatrix() {
    await mutateAutonomyDocument(db, (current) => ({
      next: { ...current, matrix: { ...current.matrix, rules: [] } },
      result: null,
    }));
  }

  function createGateway() {
    return createToolGatewayService(db, {
      toolActionSigningSecret: testToolActionSigningSecret,
    });
  }

  /** Install a connected remote MCP tool with the given upstream tool name. */
  async function connectRemoteTool(companyId: string, toolName: string, applicationKey: string) {
    const [application] = await db
      .insert(toolApplications)
      .values({
        companyId,
        name: `App ${applicationKey} ${randomUUID()}`,
        applicationKey,
        type: "mcp_http",
        status: "active",
      })
      .returning();
    const [connection] = await db
      .insert(toolConnections)
      .values({
        companyId,
        applicationId: application!.id,
        name: `Connection ${applicationKey}`,
        uid: `test/${randomUUID()}`,
        transport: "mcp_remote",
        status: "active",
        enabled: true,
        healthStatus: "ok",
        config: { url: fakeUpstream.url },
        transportConfig: { url: fakeUpstream.url, sourceTemplateKey: "custom", endpointUrl: fakeUpstream.url, method: "http" },
      })
      .returning();
    await db.insert(connectionGrants).values({
      companyId,
      connectionId: connection!.id,
      kind: "organization",
      credentialSecretRefs: connection!.credentialSecretRefs,
      status: "active",
      isDefault: true,
    });
    const [catalogEntry] = await db
      .insert(toolCatalogEntries)
      .values({
        companyId,
        applicationId: application!.id,
        connectionId: connection!.id,
        entryKind: "tool",
        name: `${toolName}-${randomUUID()}`,
        toolName,
        title: toolName,
        description: `Call ${toolName}`,
        inputSchema: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false },
        riskLevel: "write",
        isReadOnly: false,
        isWrite: true,
        isDestructive: false,
        status: "active",
        versionHash: randomUUID(),
      })
      .returning();
    return { application: application!, connection: connection!, catalogEntry: catalogEntry! };
  }

  function gatewayToolName(connectionId: string, applicationKey: string, toolName: string) {
    const applicationSegment =
      applicationKey
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 64) || "mcp";
    const toolSegment =
      toolName
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 64) || "tool";
    return `mcp.${applicationSegment}-${connectionId.replace(/-/g, "").slice(0, 8)}:${toolSegment}`;
  }

  function expectGatewayError(error: unknown, status: number, reasonCode: string) {
    expect(error).toBeInstanceOf(ToolGatewayHttpError);
    const gatewayError = error as ToolGatewayHttpError;
    expect(gatewayError.status).toBe(status);
    expect(gatewayError.reasonCode).toBe(reasonCode);
  }

  it("refuses a merge tool for a role with merge=forbidden, even on a direct call", async () => {
    await setMatrix([{ role: "engineer", actionClass: "merge", verdict: "forbidden" }]);
    try {
      const company = await createCompany();
      const agent = await createAgent(company.id, "engineer");
      const { run } = await createIssueAndRun(company.id, agent.id);
      const tool = await connectRemoteTool(company.id, "merge_pull_request", "github");
      const toolName = gatewayToolName(tool.connection.id, "github", "merge_pull_request");
      await allowToolForAgent(company.id, agent.id, toolName);

      const gateway = createGateway();
      const session = await gateway.createSession({
        companyId: company.id,
        agentId: agent.id,
        runId: run.id,
      });

      await gateway
        .executeTool({
          sessionToken: session.token,
          tool: toolName,
          parameters: { message: "merge it" },
        })
        .then(
          () => {
            throw new Error("Expected the merge tool call to be refused by the autonomy matrix");
          },
          (error) => expectGatewayError(error, 403, "autonomy_forbidden"),
        );

      // The upstream never saw the call.
      expect(upstreamCalls.length).toBe(0);
      // No action request: a forbidden action leaves nothing to approve.
      const requests = await db
        .select()
        .from(toolActionRequests)
        .where(eq(toolActionRequests.companyId, company.id));
      expect(requests.length).toBe(0);
    } finally {
      await clearMatrix();
    }
  });

  it("holds an external_message tool behind tool_action_requests when the verdict is approval_required, and executes after approval", async () => {
    await setMatrix([
      { role: "engineer", actionClass: "external_message", verdict: "approval_required" },
    ]);
    try {
      const company = await createCompany();
      const agent = await createAgent(company.id, "engineer");
      const { issue, run } = await createIssueAndRun(company.id, agent.id);
      const tool = await connectRemoteTool(company.id, "send_email", "gmail");
      const toolName = gatewayToolName(tool.connection.id, "gmail", "send_email");
      await allowToolForAgent(company.id, agent.id, toolName);

      const gateway = createGateway();
      const session = await gateway.createSession({
        companyId: company.id,
        agentId: agent.id,
        runId: run.id,
      });

      // The direct call is held: 409 approval_required, an action request row
      // exists, and the upstream has not been called.
      await gateway
        .executeTool({
          sessionToken: session.token,
          tool: toolName,
          parameters: { message: "hello" },
        })
        .then(
          () => {
            throw new Error("Expected the external_message tool call to require approval");
          },
          (error) => expectGatewayError(error, 409, "approval_required"),
        );
      expect(upstreamCalls.length).toBe(0);

      const [request] = await db
        .select()
        .from(toolActionRequests)
        .where(eq(toolActionRequests.companyId, company.id));
      expect(request).toMatchObject({
        issueId: issue.id,
        status: "pending",
      });

      // The human approves: the same path the vendor test drives — resolve the
      // interaction and the action request, then replay the held call with
      // approvedActionRequestId (execution-on-approve re-dispatch).
      await db
        .update(issueThreadInteractions)
        .set({
          status: "accepted",
          result: { version: 1, outcome: "accepted" },
          resolvedByUserId: "board-user",
          resolvedAt: new Date(),
        })
        .where(eq(issueThreadInteractions.id, request!.interactionId!));
      await db
        .update(toolActionRequests)
        .set({
          status: "approved",
          resolvedByUserId: "board-user",
          decidedByUserId: "board-user",
          decidedAt: new Date(),
          resolvedAt: new Date(),
        })
        .where(eq(toolActionRequests.id, request!.id));
      const approval = await gateway.executeTool({
        sessionToken: session.token,
        tool: toolName,
        parameters: { message: "hello" },
        approvedActionRequestId: request!.id,
      });
      expect(approval).toMatchObject({ status: "completed", tool: toolName });
      expect(upstreamCalls.length).toBe(1);

      const [executedRequest] = await db
        .select()
        .from(toolActionRequests)
        .where(eq(toolActionRequests.id, request!.id));
      expect(executedRequest!.status).toBe("executed");
    } finally {
      await clearMatrix();
    }
  });

  it("runs an unclassified tool exactly as before: no matrix consultation, ordinary policy path", async () => {
    // Even a fully restrictive matrix must not touch a tool with no class.
    await setMatrix([
      { role: "engineer", actionClass: "merge", verdict: "forbidden" },
      { role: "engineer", actionClass: "external_message", verdict: "forbidden" },
      { role: "engineer", actionClass: "deploy", verdict: "forbidden" },
    ]);
    try {
      const company = await createCompany();
      const agent = await createAgent(company.id, "engineer");
      const { run } = await createIssueAndRun(company.id, agent.id);
      const tool = await connectRemoteTool(company.id, "kv_lookup", "kv");
      const toolName = gatewayToolName(tool.connection.id, "kv", "kv_lookup");
      await allowToolForAgent(company.id, agent.id, toolName);

      const gateway = createGateway();
      const session = await gateway.createSession({
        companyId: company.id,
        agentId: agent.id,
        runId: run.id,
      });

      const result = await gateway.executeTool({
        sessionToken: session.token,
        tool: toolName,
        parameters: { message: "plain" },
      });
      expect(result).toMatchObject({ status: "completed", tool: toolName });
      expect(upstreamCalls.length).toBe(1);
    } finally {
      await clearMatrix();
    }
  });

  it("does not apply the matrix to a non-agent caller (Test-tab call)", async () => {
    await setMatrix([{ role: "engineer", actionClass: "merge", verdict: "forbidden" }]);
    try {
      const company = await createCompany();
      const agent = await createAgent(company.id, "engineer");
      const tool = await connectRemoteTool(company.id, "merge_pull_request", "github2");
      await allowToolForAgent(company.id, agent.id, gatewayToolName(tool.connection.id, "github2", "merge_pull_request"));

      const gateway = createGateway();
      // A board/user Test-tab call: the session is a user session (no agent
      // actor), so the matrix is not consulted — by design, the board is the
      // actor that edits the matrix and is not governed by it.
      const decision = await gateway.executeTestCall({
        companyId: company.id,
        connectionId: tool.connection.id,
        agentId: agent.id,
        userId: "board-user",
        toolName: "merge_pull_request",
        parameters: { message: "board call" },
      });
      expect(decision).toMatchObject({ decision: "allowed" });
    } finally {
      await clearMatrix();
    }
  });
});

