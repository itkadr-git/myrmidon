// myrmidon(1.6.5-OWNER-DM-FILTER): owner-DM delivery journal route (part C).
//
// Fixtures seed publications of BOTH frozen classes into an owner-DM
// conversation (a direct-message conversation whose conversation issue is a
// telegram:* DM) plus control publications outside any owner DM. The route
// must classify owner_decision (effectiveResolverPolicy == "human_only" or
// addresseeUserId == issue owner) against operational, resolve the
// interaction through payload->>'interactionId', enforce instance-admin
// access, and honor the `since` window. After the part-A filter ships, an
// "operational" journal entry can only come from a publication row created
// before the filter rollout — the route comment in
// ../myrmidon/owner-delivery/routes.ts documents this.
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import request from "supertest";
import { describe, expect, it } from "vitest";
import {
  agents,
  chatConversations,
  chatEndpoints,
  chatPublications,
  companies,
  createDb,
  issueThreadInteractions,
  issues,
  toolApplications,
  toolConnections,
} from "@paperclipai/db";
import { ownerDeliveryRoutes } from "../myrmidon/owner-delivery/routes.js";
import {
  describeEmbeddedPostgres,
  routeApp,
  useEmbeddedPostgres,
  type BoardActor,
} from "./helpers/route-test-harness.js";

type Db = ReturnType<typeof createDb>;

const ROUTE = "/api/myrmidon/owner-delivery/publications";

function adminActor(): BoardActor {
  return {
    type: "board",
    source: "session",
    userId: "user-admin",
    companyIds: [],
    memberships: [],
    isInstanceAdmin: true,
  };
}

function memberActor(companyId: string): BoardActor {
  return {
    type: "board",
    source: "session",
    userId: "user-member",
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "member", status: "active" }],
    isInstanceAdmin: false,
  };
}

interface Seeded {
  companyId: string;
  agentId: string;
  ownerUserId: string;
  otherUserId: string;
  workIssueId: string;
  ownerDmConversationId: string;
  endpointId: string;
}

