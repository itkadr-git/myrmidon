// server/src/myrmidon/distill/raw.ts
//
// myrmidon(1.6.6 KNOWLEDGE-2.0 K-5): the raw-material selector. §4.5: raw
// material is fetched by `completedAt` — issues finished inside the pass
// window, each one carried as title, description, the final executor +
// acceptance comments and task documents — never the whole feed. The selector
// is a port so the pass itself stays testable without a board.

import { and, asc, between, desc, eq, inArray, isNotNull } from "drizzle-orm";
import {
  companies,
  documents,
  issueComments,
  issueDocuments,
  issues,
  projects,
  type Db,
} from "@paperclipai/db";
/** One closed task in the shape the distiller prompt is built from. */
export interface DistillRawTask {
  identifier: string;
  title: string;
  description: string | null;
  status: string;
  completedAt: string;
  /** Last comment by the executor and by the acceptor (the outcome, not the feed). */
  finalComments: string[];
  /** Document bodies attached to the task (plan, results). */
  documents: Array<{ key: string; title: string | null; body: string }>;
  /** The project name the task belongs to — the direction signal for I-7. */
  projectName: string | null;
}

export interface DistillRawWindow {
  since: Date;
  until: Date;
}

const COMMENT_CAP = 3;
const DOC_BODY_CAP = 6_000;
const DESCRIPTION_CAP = 3_000;

/**
 * Tasks closed inside the window, oldest first. `sourceTrust`-external tasks
 * stay out: the distiller writes knowledge from the colony's own work (§4.5).
 */
export async function selectClosedTasks(db: Db, companyId: string, window: DistillRawWindow, maxTasks: number): Promise<DistillRawTask[]> {
  const rows = await db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
      description: issues.description,
      status: issues.status,
      completedAt: issues.completedAt,
      projectId: issues.projectId,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        isNotNull(issues.completedAt),
        between(issues.completedAt, window.since, window.until),
        inArray(issues.status, ["done", "cancelled"]),
      ),
    )
    .orderBy(asc(issues.completedAt))
    .limit(maxTasks);
  if (rows.length === 0) return [];

  const issueIds = rows.map((row) => row.id);
  const [comments, docs, projectRows] = await Promise.all([
    db
      .select({
        issueId: issueComments.issueId,
        body: issueComments.body,
        authorType: issueComments.authorType,
        createdAt: issueComments.createdAt,
      })
      .from(issueComments)
      .where(inArray(issueComments.issueId, issueIds))
      .orderBy(desc(issueComments.createdAt)),
    db
      .select({
        issueId: issueDocuments.issueId,
        key: issueDocuments.key,
        title: documents.title,
        body: documents.latestBody,
      })
      .from(issueDocuments)
      .innerJoin(documents, eq(documents.id, issueDocuments.documentId))
      .where(inArray(issueDocuments.issueId, issueIds)),
    rows.some((row) => row.projectId)
      ? db
          .select({ id: projects.id, name: projects.name, companyId: projects.companyId })
          .from(projects)
          .where(and(eq(projects.companyId, companyId), inArray(projects.id, rows.flatMap((row) => (row.projectId ? [row.projectId] : [])))))
      : Promise.resolve([]),
  ]);

  const projectNames = new Map(projectRows.map((p) => [p.id, p.name]));
  const commentsByIssue = new Map<string, Array<{ body: string; authorType: string | null }>>();
  for (const comment of comments) {
    const bucket = commentsByIssue.get(comment.issueId) ?? [];
    if (bucket.length < COMMENT_CAP) {
      bucket.push({ body: comment.body, authorType: comment.authorType });
      commentsByIssue.set(comment.issueId, bucket);
    }
  }
  const docsByIssue = new Map<string, Array<{ key: string; title: string | null; body: string }>>();
  for (const doc of docs) {
    const bucket = docsByIssue.get(doc.issueId) ?? [];
    bucket.push({ key: doc.key, title: doc.title, body: doc.body.slice(0, DOC_BODY_CAP) });
    docsByIssue.set(doc.issueId, bucket);
  }

  return rows.map((row) => ({
    identifier: row.identifier ?? row.id,
    title: row.title,
    description: row.description ? row.description.slice(0, DESCRIPTION_CAP) : null,
    status: row.status,
    completedAt: row.completedAt!.toISOString(),
    finalComments: (commentsByIssue.get(row.id) ?? []).map((c) => c.body),
    documents: docsByIssue.get(row.id) ?? [],
    projectName: row.projectId ? (projectNames.get(row.projectId) ?? null) : null,
  }));
}

/**
 * I-7 lexical boundary. A task belongs to the private `life` contour when its
 * project names it (`fleet-life`, `directions/life`, a bare `life` segment).
 * The check is deliberately lexical — refs and names are strings; the
 * distiller does not need the whole direction graph to enforce the boundary,
 * and the same predicate guards both raw selection and proposal filtering.
 */
export const LIFE_SEGMENT_RE = /(^|[^a-z0-9])life([^a-z0-9]|$)/i;

export function taskIsLife(task: Pick<DistillRawTask, "projectName">): boolean {
  return task.projectName != null && LIFE_SEGMENT_RE.test(task.projectName);
}

/** Window helper: `completedAt` since the previous pass, with overlap tolerance. */
export function passWindow(now: Date, windowMs: number, lastPassAt: Date | null): DistillRawWindow {
  const until = now;
  const floorByWindow = new Date(now.getTime() - windowMs);
  const since = lastPassAt && lastPassAt > floorByWindow ? lastPassAt : floorByWindow;
  return { since, until };
}

/** Companies that have knowledge activity (every active company today). */
export async function listCompanyIds(db: Db): Promise<string[]> {
  const rows = await db.select({ id: companies.id }).from(companies).where(eq(companies.status, "active"));
  return rows.map((row) => row.id);
}
