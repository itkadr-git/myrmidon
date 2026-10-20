import { lte } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { redactionSubstitutions } from "@paperclipai/db";

export function startRedactionSubstitutionCleanup(db: Db, intervalMs = 60_000): () => void {
  const cleanup = async () => {
    await db.delete(redactionSubstitutions).where(lte(redactionSubstitutions.expiresAt, new Date()));
  };
  const timer = setInterval(() => void cleanup(), intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}
