import type { Db } from "@myrmidon/db";
import { authSessions, boardApiKeys } from "@myrmidon/db";
import { and, eq, isNull } from "drizzle-orm";

type SessionDb = Pick<Db, "delete" | "update">;

let defaultDb: SessionDb | null = null;

export function setSessionDb(db: SessionDb): void {
  defaultDb = db;
}

export function getSessionDb(): SessionDb | null {
  return defaultDb;
}

export interface RevokeSessionsResult {
  sessionsRevoked: number;
  apiKeysRevoked: number;
}

/** Invalidate every Better Auth session and board API key owned by a user. */
export async function revokeAllUserSessions(
  userId: string,
  db: SessionDb = defaultDb as SessionDb,
): Promise<RevokeSessionsResult> {
  if (!db) {
    throw new Error("Database not initialized for session-service");
  }

  const deletedSessions = await db
    .delete(authSessions)
    .where(eq(authSessions.userId, userId))
    .returning({ id: authSessions.id });
  const revokedKeys = await db
    .update(boardApiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(boardApiKeys.userId, userId), isNull(boardApiKeys.revokedAt)))
    .returning({ id: boardApiKeys.id });

  return {
    sessionsRevoked: deletedSessions.length,
    apiKeysRevoked: revokedKeys.length,
  };
}

export function sessionService(db: SessionDb) {
  setSessionDb(db);
  return {
    revokeAllUserSessions: (userId: string) => revokeAllUserSessions(userId, db),
  };
}
