import { and, count, eq, isNull, lt } from "drizzle-orm";
import { knowledgeDeviations, type NewKnowledgeDeviation } from "@myrmidon/db";

/** Record a mismatch between documented knowledge and observed reality. */
export async function recordKnowledgeDeviation(
  db: any,
  input: Omit<NewKnowledgeDeviation, "id" | "status" | "createdAt" | "updatedAt">,
) {
  const [row] = await db.insert(knowledgeDeviations).values(input).returning();
  return row;
}

/** Read deviations for a knowledge nest, optionally including resolved entries. */
export async function listKnowledgeDeviations(
  db: any,
  nestId: string,
  options: { includeResolved?: boolean; limit?: number } = {},
) {
  return db
    .select()
    .from(knowledgeDeviations)
    .where(
      options.includeResolved
        ? eq(knowledgeDeviations.nestId, nestId)
        : and(eq(knowledgeDeviations.nestId, nestId), eq(knowledgeDeviations.status, "open")),
    )
    .orderBy(knowledgeDeviations.createdAt)
    .limit(options.limit ?? 100);
}

export async function countKnowledgeDeviations(db: any, nestId: string) {
  const [result] = await db
    .select({ count: count() })
    .from(knowledgeDeviations)
    .where(and(eq(knowledgeDeviations.nestId, nestId), eq(knowledgeDeviations.status, "open")));
  return Number(result?.count ?? 0);
}

/** Finds unassigned deviations older than 24 hours for the daily alert. */
export async function findStaleUnassignedDeviations(db: any, nestId: string, now = new Date()) {
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return db
    .select()
    .from(knowledgeDeviations)
    .where(
      and(
        eq(knowledgeDeviations.nestId, nestId),
        eq(knowledgeDeviations.status, "open"),
        isNull(knowledgeDeviations.task),
        lt(knowledgeDeviations.createdAt, cutoff),
      ),
    )
    .orderBy(knowledgeDeviations.createdAt);
}

export async function resolveKnowledgeDeviation(db: any, nestId: string, id: string) {
  const [row] = await db
    .update(knowledgeDeviations)
    .set({ status: "resolved", updatedAt: new Date() })
    .where(and(eq(knowledgeDeviations.nestId, nestId), eq(knowledgeDeviations.id, id)))
    .returning();
  return row ?? null;
}
