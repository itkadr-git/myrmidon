import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { companies, createDb, issueRelations, issues } from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { listUnassignedQueue } from "./swarm-claim/queue.js";
import { blockerOpenSql, isBlockerOpen, isBlockerResolved } from "./blocker-resolved.js";

describe("blocker-resolved single source of truth", () => {
  it("done and cancelled are resolved, everything else is open", () => {
    expect(isBlockerResolved("done")).toBe(true);
    expect(isBlockerResolved("cancelled")).toBe(true);
    for (const status of ["backlog", "todo", "in_progress", "in_review", "blocked", undefined, null]) {
      expect(isBlockerResolved(status)).toBe(false);
      expect(isBlockerOpen(status)).toBe(true);
    }
  });
  it("the SQL fragment mirrors it and rejects a non-identifier reference", () => {
    expect(() => blockerOpenSql("blocker.status; drop table issues")).toThrow();
    expect(blockerOpenSql("blocker.status")).toBeDefined();
  });
});

const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;

describePg("swarm-claim queue honours a cancelled blocker as resolved", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-blocker-resolved-");
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
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function queueWith(blockerStatus: string) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "BR", issuePrefix: `B${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const blockerId = randomUUID();
    const dependentId = randomUUID();
    await db.insert(issues).values([
      { id: blockerId, companyId, identifier: "BR-1", title: "Blocker", status: blockerStatus, priority: "medium", assigneeAgentId: null },
      { id: dependentId, companyId, identifier: "BR-2", title: "Dependent", status: "todo", priority: "medium" },
    ]);
    await db.insert(issueRelations).values({ companyId, issueId: blockerId, relatedIssueId: dependentId, type: "blocks" });
    const queue = await listUnassignedQueue(db, companyId);
    return { ids: queue.map((row) => row.issueId), dependentId };
  }

  it("a dependent of a cancelled blocker is queued", async () => {
    const { ids, dependentId } = await queueWith("cancelled");
    expect(ids).toContain(dependentId);
  });
  it("a dependent of a done blocker is queued", async () => {
    const { ids, dependentId } = await queueWith("done");
    expect(ids).toContain(dependentId);
  });
  it("a dependent of an open blocker is not queued", async () => {
    const { ids, dependentId } = await queueWith("in_progress");
    expect(ids).not.toContain(dependentId);
  });
});
