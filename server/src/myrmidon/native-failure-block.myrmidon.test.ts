import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { activityLog, agents, companies, createDb, issueRelations, issues, projects } from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";
import { hasBlockedReason } from "./blocked-reason-guard.js";
import { buildNativeFailureBlockedPatch, buildNativeFailureUnblockDescriptor } from "./native-failure-block.js";

describe("buildNativeFailureBlockedPatch with a stubbed chain", () => {
  const fakeDb = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ companyId: "c", projectId: null, executionState: null, assigneeAgentId: "a" }] }) }) }),
  } as never;
  it("owner is the first agent of the chain; patch satisfies the blocked-reason rule", async () => {
    const patch = await buildNativeFailureBlockedPatch(fakeDb, { issueId: "i", companyId: "c", action: "Look" }, async () => ["mgr", "adm"]);
    expect(patch.status).toBe("blocked");
    expect(patch.unblockDescriptor.owner).toEqual({ agentId: "mgr" });
    expect(hasBlockedReason({ openBlockerCount: 0, blockerMetadata: null, unblockDescriptor: patch.unblockDescriptor })).toBe(true);
  });
  it("board only when the chain is empty", async () => {
    const patch = await buildNativeFailureBlockedPatch(fakeDb, { issueId: "i", companyId: "c", action: "Look" }, async () => []);
    expect(patch.unblockDescriptor.owner).toBe("board");
    expect(buildNativeFailureUnblockDescriptor({ issueId: "i", ownerAgentId: null, action: "x" }).owner).toBe("board");
  });
});

const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;

describePg("native failure blocked patch against the real chain", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-native-failure-block-");
    db = createDb(tempDb.connectionString);
    await db.execute(sql.raw(`
      CREATE TABLE IF NOT EXISTS "issue_relations" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "company_id" uuid NOT NULL, "issue_id" uuid NOT NULL, "related_issue_id" uuid NOT NULL,
        "type" text NOT NULL, "created_by_agent_id" uuid, "created_by_user_id" text,
        "created_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now()
      );
    `));
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(opts: { withManager: boolean; withLead: boolean }) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "NF", issuePrefix: `N${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const mkAgent = async (name: string, reportsTo: string | null) => {
      const id = randomUUID();
      await db.insert(agents).values({
        id, companyId, name, role: "engineer", status: "active", reportsTo,
        adapterType: "claude_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
      });
      return id;
    };
    const adm = await mkAgent("adm", null);
    const manager = opts.withManager ? await mkAgent("mgr", adm) : null;
    const lead = opts.withLead ? await mkAgent("lead", adm) : null;
    const exec = await mkAgent("exec", manager);
    let projectId: string | null = null;
    if (lead) {
      projectId = randomUUID();
      await db.insert(projects).values({ id: projectId, companyId, name: "P", status: "in_progress", leadAgentId: lead });
    }
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId, companyId, projectId, identifier: "NF-1", title: "T", status: "in_progress",
      priority: "medium", assigneeAgentId: exec,
    });
    return { companyId, issueId, adm, manager, lead, exec };
  }

  it("executor's manager first, and the update passes blocked_requires_reason", async () => {
    const s = await seed({ withManager: true, withLead: true });
    const patch = await buildNativeFailureBlockedPatch(db, { issueId: s.issueId, companyId: s.companyId, action: "Inspect" });
    expect(patch.unblockDescriptor.owner).toEqual({ agentId: s.manager });
    const updated = await issueService(db).update(s.issueId, patch);
    expect(updated?.status).toBe("blocked");
  });

  it("without a manager: project lead; without both: adm", async () => {
    const withLead = await seed({ withManager: false, withLead: true });
    // exec reports to nobody here, so the chain is lead -> adm
    const p1 = await buildNativeFailureBlockedPatch(db, { issueId: withLead.issueId, companyId: withLead.companyId, action: "x" });
    expect(p1.unblockDescriptor.owner).toEqual({ agentId: withLead.lead });
    await db.delete(issues); await db.delete(projects); await db.delete(agents); await db.delete(companies);
    const bare = await seed({ withManager: false, withLead: false });
    const p2 = await buildNativeFailureBlockedPatch(db, { issueId: bare.issueId, companyId: bare.companyId, action: "x" });
    expect(p2.unblockDescriptor.owner).toEqual({ agentId: bare.adm });
  });
});
