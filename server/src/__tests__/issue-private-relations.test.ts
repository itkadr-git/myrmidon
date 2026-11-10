import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentApiKeys,
  agents,
  authUsers,
  boardApiKeys,
  companies,
  companyMemberships,
  createDb,
  issueRelations,
  issues,
} from "@myrmidon/db";
import type { Db } from "@myrmidon/db";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { maskPrivateNeighbour } from "../services/issue-visibility.js";
import { issueService } from "../services/issues.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.hoisted(() => {
  process.env.PAPERCLIP_HOME = "/tmp/paperclip-test-home";
  process.env.PAPERCLIP_INSTANCE_ID = "vitest";
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

async function createApp(db: Db) {
  const { issueRoutes } = await import("../routes/issues.js");
  const app = express();
  app.use(express.json());
  app.use(
    actorMiddleware(db, {
      deploymentMode: "authenticated",
      resolveSession: async () => null,
    }),
  );
  app.use("/api", issueRoutes(db, {} as never));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres(
  "issue private neighbour masking (1.7 PRIVATE-TASKS F4)",
  () => {
    let db!: Db;
    let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

    beforeAll(async () => {
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-private-relations-");
      db = createDb(tempDb.connectionString);
    }, 20_000);

    afterEach(async () => {
      await db.delete(issueRelations);
      await db.delete(issues);
      await db.delete(agentApiKeys);
      await db.delete(boardApiKeys);
      await db.delete(companyMemberships);
      await db.delete(agents);
      await db.delete(companies);
      await db.delete(authUsers);
    });

    afterAll(async () => tempDb?.cleanup());

    async function seed() {
      const company = await db.insert(companies).values({
        name: "Private Relations Company",
        issuePrefix: `PR${randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      }).returning().then((rows) => rows[0]!);
      const [actorAgent] = await db.insert(agents).values([{
        companyId: company.id,
        name: "Actor",
        role: "engineer",
        status: "active" as const,
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
      }]).returning();
      const responsibleUserId = `responsible-${randomUUID()}`;
      const boardUserId = `board-${randomUUID()}`;
      const now = new Date();
      await db.insert(authUsers).values([
        {
          id: responsibleUserId,
          name: "Responsible User",
          email: `${responsibleUserId}@example.test`,
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: boardUserId,
          name: "Board User",
          email: `${boardUserId}@example.test`,
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
        },
      ]);
      await db.insert(companyMemberships).values([
        {
          companyId: company.id,
          principalType: "user",
          principalId: responsibleUserId,
          status: "active",
          membershipRole: "member",
        },
        {
          companyId: company.id,
          principalType: "user",
          principalId: boardUserId,
          status: "active",
          membershipRole: "admin",
        },
      ]);

      // Public issue under a PRIVATE parent, blocked by a PRIVATE blocker.
      // 1.7 PRIVATE-TASKS F4: an agent must never see the parent's or the
      // blocker's title/description through neighbours; the board must.
      const privateParent = await db.insert(issues).values({
        companyId: company.id,
        issueNumber: 1,
        identifier: `${company.issuePrefix}-1`,
        title: "SECRET-PARENT-TITLE",
        description: "SECRET-PARENT-DESCRIPTION",
        status: "in_progress" as const,
        priority: "medium" as const,
        isPrivate: true,
        assigneeAgentId: actorAgent.id,
      }).returning().then((rows) => rows[0]!);
      const publicIssue = await db.insert(issues).values({
        companyId: company.id,
        issueNumber: 2,
        identifier: `${company.issuePrefix}-2`,
        title: "Public issue",
        status: "blocked" as const,
        priority: "high" as const,
        parentId: privateParent.id,
        assigneeAgentId: actorAgent.id,
      }).returning().then((rows) => rows[0]!);
      const privateBlocker = await db.insert(issues).values({
        companyId: company.id,
        issueNumber: 3,
        identifier: `${company.issuePrefix}-3`,
        title: "SECRET-BLOCKER-TITLE",
        description: "SECRET-BLOCKER-DESCRIPTION",
        status: "in_progress" as const,
        priority: "medium" as const,
        isPrivate: true,
        assigneeAgentId: actorAgent.id,
        blockerMetadata: { note: "SECRET-BLOCKER-META" },
      }).returning().then((rows) => rows[0]!);
      await db.insert(issueRelations).values({
        companyId: company.id,
        issueId: privateBlocker.id,
        relatedIssueId: publicIssue.id,
        type: "blocks",
      });

      const boardToken = `board-test-token-${randomUUID()}`;
      await db.insert(boardApiKeys).values({
        userId: boardUserId,
        name: "Board Key",
        keyHash: hashToken(boardToken),
      });
      const agentToken = `agent-test-token-${randomUUID()}`;
      await db.insert(agentApiKeys).values({
        agentId: actorAgent.id,
        companyId: company.id,
        name: "Actor Agent Key",
        keyHash: hashToken(agentToken),
        responsibleUserId,
      });

      return {
        company,
        actorAgent,
        publicIssue,
        privateParent,
        privateBlocker,
        boardToken,
        agentToken,
      };
    }

    const SECRET_MARKERS = [
      "SECRET-PARENT-TITLE",
      "SECRET-PARENT-DESCRIPTION",
      "SECRET-BLOCKER-TITLE",
      "SECRET-BLOCKER-DESCRIPTION",
      "SECRET-BLOCKER-META",
    ];

    function expectNoSecrets(body: unknown) {
      const serialized = JSON.stringify(body) ?? "";
      for (const marker of SECRET_MARKERS) {
        expect(serialized, `leaked ${marker}`).not.toContain(marker);
      }
    }

    function findBlocker(
      blockedBy: Array<Record<string, unknown>> | undefined,
      blockerId: string,
    ) {
      return (blockedBy ?? []).find((row) => row.id === blockerId);
    }

    it("maskPrivateNeighbour stubs a private row and strips isPrivate", async () => {
      const masked = maskPrivateNeighbour({
        id: "issue-1",
        identifier: "ABC-1",
        title: "Secret title",
        description: "Secret description",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: "agent-1",
        assigneeUserId: null,
        projectId: "project-1",
        goalId: "goal-1",
        blockerMetadata: { note: "meta" },
        isPrivate: true,
      });
      expect(masked).toEqual({
        id: "issue-1",
        identifier: null,
        title: "Private task",
        description: null,
        status: "in_progress",
        priority: "high",
        assigneeAgentId: null,
        assigneeUserId: null,
        projectId: null,
        goalId: null,
        blockerMetadata: null,
      });
      expect("isPrivate" in masked).toBe(false);
      const passthrough = maskPrivateNeighbour({
        id: "issue-2",
        title: "Public title",
        status: "todo",
        priority: "low",
        isPrivate: false,
      });
      expect(passthrough).toEqual({
        id: "issue-2",
        title: "Public title",
        status: "todo",
        priority: "low",
      });
    });

    it("agent detail response stubs private parent and blocker; board sees titles", async () => {
      const fixture = await seed();
      const app = await createApp(db);

      const agentRes = await request(app)
        .get(`/api/issues/${fixture.publicIssue.id}`)
        .set("Authorization", `Bearer ${fixture.agentToken}`);
      expect(agentRes.status, JSON.stringify(agentRes.body)).toBe(200);
      expectNoSecrets(agentRes.body);
      expect(agentRes.body.parent?.title ?? agentRes.body.ancestors?.[0]?.title).toBe(
        "Private task",
      );
      const agentBlocker = findBlocker(agentRes.body.blockedBy, fixture.privateBlocker.id);
      expect(agentBlocker, "private blocker must stay listed").toBeTruthy();
      expect(agentBlocker?.title).toBe("Private task");
      expect(agentBlocker?.identifier ?? null).toBeNull();
      expect(agentBlocker?.blockerMetadata ?? null).toBeNull();
      expect("isPrivate" in (agentBlocker ?? {})).toBe(false);

      const boardRes = await request(app)
        .get(`/api/issues/${fixture.publicIssue.id}`)
        .set("Authorization", `Bearer ${fixture.boardToken}`);
      expect(boardRes.status, JSON.stringify(boardRes.body)).toBe(200);
      expect(JSON.stringify(boardRes.body)).toContain("SECRET-PARENT-TITLE");
      expect(JSON.stringify(boardRes.body)).toContain("SECRET-BLOCKER-TITLE");
    }, 30_000);

    it("agent heartbeat-context masks private neighbours", async () => {
      const fixture = await seed();
      const app = await createApp(db);
      const res = await request(app)
        .get(`/api/issues/${fixture.publicIssue.id}/heartbeat-context`)
        .set("Authorization", `Bearer ${fixture.agentToken}`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expectNoSecrets(res.body);
      const ancestors = (res.body.ancestors ?? []) as Array<Record<string, unknown>>;
      const parentEntry = ancestors.find((row) => row.id === fixture.privateParent.id);
      expect(parentEntry, "private parent must stay in ancestors").toBeTruthy();
      expect(parentEntry?.title).toBe("Private task");
      const blockerEntry = findBlocker(res.body.blockedBy, fixture.privateBlocker.id);
      expect(blockerEntry, "private blocker must stay listed").toBeTruthy();
      expect(blockerEntry?.title).toBe("Private task");
    }, 30_000);

    it("agent list with includeBlockedBy stubs private blocker; service default keeps titles", async () => {
      const fixture = await seed();
      const app = await createApp(db);
      const res = await request(app)
        .get(
          `/api/companies/${fixture.company.id}/issues?includeBlockedBy=true&limit=50`,
        )
        .set("Authorization", `Bearer ${fixture.agentToken}`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expectNoSecrets(res.body);
      const rows = (Array.isArray(res.body) ? res.body : res.body.issues ?? []) as Array<{
        id: string;
        blockedBy?: Array<Record<string, unknown>>;
      }>;
      const publicRow = rows.find((row) => row.id === fixture.publicIssue.id);
      expect(publicRow, "public issue must stay listed").toBeTruthy();
      const blockerEntry = findBlocker(publicRow?.blockedBy, fixture.privateBlocker.id);
      expect(blockerEntry, "private blocker must stay listed").toBeTruthy();
      expect(blockerEntry?.title).toBe("Private task");

      // Regression: the service-level default (no opts) must keep real titles
      // so internal callers are unaffected.
      const relations = await issueService(db).getRelationSummaries(fixture.publicIssue.id);
      expect(relations.blockedBy.find((row) => row.id === fixture.privateBlocker.id)?.title).toBe(
        "SECRET-BLOCKER-TITLE",
      );
    }, 30_000);

    it("agent blocker diagnostics stubs private blocker rows", async () => {
      const fixture = await seed();
      const app = await createApp(db);
      const res = await request(app)
        .get(`/api/issues/${fixture.publicIssue.id}/diagnostics/blockers`)
        .set("Authorization", `Bearer ${fixture.agentToken}`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expectNoSecrets(res.body);
      const blockers = (res.body.blockers ?? []) as Array<Record<string, unknown>>;
      const blockerEntry = blockers.find((row) => row.id === fixture.privateBlocker.id);
      expect(blockerEntry, "private blocker must stay listed").toBeTruthy();
      expect(blockerEntry?.title).toBe("Private task");
      expect("isPrivate" in (blockerEntry ?? {})).toBe(false);
    }, 30_000);

    it("agent subtree diagnostics stub private parent node and blocker rows", async () => {
      const fixture = await seed();
      const app = await createApp(db);
      const res = await request(app)
        .get(`/api/issues/${fixture.publicIssue.id}/diagnostics/subtree`)
        .set("Authorization", `Bearer ${fixture.agentToken}`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expectNoSecrets(res.body);
      const nodes = (res.body.nodes ?? []) as Array<Record<string, unknown>>;
      const parentNode = nodes.find((row) => row.id === fixture.privateParent.id);
      if (parentNode) {
        expect(parentNode.title).toBe("Private task");
        expect("isPrivate" in parentNode).toBe(false);
      }
      const blockerRows = Object.values(
        (res.body.blockersByIssueId ?? {}) as Record<
          string,
          Array<Record<string, unknown>>
        >,
      ).flat();
      const blockerEntry = blockerRows.find(
        (row) => row.id === fixture.privateBlocker.id,
      );
      expect(blockerEntry, "private blocker must stay listed").toBeTruthy();
      expect(blockerEntry?.title).toBe("Private task");
    }, 30_000);
  },
);
