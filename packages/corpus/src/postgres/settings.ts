// myrmidon(CORPUS-A): PostgreSQL store for per-company corpus module settings.
import { eq } from "drizzle-orm";
import { corpusSettings } from "@paperclipai/db";
import { CORPUS_DEFAULT_SETTINGS, type CorpusModuleSettings } from "../domain.js";
import type { CorpusSettingsStore } from "../ports.js";
import type { CorpusDb } from "./types.js";

type SettingsRow = typeof corpusSettings.$inferSelect;

function toSettings(row: SettingsRow): CorpusModuleSettings {
  return {
    enabled: row.enabled,
    defaultEmbedderBaseUrl: row.defaultEmbedderBaseUrl,
    defaultEmbeddingModel: row.defaultEmbeddingModel,
    defaultParserUrl: row.defaultParserUrl,
    defaultParserVersion: row.defaultParserVersion,
    blobStoreRoot: row.blobStoreRoot,
    extra: (row.extra ?? {}) as Record<string, unknown>,
  };
}

export class PostgresCorpusSettingsStore implements CorpusSettingsStore {
  constructor(private readonly db: CorpusDb) {}

  async getSettings(companyId: string): Promise<CorpusModuleSettings> {
    const rows = await this.db
      .select()
      .from(corpusSettings)
      .where(eq(corpusSettings.companyId, companyId));
    return rows[0] ? toSettings(rows[0]) : { ...CORPUS_DEFAULT_SETTINGS };
  }

  async updateSettings(
    companyId: string,
    patch: Partial<Omit<CorpusModuleSettings, "extra">> & { extra?: Record<string, unknown> },
  ): Promise<CorpusModuleSettings> {
    const rows = await this.db
      .insert(corpusSettings)
      .values({
        companyId,
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.defaultEmbedderBaseUrl !== undefined
          ? { defaultEmbedderBaseUrl: patch.defaultEmbedderBaseUrl }
          : {}),
        ...(patch.defaultEmbeddingModel !== undefined
          ? { defaultEmbeddingModel: patch.defaultEmbeddingModel }
          : {}),
        ...(patch.defaultParserUrl !== undefined ? { defaultParserUrl: patch.defaultParserUrl } : {}),
        ...(patch.defaultParserVersion !== undefined
          ? { defaultParserVersion: patch.defaultParserVersion }
          : {}),
        ...(patch.blobStoreRoot !== undefined ? { blobStoreRoot: patch.blobStoreRoot } : {}),
        ...(patch.extra !== undefined ? { extra: patch.extra } : {}),
      })
      .onConflictDoUpdate({
        target: corpusSettings.companyId,
        set: {
          ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
          ...(patch.defaultEmbedderBaseUrl !== undefined
            ? { defaultEmbedderBaseUrl: patch.defaultEmbedderBaseUrl }
            : {}),
          ...(patch.defaultEmbeddingModel !== undefined
            ? { defaultEmbeddingModel: patch.defaultEmbeddingModel }
            : {}),
          ...(patch.defaultParserUrl !== undefined ? { defaultParserUrl: patch.defaultParserUrl } : {}),
          ...(patch.defaultParserVersion !== undefined
            ? { defaultParserVersion: patch.defaultParserVersion }
            : {}),
          ...(patch.blobStoreRoot !== undefined ? { blobStoreRoot: patch.blobStoreRoot } : {}),
          ...(patch.extra !== undefined ? { extra: patch.extra } : {}),
          updatedAt: new Date(),
        },
      })
      .returning();
    return toSettings(rows[0]!);
  }
}
