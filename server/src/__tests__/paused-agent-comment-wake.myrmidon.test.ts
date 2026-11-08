import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  authUsers,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";
import { deliverConversationComments } from "../services/agent-conversations.js";
import { heartbeatService } from "../services/heartbeat.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)(
  "paused agent comment delivery (OPE-12203 / vendor #16679)",
  () => {
    let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
    let db: ReturnType<typeof createDb>;
    let companyId: string;
    let agentId: string;

    beforeAll(async () => {
      database = await startEmbeddedPostgresTestDatabase(
        "myrmidon-paused-agent-comment-",
      );
      db = createDb(database.connectionString);
      companyId = randomUUID();
      agentId = randomUUID();

      await db
        .insert(authUsers)
        .values({
          id: "user-board-1",
          name: "Board User",
          email: "board@myrmidon.test",
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .onConflictDoNothing();

      await db.insert(companies).values({
        id: companyId,
        name: "Paused Agent Co",
        issuePrefix: "PAWS",
        requireBoardApprovalForNewAgents: false,
      });

      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Engineer",
        role: "engineer",
        status: "paused",
        pauseReason: "manual",
        pausedAt: new Date(),
        adapterType: "process",
      });
    }, 60000);

    afterAll(async () => {
      await db?.$client.end({ timeout: 0 });
      await database?.cleanup();
    });

    it("delivering a comment to a paused agent does not throw or fail; comment is preserved for resume", async () => {
      const issue = await issueService(db).create(companyId, {
        title: "Task while paused",
        conversationAgentId: agentId,
        conversationUserId: "user-board-1",
        assigneeAgentId: agentId,
        status: "in_review",
        conversationState: "waiting",
      });

      const comment = await issueService(db).addComment(
        issue.id,
        "Important update while you are paused",
        { userId: "user-board-1" },
        { clientRequestId: randomUUID() },
      );

      const heartbeat = heartbeatService(db);

      // deliverConversationComments must not reject/fail when agent is paused
      await expect(
        deliverConversationComments(db, issue, heartbeat.wakeup),
      ).resolves.not.toThrow();

      // Ensure no runs marked failed exist for this agent
      const runs = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId));
      expect(runs.filter((r) => r.status === "failed")).toHaveLength(0);

      // Verify comment remains intact and undelivered/ready for resume
      const [savedComment] = await db
        .select()
        .from(issueComments)
        .where(eq(issueComments.id, comment.id));
      expect(savedComment).toBeDefined();
      expect(savedComment.body).toContain("Important update while you are paused");
    });
  },
);
