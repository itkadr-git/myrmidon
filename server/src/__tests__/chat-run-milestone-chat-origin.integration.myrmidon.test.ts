import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  chatConversations,
  chatEndpoints,
  chatMessageLinks,
  chatPublications,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueQuestionResponseDeliveries,
  issueThreadInteractions,
  issues,
  toolApplications,
  toolConnections,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { mergeCoalescedContextSnapshot } from "../services/heartbeat.js";
import { enqueueChatRunMilestones } from "../services/chat-run-publications.js";

// myrmidon(CHAT-SOURCE): a coalesced background wake (`issue.children_completed`)
// used to overwrite a live run's `chat:*` source, which dropped the chat binding
// for the terminal presentation and the milestone scan: the owner's answer never
// reached the provider and the "working…" progress message stayed published
// forever. These cases pin the run-level provenance and the terminal-milestone
// scan to the live chat origin.
describe("coalesced chat-origin runs keep their terminal milestone", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const agentId = randomUUID();
  const issueId = randomUUID();
  const endpointId = randomUUID();
  const conversationId = randomUUID();
  const inboundCommentId = randomUUID();
  const since = new Date("2026-09-27T00:00:00.000Z");
  const presentationDecision = {
    schema: "paperclip.run_presentation_decision.v1",
    commentId: null,
    reasonCodes: ["resolved_response_materialized"],
    chosenSource: "adapter_final_response",
    commentAction: "create",
    sourceEventId: null,
    resolverVersion: "1",
    activityDisposition: "collapse",
  };

  /** The snapshot the live chat-inbound wake produced before the coalescence. */
  const chatOriginSnapshot = () => ({
    issueId,
    source: "chat:telegram",
    wakeReason: "External chat message received",
    commentId: inboundCommentId,
    wakeCommentId: inboundCommentId,
    wakeCommentIds: [inboundCommentId],
  });

  const publicationKeys = () =>
    db
      .select({ idempotencyKey: chatPublications.idempotencyKey })
      .from(chatPublications)
      .where(eq(chatPublications.conversationId, conversationId))
      .then((rows) => rows.map((row) => row.idempotencyKey));

  const insertRun = async (input: {
    id: string;
    contextSnapshot: Record<string, unknown>;
    status: string;
    updatedAt: Date;
    withPresentationDecision?: boolean;
  }) =>
    db.insert(heartbeatRuns).values({
      id: input.id,
      companyId,
      agentId,
      status: input.status,
      invocationSource: "assignment",
      triggerDetail: "system",
      contextSnapshot: input.contextSnapshot,
      resultJson: input.withPresentationDecision
        ? { presentationDecision }
        : null,
      updatedAt: input.updatedAt,
    });

  /**
   * A question answer is being steered into `targetRunId` right now. The durable
   * delivery plus its published prompt is the only chat binding such a run has,
   * so the milestone scan may not ask it to prove its route through `source`.
   */
  const seedInFlightQuestionContinuation = async (input: {
    targetRunId: string;
    sourceRunId: string;
  }) => {
    const interactionId = randomUUID();
    await db.insert(issueThreadInteractions).values({
      id: interactionId,
      companyId,
      issueId,
      sourceRunId: input.sourceRunId,
      kind: "ask_user_questions",
      status: "answered",
      title: "Which schedule?",
      payload: { version: 1, prompt: "Which schedule should I use?" },
    });
    await db.insert(issueQuestionResponseDeliveries).values({
      companyId,
      issueId,
      interactionId,
      sourceRunId: input.targetRunId,
      correlationId: randomUUID(),
      payloadSha256: "0".repeat(64),
      status: "delivering",
      deliveryMode: "steered",
    });
    await db.insert(chatPublications).values({
      companyId,
      endpointId,
      conversationId,
      issueId,
      idempotencyKey: `interaction:${interactionId}:${endpointId}`,
      payload: {
        text: "Which schedule should I use?",
        interactionId,
      },
      state: "published",
    });
    return interactionId;
  };

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase(
      "chat-run-chat-origin-",
    );
    db = createDb(temporary.connectionString);
    await db.insert(companies).values({
      id: companyId,
      name: "Coalesced chat origin",
      issuePrefix: "CCO",
      issueCounter: 1,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Chat origin agent",
      adapterType: "paperclip_runner",
      adapterConfig: { provider: "codex" },
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Owner question in Telegram",
      issueNumber: 1,
      identifier: "CCO-1",
      status: "in_progress",
      workMode: "standard",
      assigneeAgentId: agentId,
    });
    const applicationId = randomUUID();
    const connectionId = randomUUID();
    await db.insert(toolApplications).values({
      id: applicationId,
      companyId,
      applicationKey: `chat:telegram:${endpointId}`,
      name: "Telegram",
      type: "chat",
      status: "active",
    });
    await db.insert(toolConnections).values({
      id: connectionId,
      companyId,
      applicationId,
      name: "Telegram",
      uid: `chat-telegram-${endpointId}`,
      connectionPurpose: "channel",
      transport: "chat_sdk",
      status: "active",
      enabled: true,
    });
    await db.insert(chatEndpoints).values({
      id: endpointId,
      companyId,
      connectionId,
      provider: "telegram",
      publicId: randomUUID(),
      assignedAgentId: agentId,
      status: "active",
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      companyId,
      endpointId,
      issueId,
      externalConversationId: "100200300",
      externalThreadId: "100200300",
      externalLabel: "Owner chat",
      state: "active",
    });
    await db.insert(issueComments).values({
      id: inboundCommentId,
      companyId,
      issueId,
      authorType: "user",
      body: "Which schedule should I use?",
    });
    await db.insert(chatMessageLinks).values({
      companyId,
      endpointId,
      conversationId,
      commentId: inboundCommentId,
      providerMessageId: "100200300:1480",
      direction: "inbound",
    });
  });

  afterAll(async () => {
    await temporary?.stop?.();
  });

  it("keeps the chat source through a coalesced event wake and queues the completed milestone", async () => {
    const runId = randomUUID();
    const preCoalescence = chatOriginSnapshot();
    await insertRun({
      id: runId,
      contextSnapshot: preCoalescence,
      status: "running",
      updatedAt: new Date("2026-09-27T10:00:00.000Z"),
    });

    const merged = mergeCoalescedContextSnapshot(preCoalescence, {
      issueId,
      source: "issue.children_completed",
      wakeReason: "issue_children_completed",
      wakeSource: "automation",
      childIssueIds: [randomUUID()],
      completedChildIssueId: randomUUID(),
    });
    expect(merged.source).toBe("chat:telegram");
    await db
      .update(heartbeatRuns)
      .set({
        contextSnapshot: merged,
        status: "succeeded",
        resultJson: { presentationDecision },
        updatedAt: new Date("2026-09-27T10:01:00.000Z"),
      })
      .where(eq(heartbeatRuns.id, runId));

    expect(await enqueueChatRunMilestones(db, { since, limit: 10 })).toBe(1);
    expect(await publicationKeys()).toContain(
      `run:${runId}:completed:${endpointId}`,
    );
  });

  it("queues the completed milestone for a clobbered run that already published chat progress", async () => {
    const runId = randomUUID();
    const sourceRunId = randomUUID();
    await insertRun({
      id: sourceRunId,
      contextSnapshot: chatOriginSnapshot(),
      status: "succeeded",
      updatedAt: new Date("2026-09-27T11:00:00.000Z"),
    });
    await insertRun({
      id: runId,
      // The historical defect: the chat origin is gone from the snapshot.
      contextSnapshot: {
        issueId,
        source: "issue.children_completed",
        wakeReason: "issue_children_completed",
        commentId: inboundCommentId,
        wakeCommentId: inboundCommentId,
        wakeCommentIds: [inboundCommentId],
      },
      status: "succeeded",
      withPresentationDecision: true,
      updatedAt: new Date("2026-09-27T11:01:00.000Z"),
    });
    await db.insert(chatPublications).values({
      companyId,
      endpointId,
      conversationId,
      issueId,
      idempotencyKey: `run:${runId}:working:${endpointId}`,
      payload: { text: "adm is working…", progressState: "working" },
      state: "published",
    });
    await seedInFlightQuestionContinuation({ targetRunId: runId, sourceRunId });

    expect(await enqueueChatRunMilestones(db, { since, limit: 10 })).toBe(1);
    expect(await publicationKeys()).toContain(
      `run:${runId}:completed:${endpointId}`,
    );
  });

  it("does not queue a terminal milestone for a clobbered run without chat progress evidence", async () => {
    const runId = randomUUID();
    const sourceRunId = randomUUID();
    await insertRun({
      id: sourceRunId,
      contextSnapshot: chatOriginSnapshot(),
      status: "succeeded",
      updatedAt: new Date("2026-09-27T12:00:00.000Z"),
    });
    await insertRun({
      id: runId,
      contextSnapshot: {
        issueId,
        source: "issue.children_completed",
        wakeReason: "issue_children_completed",
        commentId: inboundCommentId,
        wakeCommentId: inboundCommentId,
        wakeCommentIds: [inboundCommentId],
      },
      status: "succeeded",
      withPresentationDecision: true,
      updatedAt: new Date("2026-09-27T12:01:00.000Z"),
    });
    await seedInFlightQuestionContinuation({ targetRunId: runId, sourceRunId });

    expect(await enqueueChatRunMilestones(db, { since, limit: 10 })).toBe(0);
    expect(await publicationKeys()).not.toContain(
      `run:${runId}:completed:${endpointId}`,
    );
  });
});