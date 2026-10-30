import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  interactionEscalations,
  issueThreadInteractions,
  issues,
} from "@myrmidon/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { escalateInteractionStep } from "./escalate-step.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("interaction escalation on PostgreSQL", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const issueId = randomUUID();
  const interactionId = randomUUID();
  const [lead, architect, secondary] = [randomUUID(), randomUUID(), randomUUID()];
  const payload = { questions: [{ id: "q", prompt: "Keep this context" }] };

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("interaction-escalate-step-");
    db = createDb(database.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Escalation", issuePrefix: "ESC" });
    await db.insert(agents).values([lead, architect, secondary].map((id, index) => ({
      id, companyId, name: `Agent ${index}`, role: "engineer", status: "idle", adapterType: "process",
    })));
    await db.insert(issues).values({ id: issueId, companyId, title: "Escalation issue" });
    await db.insert(issueThreadInteractions).values({
      id: interactionId, companyId, issueId, kind: "ask_user_questions", status: "pending",
      title: "Original title", summary: "Original summary", payload,
      routeType: "decision", addresseeAgentId: lead,
      timeoutAt: new Date("2026-10-30T00:00:00Z"),
      escalationChain: [
        { recipient: { agentId: lead }, afterMinutes: 0 },
        { recipient: { agentId: architect }, afterMinutes: 5 },
        { recipient: { agentId: secondary }, afterMinutes: 10 },
        { recipient: { serviceQueue: "operators" }, afterMinutes: 15 },
      ],
    });
  });
  afterAll(async () => { await database?.cleanup(); });

  it("hands off lead -> architect -> secondary -> queue, without duplicate wakes or context loss", async () => {
    for (const [level, agentId, queue] of [
      [1, architect, null], [2, secondary, null], [3, null, "operators"],
    ] as const) {
      expect(await escalateInteractionStep(db, interactionId, level)).toBe("escalated");
      const [card] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interactionId));
      expect(card).toMatchObject({
        escalationLevel: level, addresseeAgentId: agentId, addresseeUserId: null,
        addresseeQueue: queue, payload, title: "Original title", summary: "Original summary",
      });
      const before = await db.select().from(agentWakeupRequests);
      expect(await escalateInteractionStep(db, interactionId, level)).toBe("unchanged");
      expect(await db.select().from(agentWakeupRequests)).toEqual(before);
      expect(await db.select().from(interactionEscalations).where(eq(interactionEscalations.level, level)))
        .toHaveLength(1);
    }
    const wakes = await db.select().from(agentWakeupRequests);
    expect(wakes.map((wake) => [wake.agentId, wake.idempotencyKey])).toEqual([
      [architect, `interaction-pending:${interactionId}:level:1`],
      [secondary, `interaction-pending:${interactionId}:level:2`],
    ]);
    expect(await escalateInteractionStep(db, interactionId, 4)).toBe("unchanged");
    expect(await db.select().from(interactionEscalations)).toHaveLength(3);
  });
});