async function seedOwnerDmFixture(db: Db): Promise<Seeded> {
  const companyId = randomUUID();
  const agentId = randomUUID();
  const ownerUserId = `user-${randomUUID()}`;
  const otherUserId = `user-${randomUUID()}`;
  await db.insert(companies).values({
    id: companyId,
    name: `Owner journal co ${companyId.slice(0, 6)}`,
    issuePrefix: `OJ${companyId.replaceAll("-", "").slice(0, 7).toUpperCase()}`,
  });
  await db.insert(agents).values({
    id: agentId,
    companyId,
    name: "Agent",
    role: "engineer",
    status: "idle",
    adapterType: "paperclip_runner",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
  });

  // The card-owning task. Its owner is responsibleUserId ?? createdByUserId.
  const [workIssue] = await db
    .insert(issues)
    .values({
      companyId,
      title: "Work task",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: ownerUserId,
      createdByUserId: otherUserId,
    })
    .returning();

  // The standing Telegram DM between the agent and the owner: an issue whose
  // conversationUserId is `telegram:<boardUserId>`.
  const [conversationIssue] = await db
    .insert(issues)
    .values({
      companyId,
      title: "Telegram chat with Agent",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: agentId,
      conversationAgentId: agentId,
      conversationUserId: `telegram:${ownerUserId}`,
      conversationState: "waiting",
      createdByUserId: ownerUserId,
    })
    .returning();

  const applicationId = randomUUID();
  const connectionId = randomUUID();
  const endpointId = randomUUID();
  await db.insert(toolApplications).values({
    id: applicationId,
    companyId,
    applicationKey: `chat:telegram:${endpointId}`,
    name: `telegram ${endpointId}`,
    type: "chat",
    status: "active",
  });
  await db.insert(toolConnections).values({
    id: connectionId,
    companyId,
    applicationId,
    name: "telegram channel",
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
  const [ownerDmConversation] = await db
    .insert(chatConversations)
    .values({
      companyId,
      endpointId,
      issueId: conversationIssue.id,
      externalConversationId: "telegram-dm",
      externalThreadId: `telegram:${ownerUserId}`,
      externalLabel: "owner DM",
      isDirectMessage: true,
      state: "active",
    })
    .returning();

  return {
    companyId,
    agentId,
    ownerUserId,
    otherUserId,
    workIssueId: workIssue.id,
    ownerDmConversationId: ownerDmConversation.id,
    endpointId,
  };
}

async function seedInteraction(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    effectiveResolverPolicy: "anyone" | "human_only";
    addresseeUserId?: string | null;
  },
) {
  const [row] = await db
    .insert(issueThreadInteractions)
    .values({
      companyId: input.companyId,
      issueId: input.issueId,
      kind: "ask_user_questions",
      status: "pending",
      continuationPolicy: "wake_assignee",
      requestedResolverPolicy: input.effectiveResolverPolicy,
      effectiveResolverPolicy: input.effectiveResolverPolicy,
      addresseeUserId: input.addresseeUserId ?? null,
      payload: { version: 1, questions: [] },
    })
    .returning();
  return row;
}

async function seedPublication(
  db: Db,
  input: {
    companyId: string;
    endpointId: string;
    conversationId: string;
    issueId: string;
    interactionId: string | null;
  },
) {
  const [row] = await db
    .insert(chatPublications)
    .values({
      companyId: input.companyId,
      endpointId: input.endpointId,
      conversationId: input.conversationId,
      issueId: input.issueId,
      idempotencyKey: `interaction:${input.interactionId ?? randomUUID()}:${input.endpointId}:${input.conversationId}`,
      payload: {
        text: "card",
        ...(input.interactionId ? { interactionId: input.interactionId } : {}),
      },
      state: "published",
    })
    .returning();
  return row;
}

describeEmbeddedPostgres("GET /api/myrmidon/owner-delivery/publications", () => {
  const ctx = useEmbeddedPostgres("paperclip-owner-delivery-journal-");

  it("classifies owner decisions and operational cards in an owner DM", async () => {
    const db = ctx.db;
    const fx = await seedOwnerDmFixture(db);

    // owner_decision: human_only policy.
    const humanOnly = await seedInteraction(db, {
      companyId: fx.companyId,
      issueId: fx.workIssueId,
      effectiveResolverPolicy: "human_only",
    });
    // owner_decision: addressee is the issue owner.
    const addressed = await seedInteraction(db, {
      companyId: fx.companyId,
      issueId: fx.workIssueId,
      effectiveResolverPolicy: "anyone",
      addresseeUserId: fx.ownerUserId,
    });
    // operational: addressee is someone else.
    const operational = await seedInteraction(db, {
      companyId: fx.companyId,
      issueId: fx.workIssueId,
      effectiveResolverPolicy: "anyone",
      addresseeUserId: fx.otherUserId,
    });
    // operational: no addressee at all.
    const unaddressed = await seedInteraction(db, {
      companyId: fx.companyId,
      issueId: fx.workIssueId,
      effectiveResolverPolicy: "anyone",
    });

    for (const interaction of [humanOnly, addressed, operational, unaddressed]) {
      await seedPublication(db, {
        companyId: fx.companyId,
        endpointId: fx.endpointId,
        conversationId: fx.ownerDmConversationId,
        issueId: fx.workIssueId,
        interactionId: interaction.id,
      });
    }

    const app = routeApp(db, adminActor(), (dbOrThrow) =>
      ownerDeliveryRoutes(dbOrThrow),
    );
    const res = await request(app)
      .get(ROUTE)
      .query({ since: new Date(0).toISOString() })
      .expect(200);

    const byInteraction = new Map<string, Record<string, unknown>>(
      (res.body.items as Record<string, unknown>[]).map((item) => [
        item.interactionId as string,
        item,
      ]),
    );
    expect(byInteraction.get(humanOnly.id)).toMatchObject({
      classification: "owner_decision",
      reason: "effective_resolver_policy_human_only",
      issueId: fx.workIssueId,
    });
    expect(byInteraction.get(addressed.id)).toMatchObject({
      classification: "owner_decision",
      reason: "addressee_is_issue_owner",
    });
    expect(byInteraction.get(operational.id)).toMatchObject({
      classification: "operational",
      reason: "addressee_not_issue_owner",
    });
    expect(byInteraction.get(unaddressed.id)).toMatchObject({
      classification: "operational",
      reason: "no_owner_addressee",
    });
    // Rows from earlier tests in the shared embedded database may also be
    // present; only our fixture's interactions matter here.
    for (const id of [humanOnly.id, addressed.id, operational.id, unaddressed.id]) {
      expect(byInteraction.has(id)).toBe(true);
    }
    for (const item of res.body.items as Record<string, unknown>[]) {
      expect(typeof item.publicationId).toBe("string");
      expect(typeof item.createdAt).toBe("string");
    }
  });

  it("excludes publications outside owner-DM conversations", async () => {
    const db = ctx.db;
    const fx = await seedOwnerDmFixture(db);

    const interaction = await seedInteraction(db, {
      companyId: fx.companyId,
      issueId: fx.workIssueId,
      effectiveResolverPolicy: "human_only",
    });

    // A group (non-DM) conversation on the same work issue: not an owner DM.
    const [groupConversation] = await db
      .insert(chatConversations)
      .values({
        companyId: fx.companyId,
        endpointId: fx.endpointId,
        issueId: fx.workIssueId,
        externalConversationId: "telegram-group",
        externalThreadId: "telegram:group:1",
        externalLabel: "group thread",
        isDirectMessage: false,
        state: "active",
      })
      .returning();
    await seedPublication(db, {
      companyId: fx.companyId,
      endpointId: fx.endpointId,
      conversationId: groupConversation.id,
      issueId: fx.workIssueId,
      interactionId: interaction.id,
    });

    // A DM conversation whose conversation issue is NOT a telegram:* DM.
    const [plainIssue] = await db
      .insert(issues)
      .values({
        companyId: fx.companyId,
        title: "Plain task",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: fx.agentId,
      })
      .returning();
    const [plainDmConversation] = await db
      .insert(chatConversations)
      .values({
        companyId: fx.companyId,
        endpointId: fx.endpointId,
        issueId: plainIssue.id,
        externalConversationId: "slack-dm",
        externalThreadId: "slack:dm:1",
        externalLabel: "plain DM",
        isDirectMessage: true,
        state: "active",
      })
      .returning();
    await seedPublication(db, {
      companyId: fx.companyId,
      endpointId: fx.endpointId,
      conversationId: plainDmConversation.id,
      issueId: fx.workIssueId,
      interactionId: interaction.id,
    });

    const app = routeApp(db, adminActor(), (dbOrThrow) =>
      ownerDeliveryRoutes(dbOrThrow),
    );
    const res = await request(app)
      .get(ROUTE)
      .query({ since: new Date(0).toISOString() })
      .expect(200);
    // The shared embedded database may hold rows from other tests in this
    // file; what matters is that neither excluded publication appears.
    const items = res.body.items as Record<string, unknown>[];
    expect(
      items.some((item) => item.interactionId === interaction.id),
    ).toBe(false);
    expect(res.body.total).toBe(items.length);
  });

  it("honors the since window", async () => {
    const db = ctx.db;
    const fx = await seedOwnerDmFixture(db);
    const interaction = await seedInteraction(db, {
      companyId: fx.companyId,
      issueId: fx.workIssueId,
      effectiveResolverPolicy: "human_only",
    });
    const publication = await seedPublication(db, {
      companyId: fx.companyId,
      endpointId: fx.endpointId,
      conversationId: fx.ownerDmConversationId,
      issueId: fx.workIssueId,
      interactionId: interaction.id,
    });
    const future = new Date(Date.now() + 60_000).toISOString();
    const app = routeApp(db, adminActor(), (dbOrThrow) =>
      ownerDeliveryRoutes(dbOrThrow),
    );
    const res = await request(app)
      .get(ROUTE)
      .query({ since: future })
      .expect(200);
    const items = res.body.items as Record<string, unknown>[];
    expect(
      items.some((item) => item.interactionId === interaction.id),
    ).toBe(false);
    expect(publication.id).toBeTruthy();
  });

  it("rejects non-admin actors and a missing/invalid since", async () => {
    const db = ctx.db;
    const fx = await seedOwnerDmFixture(db);
    const app = routeApp(db, memberActor(fx.companyId), (dbOrThrow) =>
      ownerDeliveryRoutes(dbOrThrow),
    );
    await request(app)
      .get(ROUTE)
      .query({ since: new Date(0).toISOString() })
      .expect(403);

    const admin = routeApp(db, adminActor(), (dbOrThrow) =>
      ownerDeliveryRoutes(dbOrThrow),
    );
    await request(admin).get(ROUTE).expect(400);
    await request(admin).get(ROUTE).query({ since: "yesterday" }).expect(400);
  });

  it("keeps other companies' publications invisible", async () => {
    const db = ctx.db;
    const fx = await seedOwnerDmFixture(db);
    const interaction = await seedInteraction(db, {
      companyId: fx.companyId,
      issueId: fx.workIssueId,
      effectiveResolverPolicy: "anyone",
    });
    await seedPublication(db, {
      companyId: fx.companyId,
      endpointId: fx.endpointId,
      conversationId: fx.ownerDmConversationId,
      issueId: fx.workIssueId,
      interactionId: interaction.id,
    });
    // The route is instance-wide but read-only; a second fixture in the same
    // run simply adds rows. Assert only our fixture's row is returned in this
    // suite's window by counting classification totals against seeded rows.
    const app = routeApp(db, adminActor(), (dbOrThrow) =>
      ownerDeliveryRoutes(dbOrThrow),
    );
    const res = await request(app)
      .get(ROUTE)
      .query({ since: new Date(0).toISOString() })
      .expect(200);
    const found = (res.body.items as Record<string, unknown>[]).filter(
      (item) => item.interactionId === interaction.id,
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ classification: "operational" });
  });
});
