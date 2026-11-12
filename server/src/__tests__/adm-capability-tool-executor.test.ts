import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  toolApplications,
  toolConnections,
  createDb,
  type Db,
} from "@myrmidon/db";
import { eq } from "drizzle-orm";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createAdmCapabilityToolExecutor } from "../services/adm-capability-tool-executor.js";
import type { AdmActorContext } from "../services/adm-access-request.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("adm capability tool executor (OPE-12766)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let connectionId!: string;
  let connectionName!: string;
  const cleanupCompanies: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-adm-capability-executor-");
    db = createDb(tempDb.connectionString);
    const company = await db
      .insert(companies)
      .values({
        name: `ADM Executor ${randomUUID()}`,
        issuePrefix: `AX${randomUUID().slice(0, 6).toUpperCase()}`,
      })
      .returning()
      .then((rows) => rows[0]!);
    companyId = company.id;
    cleanupCompanies.push(company.id);

    const agent = await db
      .insert(agents)
      .values({
        companyId,
        name: "executor-agent",
        urlKey: `executor-agent-${randomUUID().slice(0, 8)}`,
        role: "engineer",
        title: "executor agent",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        budgetMonthlyCents: 0,
        spentMonthlyCents: 0,
        permissions: { canCreateAgents: false },
      })
      .returning()
      .then((rows) => rows[0]!);

    const application = await db
      .insert(toolApplications)
      .values({
        companyId,
        name: `executor-app-${randomUUID().slice(0, 8)}`,
        type: "mcp_http",
        status: "active",
      })
      .returning()
      .then((rows) => rows[0]!);

    connectionName = "geo-lookup";
    const connection = await db
      .insert(toolConnections)
      .values({
        companyId,
        applicationId: application.id,
        name: connectionName,
        uid: `executor-conn-${randomUUID().slice(0, 8)}`,
        transport: "mcp_remote",
        authKind: "none",
        status: "active",
        enabled: true,
      })
      .returning()
      .then((rows) => rows[0]!);
    connectionId = connection.id;
  }, 20_000);

  afterAll(async () => {
    await db.delete(toolConnections).where(eq(toolConnections.companyId, companyId));
    await db.delete(toolApplications).where(eq(toolApplications.companyId, companyId));
    await db.delete(agents).where(eq(agents.companyId, companyId));
    await db.delete(companies).where(eq(companies.id, companyId));
    await tempDb?.cleanup();
  });

  function actor(): AdmActorContext {
    return {
      companyId,
      actorType: "agent",
      actorId: "actor-agent",
      agentId: "actor-agent",
      userId: null,
      runId: null,
      isInstanceAdmin: false,
    };
  }

  function baseInput(overrides: Record<string, unknown> = {}) {
    return {
      requestId: randomUUID(),
      sourceCompanyId: randomUUID(),
      targetCompanyId: companyId,
      resourceType: "tool",
      resourceRef: `tool:${connectionName}`,
      resourceKey: connectionName,
      action: "invoke_tool" as const,
      scope: { resourceKey: connectionName, operationKind: "invoke", parameters: { city: "Oslo" } },
      actor: actor(),
      ...overrides,
    };
  }

  it("invokes the real tool through the gateway executeTestCall path", async () => {
    const seen: Array<{ companyId: string; connectionId: string; toolName: string; parameters: unknown }> = [];
    const gateway = {
      async executeTestCall(input: { companyId: string; connectionId: string; toolName: string; parameters: unknown }) {
        seen.push(input);
        return { decision: "allowed" as const, invocationId: "inv-123", result: { temperatureC: 4 } };
      },
    };
    const executor = createAdmCapabilityToolExecutor(db, () => gateway);
    const outcome = await executor.execute(baseInput());
    expect(outcome.executed).toBe(true);
    expect(outcome.result.status).toBe("succeeded");
    expect(outcome.result.invocationId).toBe("inv-123");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.companyId).toBe(companyId);
    expect(seen[0]!.connectionId).toBe(connectionId);
    expect(seen[0]!.toolName).toBe(connectionName);
    expect(seen[0]!.parameters).toEqual({ city: "Oslo" });
  });

  it("returns executed=false for an unknown tool connection (no fake success)", async () => {
    const executor = createAdmCapabilityToolExecutor(db, () => null);
    const outcome = await executor.execute(baseInput({ resourceKey: "does-not-exist", resourceRef: "tool:does-not-exist" }));
    expect(outcome.executed).toBe(false);
    expect(outcome.result.reason).toBe("tool_connection_not_found");
  });

  it("returns executed=false when the policy decision is off or ask-first", async () => {
    const executor = createAdmCapabilityToolExecutor(db, () => ({
      async executeTestCall() {
        return { decision: "off" as const, invocationId: "inv-off", error: { message: "off", reasonCode: "policy_off" } };
      },
    }));
    const outcome = await executor.execute(baseInput());
    expect(outcome.executed).toBe(false);
    expect(outcome.result.status).toBe("denied");

    const askFirstExecutor = createAdmCapabilityToolExecutor(db, () => ({
      async executeTestCall() {
        return { decision: "ask_first" as const, invocationId: "inv-ask", actionRequestId: "ar-1" };
      },
    }));
    const askOutcome = await askFirstExecutor.execute(baseInput());
    expect(askOutcome.executed).toBe(false);
    expect(askOutcome.result.reason).toBe("policy_requires_approval");
  });

  it("returns executed=false when the gateway invocation reports an error result", async () => {
    const executor = createAdmCapabilityToolExecutor(db, () => ({
      async executeTestCall() {
        return { decision: "allowed" as const, invocationId: "inv-err", error: { message: "boom", reasonCode: "upstream_500" } };
      },
    }));
    const outcome = await executor.execute(baseInput());
    expect(outcome.executed).toBe(false);
    expect(outcome.result.status).toBe("failed");
    expect(outcome.result.reason).toBe("upstream_500");
  });

  it("returns executed=false when the tool gateway is unavailable (never canned success)", async () => {
    const executor = createAdmCapabilityToolExecutor(db, () => null);
    const outcome = await executor.execute(baseInput());
    expect(outcome.executed).toBe(false);
    expect(outcome.result.reason).toBe("tool_gateway_unavailable");
  });

  it("rejects non-tool resources", async () => {
    const executor = createAdmCapabilityToolExecutor(db, () => null);
    const outcome = await executor.execute(baseInput({ resourceType: "secret" }));
    expect(outcome.executed).toBe(false);
    expect(outcome.result.reason).toBe("resource_type_not_executable");
  });
});
