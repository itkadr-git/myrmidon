import { randomUUID } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  companySkills,
  heartbeatRunEvents,
  heartbeatRuns,
  instanceSettings,
  issueComments,
  issues,
} from "@myrmidon/db";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import { REVIEW_ROUTING_SETTINGS_KEY } from "@myrmidon/shared";

// myrmidon(OPE-12683): on the transition into review the board must pick a
// reviewer from the issue's own project team. With no explicit participants the
// least-loaded eligible teammate wins; an out-of-team reviewer is never picked,
// even when no teammate is eligible. These tests run against the real route stack
// on embedded Postgres: the auto-pick branch reads review-routing settings from
// the instance row and candidates from the real store, so mocks cannot prove it.

const ctx = useEmbeddedPostgres("myrmidon-review-autopick-", {
  resetEach: async (db) => {
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`LOCK TABLE activity_log, agent_runtime_state, agent_task_sessions, agent_wakeup_requests, issue_comments, issues, agents, company_skills, instance_settings IN SHARE ROW EXCLUSIVE MODE`,
      );
      await tx.delete(heartbeatRunEvents);
      await tx.update(agentTaskSessions).set({ lastRunId: null });
      await tx.delete(activityLog);
      await tx.delete(heartbeatRuns);
      await tx.delete(agentWakeupRequests);
      await tx.delete(issueComments);
      await tx.delete(issues);
      await tx.delete(agentRuntimeState);
      await tx.delete(agentTaskSessions);
      await tx.delete(agents);
      await tx.delete(companySkills);
      await tx.delete(instanceSettings);
      await resetCompanyIssueFixtures(tx as typeof db);
    });
  },
});

