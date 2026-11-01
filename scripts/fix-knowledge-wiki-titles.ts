import { and, desc, eq } from "drizzle-orm";
import { createDb, createPgKnowledgeSearchIndex, knowledgeItems, knowledgeRevisions, type Db } from "../packages/db/src/index.js";
import { loadConfig } from "../server/src/config.js";
import { extractH1, getLastSegment } from "./fix-knowledge-wiki-titles-lib.js";

export { extractH1, getLastSegment };

export interface TitleFixCandidate {
  itemId: string;
  nestId: string;
  companyId: string;
  slug: string;
  oldTitle: string;
  proposedTitle: string;
  revisionId: string;
  revisionNumber: number;
}

export async function findWikiTitleFixCandidates(db: Db, companyId?: string | null): Promise<TitleFixCandidate[]> {
  const query = db
    .select({
      id: knowledgeItems.id,
      nestId: knowledgeItems.nestId,
      companyId: knowledgeItems.companyId,
      slug: knowledgeItems.slug,
      title: knowledgeItems.title,
      deliveredRevisionId: knowledgeItems.deliveredRevisionId,
      currentRevisionNumber: knowledgeItems.currentRevisionNumber,
    })
    .from(knowledgeItems)
    .where(companyId ? and(eq(knowledgeItems.kind, "wiki"), eq(knowledgeItems.companyId, companyId)) : eq(knowledgeItems.kind, "wiki"));

  const items = await query;
  const candidates: TitleFixCandidate[] = [];

  for (const item of items) {
    const lastSegment = getLastSegment(item.slug);
    if (item.title !== lastSegment) {
      continue;
    }

    let revision: { id: string; revisionNumber: number; content: string } | undefined;
    if (item.deliveredRevisionId) {
      const [rev] = await db
        .select({
          id: knowledgeRevisions.id,
          revisionNumber: knowledgeRevisions.revisionNumber,
          content: knowledgeRevisions.content,
        })
        .from(knowledgeRevisions)
        .where(eq(knowledgeRevisions.id, item.deliveredRevisionId))
        .limit(1);
      revision = rev;
    } else {
      const [rev] = await db
        .select({
          id: knowledgeRevisions.id,
          revisionNumber: knowledgeRevisions.revisionNumber,
          content: knowledgeRevisions.content,
        })
        .from(knowledgeRevisions)
        .where(
          and(
            eq(knowledgeRevisions.itemId, item.id),
            eq(knowledgeRevisions.revisionNumber, item.currentRevisionNumber),
          ),
        )
        .limit(1);
      revision = rev;
    }

    if (!revision) {
      continue;
    }

    const proposed = extractH1(revision.content);
    if (proposed && proposed !== item.title) {
      candidates.push({
        itemId: item.id,
        nestId: item.nestId,
        companyId: item.companyId,
        slug: item.slug,
        oldTitle: item.title,
        proposedTitle: proposed,
        revisionId: revision.id,
        revisionNumber: revision.revisionNumber,
      });
    }
  }

  return candidates;
}

export async function applyWikiTitleFixes(
  db: Db,
  candidates: TitleFixCandidate[],
  searchIndex?: ReturnType<typeof createPgKnowledgeSearchIndex> | null,
): Promise<{ updated: number }> {
  let count = 0;
  const now = new Date();

  for (const candidate of candidates) {
    await db.transaction(async (tx) => {
      await tx
        .update(knowledgeItems)
        .set({
          title: candidate.proposedTitle,
          updatedAt: now,
        })
        .where(eq(knowledgeItems.id, candidate.itemId));

      await tx
        .update(knowledgeRevisions)
        .set({
          title: candidate.proposedTitle,
        })
        .where(eq(knowledgeRevisions.id, candidate.revisionId));
    });

    if (searchIndex) {
      const [item] = await db
        .select()
        .from(knowledgeItems)
        .where(eq(knowledgeItems.id, candidate.itemId))
        .limit(1);
      if (item && item.deliveredRevisionId) {
        const [rev] = await db
          .select({ content: knowledgeRevisions.content })
          .from(knowledgeRevisions)
          .where(eq(knowledgeRevisions.id, item.deliveredRevisionId))
          .limit(1);
        if (rev) {
          await searchIndex.upsert({
            nestId: item.nestId,
            itemId: item.id,
            slug: item.slug,
            title: item.title,
            summary: item.summary,
            content: rev.content,
            kind: item.kind,
            folderPath: item.folderPath,
            tags: item.tags,
            roles: item.roles,
            status: item.status,
            deliveredRevisionId: item.deliveredRevisionId,
          }).catch((err) => {
            console.warn(`[fix-knowledge-wiki-titles] Search index error for ${item.slug}:`, err);
          });
        }
      }
    }

    count += 1;
  }

  return { updated: count };
}

function flag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

function databaseUrl(): string {
  const direct = process.env.DATABASE_URL;
  if (direct) return direct;
  const config = loadConfig();
  if (config.database?.url) return config.database.url;
  throw new Error("No database URL available (set DATABASE_URL or configure server config)");
}

async function main(): Promise<void> {
  const companyId = flag("--company-id") ?? flag("--company");
  const apply = process.argv.includes("--apply");
  const dryRun = !apply || process.argv.includes("--dry-run");

  const db = createDb(databaseUrl());
  const searchIndex = dryRun ? null : createPgKnowledgeSearchIndex(db);

  console.log(`Scanning wiki pages for titles matching slug last segment (mode: ${dryRun ? "DRY-RUN" : "APPLY"})...`);
  const candidates = await findWikiTitleFixCandidates(db, companyId);

  if (candidates.length === 0) {
    console.log("No wiki pages found with title matching slug last segment and containing an H1.");
    return;
  }

  console.log(`Found ${candidates.length} candidate page(s):`);
  for (const c of candidates) {
    console.log(`  [${c.slug}] "${c.oldTitle}" -> proposed: "${c.proposedTitle}" (rev #${c.revisionNumber})`);
  }

  if (dryRun) {
    console.log(`\nDry run complete. Found ${candidates.length} candidate(s). To apply changes, rerun with --apply.`);
  } else {
    console.log(`\nApplying updates to ${candidates.length} page(s)...`);
    const result = await applyWikiTitleFixes(db, candidates, searchIndex);
    console.log(`Successfully applied ${result.updated} title update(s).`);
  }
}

if (process.argv[1] && process.argv[1].endsWith("fix-knowledge-wiki-titles.ts")) {
  void main().catch((error: unknown) => {
    console.error(`fix-knowledge-wiki-titles failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
