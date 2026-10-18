// server/src/myrmidon/wiki-cortex/store.ts
//
// myrmidon(1.6-WIKI): the database side of the regulation lifecycle.
//
// One row per regulation (`myrmidon_wiki_regulations`, additive migration); the
// revision history rides in the `revisions` jsonb column. Writes take a row lock
// first, the pattern the instructions-revisions module uses, so two concurrent
// edits cannot take the same revision number.

import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  agentCastes,
  knowledgeItems,
  knowledgeRevisions,
  myrmidonWikiRegulations,
  type Db,
  type MyrmidonWikiRegulationRevision,
} from "@paperclipai/db";
import { BUILTIN_SENSITIVE_CASTES } from "@paperclipai/shared";
import { ruleApproverKind } from "../knowledge/rules.js";
import type { RegulationStore } from "./service.js";
import type { RegulationPageRecord, RegulationRevisionRecord } from "./types.js";

async function resolveCasteSensitivity(db: Db, companyId: string): Promise<{ sensitive: ReadonlySet<string> }> {
  try {
    const rows = await db
      .select({ key: agentCastes.key, sensitive: agentCastes.sensitive })
      .from(agentCastes)
      .where(eq(agentCastes.companyId, companyId));
    if (rows.length > 0) {
      return { sensitive: new Set(rows.filter((r) => r.sensitive).map((r) => r.key)) };
    }
  } catch {
    // In case agentCastes is not in mock db
  }
  return { sensitive: new Set(BUILTIN_SENSITIVE_CASTES) };
}

function toKnowledgePageRecord(
  item: typeof knowledgeItems.$inferSelect,
  revRows: (typeof knowledgeRevisions.$inferSelect)[],
): RegulationPageRecord {
  const revisions: RegulationRevisionRecord[] = revRows.map((r) => ({
    revisionNumber: r.revisionNumber,
    title: item.title,
    roles: (item.roles as string[]) ?? [],
    content: r.content,
    status: r.status === "approved" ? "approved" : "draft",
    changeSummary: r.changeSummary ?? null,
    createdByAgentId: r.createdByAgentId ?? null,
    createdByUserId: r.createdByUserId ?? null,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
  }));
  const currentRev =
    revisions.find((r) => r.revisionNumber === item.currentRevisionNumber) ?? revisions.at(-1);
  return {
    id: item.id,
    companyId: item.companyId,
    slug: item.slug,
    title: item.title,
    roles: (item.roles as string[]) ?? [],
    status: currentRev?.status === "approved" ? "approved" : "draft",
    revisionNumber: item.currentRevisionNumber || (currentRev?.revisionNumber ?? 1),
    content: currentRev?.content ?? "",
    revisions,
    createdAt: item.createdAt instanceof Date ? item.createdAt : new Date(item.createdAt),
    updatedAt: item.updatedAt instanceof Date ? item.updatedAt : new Date(item.updatedAt),
  };
}

function toRevision(row: MyrmidonWikiRegulationRevision): RegulationRevisionRecord {
  return {
    revisionNumber: row.revisionNumber,
    title: row.title,
    roles: row.roles ?? [],
    content: row.content,
    status: row.status,
    changeSummary: row.changeSummary ?? null,
    createdByAgentId: row.createdByAgentId ?? null,
    createdByUserId: row.createdByUserId ?? null,
    createdAt: row.createdAt,
  };
}

