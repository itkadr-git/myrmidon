// server/src/myrmidon/autonomy/knowledge-regulations.ts
//
// myrmidon(1.6.6 KNOWLEDGE-2.0 K-3): compatibility projection for the
// autonomy regulations read API. Rules are held only by knowledge_items.

import type { Db } from "@paperclipai/db";
import type { AutonomyRegulation } from "@paperclipai/shared";
import { createKnowledgeModule } from "../knowledge/service.js";

const SYSTEM_ACTOR = { type: "system" as const, id: "system" };

/** Return rule items in the established autonomy-regulation response shape. */
export async function listKnowledgeAutonomyRegulations(db: Db, companyId: string): Promise<AutonomyRegulation[]> {
  const knowledge = createKnowledgeModule(db, companyId);
  const items = await knowledge.listItems({ kind: "rule" });
  return Promise.all(items.map(async (item) => {
    const revisions = await knowledge.listRevisions(item.id);
    const current = revisions.find((revision) => revision.revisionNumber === item.currentRevisionNumber) ?? revisions.at(-1);
    return {
      id: item.id,
      role: item.roles[0] ?? "*",
      title: item.title,
      bodyMarkdown: current?.content ?? "",
      status: item.status === "published" ? "approved" : "draft",
      revision: item.currentRevisionNumber,
      revisions: revisions.map((revision) => ({
        revision: revision.revisionNumber,
        title: item.title,
        bodyMarkdown: revision.content,
        status: revision.status === "approved" ? "approved" : "draft",
        author: SYSTEM_ACTOR,
        at: revision.createdAt,
      })),
      createdAt: item.createdAt,
      createdBy: SYSTEM_ACTOR,
      updatedAt: item.updatedAt,
      updatedBy: SYSTEM_ACTOR,
      supersededBy: null,
      // The legacy field name stays during the one-release compatibility window.
      wikiPageId: item.slug,
    } satisfies AutonomyRegulation;
  }));
}
