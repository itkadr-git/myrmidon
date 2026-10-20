import { and, eq, gt, lte } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { redactionSubstitutions } from "@paperclipai/db";

export type RedactionMode = "reversible" | "irreversible" | "flag";
export interface DetectedRedactionEntity {
  type: string;
  value: string;
  start: number;
  end: number;
}
export interface RedactionResult {
  text: string;
  entities: Array<Omit<DetectedRedactionEntity, "value"> & { token?: string }>;
  redactionId?: string;
  expiresAt?: string;
}

export interface RedactionStore {
  save(id: string, pairs: Array<{ token: string; original: string }>, expiresAt: Date): Promise<void>;
  restore(id: string, text: string): Promise<string>;
  cleanup(now?: Date): Promise<number>;
}

export function drizzleRedactionStore(db: Db): RedactionStore {
  return {
    async save(redactionId, pairs, expiresAt) {
      if (!pairs.length) return;
      await db.insert(redactionSubstitutions).values(pairs.map((pair) => ({ ...pair, redactionId, expiresAt })));
    },
    async restore(redactionId, text) {
      const now = new Date();
      const rows = await db.select({ token: redactionSubstitutions.token, original: redactionSubstitutions.original })
        .from(redactionSubstitutions)
        .where(and(eq(redactionSubstitutions.redactionId, redactionId), gt(redactionSubstitutions.expiresAt, now)));
      return replaceTokens(text, rows);
    },
    async cleanup(now = new Date()) {
      const deleted = await db.delete(redactionSubstitutions).where(lte(redactionSubstitutions.expiresAt, now)).returning({ id: redactionSubstitutions.id });
      return deleted.length;
    },
  };
}

function replaceTokens(text: string, pairs: Array<{ token: string; original: string }>): string {
  let result = text;
  for (const { token, original } of pairs) result = result.split(token).join(original);
  return result;
}

export async function redactText(
  text: string,
  entities: DetectedRedactionEntity[],
  mode: RedactionMode,
  store: RedactionStore,
  options: { ttlMs?: number; now?: Date; id?: string } = {},
): Promise<RedactionResult> {
  const ordered = entities.filter((entity) => entity.start >= 0 && entity.end > entity.start && entity.end <= text.length)
    .sort((a, b) => a.start - b.start || b.end - a.end);
  if (mode === "flag") return { text, entities: ordered.map(({ type, start, end }) => ({ type, start, end })) };

  let output = "";
  let cursor = 0;
  let sequence = new Map<string, number>();
  const pairs: Array<{ token: string; original: string }> = [];
  const results: RedactionResult["entities"] = [];
  for (const entity of ordered) {
    if (entity.start < cursor) continue;
    output += text.slice(cursor, entity.start);
    const number = (sequence.get(entity.type) ?? 0) + 1;
    sequence.set(entity.type, number);
    const token = `[${entity.type.toUpperCase()}_${number}]`;
    output += token;
    results.push({ type: entity.type, start: entity.start, end: entity.end, token });
    if (mode === "reversible") pairs.push({ token, original: entity.value });
    cursor = entity.end;
  }
  output += text.slice(cursor);
  if (mode === "irreversible") return { text: output, entities: results };

  const id = options.id ?? randomUUID();
  const now = options.now ?? new Date();
  const expiresAt = new Date(now.getTime() + (options.ttlMs ?? 60 * 60 * 1000));
  await store.save(id, pairs, expiresAt);
  return { text: output, entities: results, redactionId: id, expiresAt: expiresAt.toISOString() };
}

export async function restoreText(store: RedactionStore, redactionId: string, text: string): Promise<string> {
  return store.restore(redactionId, text);
}
