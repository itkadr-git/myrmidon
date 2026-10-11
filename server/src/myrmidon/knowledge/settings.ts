// server/src/myrmidon/knowledge/settings.ts
//
// myrmidon(1.7 KNOWLEDGE-2.0 L-11): the "Settings → Knowledge" service.
//
// The values live in `knowledge_settings`, one row per company. Each field
// resolves UI → env → default (packages/shared/src/myrmidon-knowledge-settings.ts)
// and the view reports which layer won, so the screen can badge it. A write
// stores the chosen value; the next read badges it `ui`.

import { knowledgeSettings, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  applyKnowledgeSettingsPatch,
  knowledgeSettingsPatchErrors,
  readStoredKnowledgeSettings,
  resolveKnowledgeSettings,
  type KnowledgeSettingsPatch,
  type KnowledgeSettingsStored,
  type KnowledgeSettingsView,
} from "@paperclipai/shared";
import { badRequest } from "../../errors.js";
import { logActivity } from "../../services/activity-log.js";

export interface KnowledgeSettingsActor {
  actorType: "agent" | "user";
  actorId: string;
  agentId?: string | null;
  runId?: string | null;
}

type SettingsRow = typeof knowledgeSettings.$inferSelect;

function rowToStored(row: SettingsRow | undefined): KnowledgeSettingsStored {
  if (!row) return {};
  return readStoredKnowledgeSettings({
    knowledge: {
      maxItems: row.maxItems ?? undefined,
      maxRevisionBytes: row.maxRevisionBytes ?? undefined,
      autoAcceptEnabled: row.autoAcceptEnabled ?? undefined,
      autoAcceptMinConfidence: row.autoAcceptMinConfidence ?? undefined,
      schedule: row.schedule ?? undefined,
      sectionReviewers: row.sectionReviewers ?? undefined,
    },
  });
}

export function createKnowledgeSettingsService(db: Db, env: NodeJS.ProcessEnv = process.env) {
  async function readRow(companyId: string): Promise<SettingsRow | undefined> {
    const rows = await db
      .select()
      .from(knowledgeSettings)
      .where(eq(knowledgeSettings.companyId, companyId))
      .limit(1);
    return rows[0];
  }

  return {
    /** Effective settings with the source badge of every field. */
    async read(companyId: string): Promise<KnowledgeSettingsView> {
      const row = await readRow(companyId);
      return resolveKnowledgeSettings(rowToStored(row), env);
    },

    /**
     * Saves a patch. A field that fails its bounds is a 400 naming the field;
     * nothing is written. Returns the settings as they read after the write.
     */
    async update(
      companyId: string,
      patch: KnowledgeSettingsPatch,
      actor: KnowledgeSettingsActor,
    ): Promise<KnowledgeSettingsView> {
      const errors = knowledgeSettingsPatchErrors(patch);
      if (errors.length > 0) {
        throw badRequest("knowledge settings are out of bounds", { fields: errors });
      }
      const current = rowToStored(await readRow(companyId));
      const next = applyKnowledgeSettingsPatch(current, patch);
      const now = new Date();
      await db
        .insert(knowledgeSettings)
        .values({
          companyId,
          maxItems: next.maxItems ?? null,
          maxRevisionBytes: next.maxRevisionBytes ?? null,
          autoAcceptEnabled: next.autoAcceptEnabled ?? null,
          autoAcceptMinConfidence: next.autoAcceptMinConfidence ?? null,
          schedule: next.schedule ?? null,
          sectionReviewers: next.sectionReviewers ?? [],
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: knowledgeSettings.companyId,
          set: {
            maxItems: next.maxItems ?? null,
            maxRevisionBytes: next.maxRevisionBytes ?? null,
            autoAcceptEnabled: next.autoAcceptEnabled ?? null,
            autoAcceptMinConfidence: next.autoAcceptMinConfidence ?? null,
            schedule: next.schedule ?? null,
            sectionReviewers: next.sectionReviewers ?? [],
            updatedAt: now,
          },
        });
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId ?? null,
        runId: actor.runId ?? null,
        action: "knowledge.settings_updated",
        entityType: "knowledge_settings",
        entityId: companyId,
        details: { fields: Object.keys(patch) },
      });
      return resolveKnowledgeSettings(next, env);
    },
  };
}

export type KnowledgeSettingsService = ReturnType<typeof createKnowledgeSettingsService>;