async function seedRoutingAgents(input: {
  db: typeof ctx.db;
  companyId: string;
  authorId: string;
  teammateReviewerId: string;
  outOfTeamReviewerId: string;
}) {
  await input.db.insert(agents).values([
    {
      id: input.authorId,
      companyId: input.companyId,
      name: "adm-dev-eng-23",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    },
    {
      id: input.teammateReviewerId,
      companyId: input.companyId,
      name: "adm-dev-review-8",
      role: "reviewer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    },
    {
      id: input.outOfTeamReviewerId,
      companyId: input.companyId,
      name: "bbq-worker-1",
      role: "reviewer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    },
  ]);
}

async function seedIssue(input: {
  db: typeof ctx.db;
  companyId: string;
  authorId: string;
}) {
  const issueId = randomUUID();
  await input.db.insert(issues).values({
    id: issueId,
    companyId: input.companyId,
    title: "Auto-pick a teammate reviewer",
    status: "todo",
    priority: "medium",
    assigneeAgentId: input.authorId,
    createdByAgentId: input.authorId,
  });
  return issueId;
}

describeEmbeddedPostgres("myrmidon review auto-pick teammate affinity", () => {
  it("auto-picks the same-team reviewer over a less loaded out-of-team one", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Autopick teammate affinity");
    const authorId = randomUUID();
    const teammateReviewerId = randomUUID();
    const outOfTeamReviewerId = randomUUID();
    await seedRoutingAgents({ db: ctx.db, companyId, authorId, teammateReviewerId, outOfTeamReviewerId });
    const issueId = await seedIssue({ db: ctx.db, companyId, authorId });

    const res = await request(routeApp(ctx.db, actor, issueRoutes))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("in_review");
    expect(res.body.executionState?.currentParticipant).toMatchObject({
      type: "agent",
      agentId: teammateReviewerId,
    });
    expect(res.body.assigneeAgentId).toBe(teammateReviewerId);
  });

  it("never falls back to an out-of-team reviewer when no teammate reviewer is eligible", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Autopick no fallback pool");
    const authorId = randomUUID();
    const teammateReviewerId = randomUUID();
    const outOfTeamReviewerId = randomUUID();
    await seedRoutingAgents({ db: ctx.db, companyId, authorId, teammateReviewerId, outOfTeamReviewerId });
    // The teammate reviewer is queue-ineligible: only the out-of-team reviewer
    // is left. It must not be picked; the issue waits for a teammate and the
    // sweep raises the no-reviewer signal.
    await ctx.db
      .update(agents)
      .set({ metadata: { swarmQueueEligible: false } })
      .where(sql`${agents.id} = ${teammateReviewerId}`);
    const issueId = await seedIssue({ db: ctx.db, companyId, authorId });

    const res = await request(routeApp(ctx.db, actor, issueRoutes))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    expect(res.body.executionState?.currentParticipant?.agentId).not.toBe(outOfTeamReviewerId);
    expect(res.body.assigneeAgentId).not.toBe(outOfTeamReviewerId);
  });

  it("refuses an out-of-team reviewer added while the issue is already in review", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Autopick in_review reviewer change");
    const authorId = randomUUID();
    const teammateReviewerId = randomUUID();
    const outOfTeamReviewerId = randomUUID();
    await seedRoutingAgents({ db: ctx.db, companyId, authorId, teammateReviewerId, outOfTeamReviewerId });
    const stageId = randomUUID();
    const issueId = randomUUID();
    await ctx.db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Reviewer change while in review",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: teammateReviewerId,
      createdByAgentId: authorId,
      executionPolicy: {
        mode: "normal",
        stages: [{
          id: stageId,
          type: "review",
          approvalsNeeded: 1,
          participants: [{ id: randomUUID(), type: "agent", agentId: teammateReviewerId, userId: null }],
        }],
      },
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: teammateReviewerId, userId: null },
        returnAssignee: { type: "agent", agentId: authorId, userId: null },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });

    const res = await request(routeApp(ctx.db, actor, issueRoutes))
      .patch(`/api/issues/${issueId}`)
      .send({
        executionPolicy: {
          mode: "normal",
          stages: [{
            id: stageId,
            type: "review",
            approvalsNeeded: 1,
            participants: [
              { id: randomUUID(), type: "agent", agentId: teammateReviewerId, userId: null },
              { id: randomUUID(), type: "agent", agentId: outOfTeamReviewerId, userId: null },
            ],
          }],
        },
      });

    // The eligibility gate fires on a reviewer change while in review too; the
    // anchor is the engineer the review returns to, not the current reviewer.
    expect(res.status).toBe(422);
    expect(res.body.code ?? res.body.details?.code).toBe("invalid_review_participant");
    expect(res.body.details?.rejected?.[0]?.agentId).toBe(outOfTeamReviewerId);
  });

  it("refuses an out-of-team reviewer assignee on the transition into review", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Autopick disabled");
    const authorId = randomUUID();
    const teammateReviewerId = randomUUID();
    const outOfTeamReviewerId = randomUUID();
    await seedRoutingAgents({ db: ctx.db, companyId, authorId, teammateReviewerId, outOfTeamReviewerId });
    // Routing off does not weaken the eligibility rule: the auto-pick must
    // not fire, and an explicit out-of-team assignee is still refused.
    await ctx.db
      .insert(instanceSettings)
      .values({
        general: { [REVIEW_ROUTING_SETTINGS_KEY]: { enabled: false } },
      })
      .onConflictDoUpdate({
        target: instanceSettings.singletonKey,
        set: { general: { [REVIEW_ROUTING_SETTINGS_KEY]: { enabled: false } } },
      });
    const issueId = await seedIssue({ db: ctx.db, companyId, authorId });

    const res = await request(routeApp(ctx.db, actor, issueRoutes))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_review", assigneeAgentId: outOfTeamReviewerId });

    // The eligibility gate fires on the transition itself, for every actor,
    // regardless of the routing toggle.
    expect(res.status).toBe(422);
    expect(res.body.code ?? res.body.details?.code).toBe("invalid_review_participant");
    expect(res.body.details?.rejected?.[0]?.agentId).toBe(outOfTeamReviewerId);
  });
});
