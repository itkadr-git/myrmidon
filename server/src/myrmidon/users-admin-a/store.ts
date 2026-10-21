// server/src/myrmidon/users-admin-a/store.ts
//
// myrmidon(1.7 USERS-ADMIN-UI A): the runtime-mutable user blocklist, stored
// in the existing instance_settings JSON column — no new migration for the
// block state itself (the repo's no-migration pattern; the password-set token
// table is separate because it is a history).
//
// The blocklist lives under `general.myrmidonAuthBlockedUsers[userId]` — an
// object keyed by user id holding `{ blockedAt, blockedBy, reason }`. The
// Better Auth plugin and the sign-in path read it per request; the admin
// routes write it. A vendor write of `general` strips unknown keys, so
// `server/src/services/instance-settings.ts` carries `myrmidonAuthBlockedUsers`
// over (the preserve line marked myrmidon(1.7 USERS-ADMIN-UI A) there).

import { eq, sql } from "drizzle-orm";
import { instanceSettings, type Db } from "@paperclipai/db";

export const BLOCKED_USERS_GENERAL_KEY = "myrmidonAuthBlockedUsers";
const SINGLETON_KEY = "default";

export interface BlockedUserRecord {
  blockedAt: string;
  blockedBy: string | null;
  reason: string | null;
}

type StoredBlockedUsers = Record<string, BlockedUserRecord>;

/** Reads the whole stored blocklist (keys are user ids). */
export function readBlockedUsersMap(general: unknown): StoredBlockedUsers {
  if (typeof general !== "object" || general === null) return {};
  const value = (general as Record<string, unknown>)[BLOCKED_USERS_GENERAL_KEY];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: StoredBlockedUsers = {};
  for (const [userId, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    if (typeof record.blockedAt !== "string") continue;
    out[userId] = {
      blockedAt: record.blockedAt,
      blockedBy: typeof record.blockedBy === "string" ? record.blockedBy : null,
      reason: typeof record.reason === "string" ? record.reason : null,
    };
  }
  return out;
}

/** Is the user blocked right now? Absent means "not blocked". */
export function isUserBlocked(general: unknown, userId: string): boolean {
  return Object.prototype.hasOwnProperty.call(readBlockedUsersMap(general), userId);
}

/** The stored record of one blocked user, or null. */
export function readBlockedUser(general: unknown, userId: string): BlockedUserRecord | null {
  return readBlockedUsersMap(general)[userId] ?? null;
}

/** Reads the stored blocklist from the database row. */
export async function readStoredBlockedUsers(db: Pick<Db, "select">): Promise<StoredBlockedUsers> {
  const row = await db
    .select({ general: instanceSettings.general })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
    .then((rows) => rows[0] ?? null);
  return readBlockedUsersMap(row?.general);
}

/** Carry our key over a vendor write of instance_settings.general. */
export function preserveUsersAdminAGeneralKey(storedGeneral: unknown): Record<string, unknown> {
  const value = readBlockedUsersMap(storedGeneral);
  return Object.keys(value).length > 0 ? { [BLOCKED_USERS_GENERAL_KEY]: value } : {};
}

/**
 * Set or clear the blocked flag of one user. The read-modify-write runs in a
 * transaction with `for update` on the singleton row, the same serialization
 * the deploy-jobs store uses, so two concurrent admin writes cannot lose one
 * another's change.
 */
export async function setBlockedUser(
  db: Db,
  input: { userId: string; blocked: boolean; blockedBy: string | null; reason: string | null },
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .insert(instanceSettings)
      .values({ singletonKey: SINGLETON_KEY, general: {}, experimental: {} })
      .onConflictDoNothing({ target: [instanceSettings.singletonKey] });
    const row = await tx
      .select({ id: instanceSettings.id, general: instanceSettings.general })
      .from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
      .for("update")
      .then((rows) => rows[0]!);
    const current = readBlockedUsersMap(row.general);
    let next: StoredBlockedUsers;
    if (input.blocked) {
      next = {
        ...current,
        [input.userId]: {
          blockedAt: new Date().toISOString(),
          blockedBy: input.blockedBy,
          reason: input.reason,
        },
      };
    } else {
      const { [input.userId]: _removed, ...rest } = current;
      next = rest;
    }
    await tx
      .update(instanceSettings)
      .set({
        general: sql`jsonb_set(coalesce(${instanceSettings.general}, '{}'::jsonb), ${`{${BLOCKED_USERS_GENERAL_KEY}}`}::text[], ${JSON.stringify(next)}::jsonb, true)`,
      })
      .where(eq(instanceSettings.id, row.id));
  });
}

/** The ids of every blocked user (for list rendering). */
export async function listBlockedUserIds(db: Pick<Db, "select">): Promise<string[]> {
  return Object.keys(await readStoredBlockedUsers(db));
}