export function toPage(row: typeof myrmidonWikiRegulations.$inferSelect): RegulationPageRecord {
  return {
    id: row.id,
    companyId: row.companyId,
    slug: row.slug,
    title: row.title,
    roles: row.roles ?? [],
    status: row.status,
    revisionNumber: row.revisionNumber,
    content: row.content,
    revisions: (row.revisions ?? []).map(toRevision),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toRowValues(page: RegulationPageRecord) {
  return {
    id: page.id,
    companyId: page.companyId,
    slug: page.slug,
    title: page.title,
    roles: page.roles,
    status: page.status,
    revisionNumber: page.revisionNumber,
    content: page.content,
    revisions: page.revisions,
    updatedAt: page.updatedAt,
  };
}

export function createDbRegulationStore(db: Db): RegulationStore {
  return {
    async list(companyId: string): Promise<RegulationPageRecord[]> {
      const items = await db
        .select()
        .from(knowledgeItems)
        .where(and(eq(knowledgeItems.nestId, companyId), eq(knowledgeItems.kind, "rule")));
      if (items.length === 0) return [];
      const itemIds = items.map((i) => i.id);
      const revRows = await db
        .select()
        .from(knowledgeRevisions)
        .where(inArray(knowledgeRevisions.itemId, itemIds))
        .orderBy(knowledgeRevisions.revisionNumber);
      const revMap = new Map<string, (typeof knowledgeRevisions.$inferSelect)[]>();
      for (const rev of revRows) {
        const list = revMap.get(rev.itemId) ?? [];
        list.push(rev);
        revMap.set(rev.itemId, list);
      }
      return items.map((item) => toKnowledgePageRecord(item, revMap.get(item.id) ?? []));
    },

    async get(companyId: string, slug: string): Promise<RegulationPageRecord | null> {
      const [item] = await db
        .select()
        .from(knowledgeItems)
        .where(and(eq(knowledgeItems.nestId, companyId), eq(knowledgeItems.slug, slug), eq(knowledgeItems.kind, "rule")));
      if (!item) return null;
      const revRows = await db
        .select()
        .from(knowledgeRevisions)
        .where(eq(knowledgeRevisions.itemId, item.id))
        .orderBy(knowledgeRevisions.revisionNumber);
      return toKnowledgePageRecord(item, revRows);
    },

    async put(page: RegulationPageRecord): Promise<RegulationPageRecord> {
      const sensitivity = await resolveCasteSensitivity(db, page.companyId);
      const approverKind = ruleApproverKind(page.roles ?? [], sensitivity);

      return db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(knowledgeItems)
          .where(and(eq(knowledgeItems.nestId, page.companyId), eq(knowledgeItems.slug, page.slug), eq(knowledgeItems.kind, "rule")))
          .for("update");

        const isUuid = (id: string | null | undefined): id is string =>
          typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
        const itemId = existing?.id ?? (isUuid(page.id) ? page.id : randomUUID());
        const at = page.updatedAt instanceof Date ? page.updatedAt : new Date();

        if (!existing) {
          await tx.insert(knowledgeItems).values({
            id: itemId,
            companyId: page.companyId,
            nestId: page.companyId,
            kind: "rule",
            slug: page.slug,
            title: page.title,
            summary: null,
            status: "draft",
            folderPath: page.slug.includes("/") ? page.slug.replace(/\/[^/]*$/, "") : "",
            tags: [],
            roles: page.roles ?? [],
            approvalRequired: true,
            approverKind,
            deliveredRevisionId: null,
            currentRevisionNumber: page.revisionNumber,
            createdAt: page.createdAt instanceof Date ? page.createdAt : at,
            updatedAt: at,
          });
        }

        for (const rev of page.revisions) {
          const revCreatedAt = rev.createdAt ? new Date(rev.createdAt) : at;
          await tx
            .insert(knowledgeRevisions)
            .values({
              id: randomUUID(),
              companyId: page.companyId,
              nestId: page.companyId,
              itemId,
              revisionNumber: rev.revisionNumber,
              status: rev.status === "approved" ? "approved" : "draft",
              content: rev.content,
              changeSummary: rev.changeSummary ?? null,
              createdByAgentId: rev.createdByAgentId ?? null,
              createdByUserId: rev.createdByUserId ?? null,
              createdAt: revCreatedAt,
              approvedAt: rev.status === "approved" ? revCreatedAt : null,
            })
            .onConflictDoUpdate({
              target: [knowledgeRevisions.itemId, knowledgeRevisions.revisionNumber],
              set: {
                status: rev.status === "approved" ? "approved" : "draft",
                content: rev.content,
                changeSummary: rev.changeSummary ?? null,
                approvedAt: rev.status === "approved" ? sql`coalesce(${knowledgeRevisions.approvedAt}, now())` : null,
              },
            });
        }

        const [deliveredRev] = await tx
          .select({ id: knowledgeRevisions.id })
          .from(knowledgeRevisions)
          .where(and(eq(knowledgeRevisions.itemId, itemId), eq(knowledgeRevisions.status, "approved")))
          .orderBy(desc(knowledgeRevisions.revisionNumber))
          .limit(1);

        const [updatedItem] = await tx
          .update(knowledgeItems)
          .set({
            title: page.title,
            roles: page.roles ?? [],
            approverKind,
            currentRevisionNumber: page.revisionNumber,
            deliveredRevisionId: deliveredRev?.id ?? null,
            status: deliveredRev ? "published" : "draft",
            updatedAt: at,
          })
          .where(eq(knowledgeItems.id, itemId))
          .returning();

        const allRevs = await tx
          .select()
          .from(knowledgeRevisions)
          .where(eq(knowledgeRevisions.itemId, itemId))
          .orderBy(knowledgeRevisions.revisionNumber);

        return toKnowledgePageRecord(updatedItem!, allRevs);
      });
    },
  };
}
