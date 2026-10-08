import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { inboxDismissals } from "@paperclipai/db";
import type { InboxDismissalKind } from "@paperclipai/shared";
import { invalidateAttentionFeedCache } from "./attention.js";

export function inboxDismissalService(db: Db) {
  async function upsert(
    companyId: string,
    userId: string,
    itemKey: string,
    input: { kind: InboxDismissalKind; dismissedAt?: Date; snoozedUntil?: Date | null },
  ) {
    const now = new Date();
    const dismissedAt = input.dismissedAt ?? now;
    const snoozedUntil = input.kind === "snooze" ? input.snoozedUntil ?? null : null;
    const [row] = await db
      .insert(inboxDismissals)
      .values({
        companyId,
        userId,
        itemKey,
        kind: input.kind,
        dismissedAt,
        snoozedUntil,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [inboxDismissals.companyId, inboxDismissals.userId, inboxDismissals.itemKey],
        set: {
          kind: input.kind,
          dismissedAt,
          snoozedUntil,
          updatedAt: now,
        },
      })
      .returning();
    // myrmidon(ATTENTION-WINDOW-CACHE): a dismissal/snooze must show on the very
    // next feed read, not after the per-company feed cache TTL.
    invalidateAttentionFeedCache(db, companyId);
    return row;
  }

  return {
    list: async (companyId: string, userId: string) =>
      db
        .select()
        .from(inboxDismissals)
        .where(and(eq(inboxDismissals.companyId, companyId), eq(inboxDismissals.userId, userId)))
        .orderBy(desc(inboxDismissals.updatedAt)),

    dismiss: async (
      companyId: string,
      userId: string,
      itemKey: string,
      dismissedAt: Date = new Date(),
    ) => upsert(companyId, userId, itemKey, { kind: "dismiss", dismissedAt }),

    snooze: async (
      companyId: string,
      userId: string,
      itemKey: string,
      snoozedUntil: Date,
      dismissedAt: Date = new Date(),
    ) => upsert(companyId, userId, itemKey, { kind: "snooze", dismissedAt, snoozedUntil }),

    restore: async (companyId: string, userId: string, itemKey: string) => {
      const [row] = await db
        .delete(inboxDismissals)
        .where(and(
          eq(inboxDismissals.companyId, companyId),
          eq(inboxDismissals.userId, userId),
          eq(inboxDismissals.itemKey, itemKey),
        ))
        .returning();
      invalidateAttentionFeedCache(db, companyId);
      return row ?? null;
    },
  };
}
