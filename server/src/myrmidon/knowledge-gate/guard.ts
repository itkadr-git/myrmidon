import { and, eq, sql } from "drizzle-orm";
import {
  issueComments,
  issueLabels,
  labels,
  issueWorkProducts,
  knowledgeItems,
  knowledgeRevisions,
  type Db,
} from "@myrmidon/db";
import { unprocessable } from "../../errors.js";
import { logger } from "../../middleware/logger.js";

export const KNOWLEDGE_NOTE_REQUIRED = "knowledge_note_required";
export const KNOWLEDGE_GATE_START_DATE = new Date("2026-10-31T00:00:00Z");
export const KNOWLEDGE_GATE_GRACE_PERIOD_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

export function getKnowledgeGateMode(
  now: Date = new Date(),
  options?: { startDate?: Date; gracePeriodMs?: number },
): "warning" | "enforce" {
  if (process.env.MYRMIDON_KNOWLEDGE_GATE_MODE === "enforce") return "enforce";
  if (process.env.MYRMIDON_KNOWLEDGE_GATE_MODE === "warning") return "warning";
  const start =
    options?.startDate ??
    (process.env.MYRMIDON_KNOWLEDGE_GATE_START_DATE
      ? new Date(process.env.MYRMIDON_KNOWLEDGE_GATE_START_DATE)
      : KNOWLEDGE_GATE_START_DATE);
  const grace = options?.gracePeriodMs ?? KNOWLEDGE_GATE_GRACE_PERIOD_MS;
  return now.getTime() - start.getTime() < grace ? "warning" : "enforce";
}

export function isPathSystemAltering(filePath: string): boolean {
  const p = filePath.trim().replace(/^\/+/, "");
  const lower = p.toLowerCase();

  // docker/**
  if (lower.startsWith("docker/") || lower === "docker" || /(^|\/)docker\//i.test(p)) {
    return true;
  }
  // scripts/myrmidon/deploy/**
  if (
    lower.startsWith("scripts/myrmidon/deploy/") ||
    lower === "scripts/myrmidon/deploy" ||
    /(^|\/)scripts\/myrmidon\/deploy\//i.test(p)
  ) {
    return true;
  }
  // deploy/**
  if (lower.startsWith("deploy/") || lower === "deploy" || /(^|\/)deploy\//i.test(p)) {
    return true;
  }
  // compose
  if (lower.includes("compose")) {
    return true;
  }
  // packages/db/src/migrations/** or packages/db/migrations/**
  if (
    lower.startsWith("packages/db/src/migrations/") ||
    lower.startsWith("packages/db/migrations/") ||
    lower.includes("packages/db/src/migrations/") ||
    lower.includes("packages/db/migrations/")
  ) {
    return true;
  }
  // server/src/myrmidon/**/*-routes*
  if (lower.includes("server/src/myrmidon/") && lower.includes("-routes")) {
    return true;
  }
  // порт/порты/port(s) — JS \b is ASCII-only, so use explicit letter boundaries
  // to support Cyrillic.
  const portBoundary =
    /(?:^|[^a-zа-яё0-9_])(?:порт(?:ы|а|ов|ам|ах|е)?|ports?)(?=$|[^a-zа-яё0-9_])/i;
  if (portBoundary.test(p)) {
    return true;
  }

  return false;
}

export function isTextSystemAltering(text: string): boolean {
  // Check for keywords in title / description / PR body
  if (/(^|[\s/])docker\//i.test(text)) return true;
  if (/(^|[\s/])scripts\/myrmidon\/deploy\//i.test(text)) return true;
  if (/(^|[\s/])deploy\//i.test(text)) return true;
  if (/compose/i.test(text) || /docker-compose/i.test(text)) return true;
  if (
    /(?:^|[^a-zа-яё0-9_])(?:порт(?:ы|а|ов|ам|ах|е)?|ports?)(?=$|[^a-zа-яё0-9_])/i.test(
      text,
    )
  ) {
    return true;
  }
  if (/packages\/db\/(?:src\/)?migrations\//i.test(text)) return true;
  if (/server\/src\/myrmidon\/.*-routes/i.test(text)) return true;
  return false;
}

export async function detectSystemAlteringChanges(
  db: Db,
  params: {
    companyId: string;
    issueId: string;
    issue?: {
      title?: string | null;
      description?: string | null;
      tags?: string[] | null;
    };
    labels?: string[];
    files?: string[];
  },
): Promise<{ isSystemAltering: boolean; reasons: string[] }> {
  const reasons: string[] = [];

  // 1. Check explicitly passed files
  if (params.files && params.files.length > 0) {
    for (const f of params.files) {
      if (isPathSystemAltering(f)) {
        reasons.push(`file:${f}`);
      }
    }
  }

  // 2. Check labels (passed or from DB)
  if (params.labels && params.labels.length > 0) {
    for (const l of params.labels) {
      if (/^(infra|architecture)$/i.test(l.trim())) {
        reasons.push(`label:${l.trim()}`);
      }
    }
  } else {
    try {
      const issueLabelsRows = await db
        .select({ name: labels.name })
        .from(issueLabels)
        .innerJoin(labels, eq(issueLabels.labelId, labels.id))
        .where(eq(issueLabels.issueId, params.issueId));
      for (const row of issueLabelsRows) {
        if (/^(infra|architecture)$/i.test(row.name.trim())) {
          reasons.push(`label:${row.name.trim()}`);
        }
      }
    } catch (err) {
      logger.warn({ issueId: params.issueId, err }, "Failed to fetch issue labels for knowledge gate");
    }
  }

  // 3. Check tags if present
  if (params.issue?.tags) {
    for (const tag of params.issue.tags) {
      if (/^(infra|architecture)$/i.test(tag.trim())) {
        reasons.push(`tag:${tag.trim()}`);
      }
    }
  }

  // 4. Check text in issue title and description
  if (params.issue?.title && isTextSystemAltering(params.issue.title)) {
    reasons.push("text:title");
  }
  if (params.issue?.description && isTextSystemAltering(params.issue.description)) {
    reasons.push("text:description");
  }

  // 5. Check work products for the issue (pull requests, commits, workspace files)
  try {
    const products = await db
      .select({
        id: issueWorkProducts.id,
        type: issueWorkProducts.type,
        title: issueWorkProducts.title,
        summary: issueWorkProducts.summary,
        url: issueWorkProducts.url,
        metadata: issueWorkProducts.metadata,
      })
      .from(issueWorkProducts)
      .where(
        and(
          eq(issueWorkProducts.companyId, params.companyId),
          eq(issueWorkProducts.issueId, params.issueId),
        ),
      );

    for (const p of products) {
      if (p.title && isTextSystemAltering(p.title)) {
        reasons.push(`work_product_title:${p.title}`);
      }
      if (p.summary && isTextSystemAltering(p.summary)) {
        reasons.push(`work_product_summary:${p.id}`);
      }
      if (p.url && isPathSystemAltering(p.url)) {
        reasons.push(`work_product_url:${p.url}`);
      }
      if (p.metadata && typeof p.metadata === "object") {
        const meta = p.metadata as Record<string, unknown>;
        const candidateFiles: string[] = [];
        if (Array.isArray(meta.files)) {
          for (const f of meta.files) if (typeof f === "string") candidateFiles.push(f);
        }
        if (Array.isArray(meta.changedFiles)) {
          for (const f of meta.changedFiles) if (typeof f === "string") candidateFiles.push(f);
        }
        if (Array.isArray(meta.paths)) {
          for (const f of meta.paths) if (typeof f === "string") candidateFiles.push(f);
        }
        for (const cf of candidateFiles) {
          if (isPathSystemAltering(cf)) {
            reasons.push(`file:${cf}`);
          }
        }
      }
    }
  } catch (err) {
    logger.warn({ issueId: params.issueId, err }, "Failed to fetch work products for knowledge gate");
  }

  return {
    isSystemAltering: reasons.length > 0,
    reasons,
  };
}

export type WikiReference = {
  slug: string;
  rev: string;
};

export type ParsedWikiLine = {
  found: boolean;
  rawLine?: string;
  isNoChangesClaim?: boolean;
  noChangesReason?: string;
  references: WikiReference[];
};

export function parseWikiCommentLine(text: string): ParsedWikiLine {
  if (!text) {
    return { found: false, references: [] };
  }

  // Look for a line starting with "Вики:" or "Wiki:"
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*(?:Вики|Wiki):\s*(.+)$/i);
    if (!match) continue;

    const content = match[1].trim();

    // Check if it's "устройство не менялось"
    const noChangesMatch = content.match(/^устройство\s+не\s+менялось\s*(?:(?:—|–|-|:)\s*(.*))?$/i);
    if (noChangesMatch) {
      return {
        found: true,
        rawLine: line.trim(),
        isNoChangesClaim: true,
        noChangesReason: (noChangesMatch[1] ?? "").trim(),
        references: [],
      };
    }

    // Extract slug@rev references
    const refRegex = /([a-zA-Z0-9_./-]+)@([a-zA-Z0-9_-]+)/g;
    const references: WikiReference[] = [];
    let refMatch: RegExpExecArray | null;
    while ((refMatch = refRegex.exec(content)) !== null) {
      const rawSlug = refMatch[1].trim().replace(/^\/+|\/+$/g, "").toLowerCase();
      const rawRev = refMatch[2].trim();
      if (rawSlug && rawRev) {
        references.push({ slug: rawSlug, rev: rawRev });
      }
    }

    return {
      found: true,
      rawLine: line.trim(),
      isNoChangesClaim: false,
      references,
    };
  }

  return { found: false, references: [] };
}

export async function validateKnowledgeNoteRevisions(
  db: Db,
  companyId: string,
  references: WikiReference[],
): Promise<{
  valid: boolean;
  missing: Array<{ slug: string; rev: string; reason: string }>;
}> {
  const missing: Array<{ slug: string; rev: string; reason: string }> = [];

  for (const ref of references) {
    // 1. Find the knowledge item by slug in this company
    const items = await db
      .select({
        id: knowledgeItems.id,
        slug: knowledgeItems.slug,
      })
      .from(knowledgeItems)
      .where(
        and(
          eq(knowledgeItems.companyId, companyId),
          sql`lower(${knowledgeItems.slug}) = ${ref.slug}`,
        ),
      )
      .limit(1);

    if (items.length === 0) {
      missing.push({
        slug: ref.slug,
        rev: ref.rev,
        reason: `Knowledge item '${ref.slug}' not found`,
      });
      continue;
    }

    const item = items[0];

    // 2. Find the revision for that item
    const isUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        ref.rev,
      );
    const isNum = /^\d+$/.test(ref.rev);

    const revCondition = isUuid
      ? eq(knowledgeRevisions.id, ref.rev)
      : isNum
        ? eq(knowledgeRevisions.revisionNumber, Number.parseInt(ref.rev, 10))
        : sql`cast(${knowledgeRevisions.revisionNumber} as text) = ${ref.rev}`;

    const revisions = await db
      .select({ id: knowledgeRevisions.id })
      .from(knowledgeRevisions)
      .where(
        and(
          eq(knowledgeRevisions.itemId, item.id),
          revCondition,
        ),
      )
      .limit(1);

    if (revisions.length === 0) {
      missing.push({
        slug: ref.slug,
        rev: ref.rev,
        reason: `Revision '${ref.rev}' not found for knowledge item '${ref.slug}'`,
      });
    }
  }

  return {
    valid: missing.length === 0,
    missing,
  };
}

export type AssertKnowledgeGateOptions = {
  companyId: string;
  issueId: string;
  issue?: {
    title?: string | null;
    description?: string | null;
    tags?: string[] | null;
  };
  comment?: string | null;
  files?: string[];
  labels?: string[];
  now?: Date;
  forceEnforce?: boolean;
};

export async function assertKnowledgeGateSettled(
  db: Db,
  options: AssertKnowledgeGateOptions,
): Promise<{
  passed: boolean;
  warning?: boolean;
  isSystemAltering: boolean;
  reasons?: string[];
  missing?: Array<{ slug: string; rev: string; reason: string }>;
}> {
  // Step 1: Detect whether changes are system-altering
  const { isSystemAltering, reasons } = await detectSystemAlteringChanges(db, {
    companyId: options.companyId,
    issueId: options.issueId,
    issue: options.issue,
    labels: options.labels,
    files: options.files,
  });

  if (!isSystemAltering) {
    return { passed: true, isSystemAltering: false };
  }

  // Step 2: Determine gate mode: "warning" vs "enforce"
  const now = options.now ?? new Date();
  const mode = options.forceEnforce ? "enforce" : getKnowledgeGateMode(now);

  // Step 3: Check comment from current request or comments on the issue
  let parsedWiki: ParsedWikiLine = { found: false, references: [] };

  if (options.comment) {
    parsedWiki = parseWikiCommentLine(options.comment);
  }

  if (!parsedWiki.found) {
    // Check all issueComments for this issue
    try {
      const comments = await db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, options.issueId));

      for (const c of comments) {
        if (c.body) {
          const parsed = parseWikiCommentLine(c.body);
          if (parsed.found) {
            parsedWiki = parsed;
            // Prefer comments with references
            if (parsed.references.length > 0) {
              break;
            }
          }
        }
      }
    } catch (err) {
      logger.warn({ issueId: options.issueId, err }, "Failed to fetch issue comments for knowledge gate");
    }
  }

  // Check results:
  if (!parsedWiki.found) {
    if (mode === "warning") {
      logger.warn(
        {
          errorKind: "knowledge_note_required_warning",
          companyId: options.companyId,
          issueId: options.issueId,
          reasons,
        },
        `Warning: Issue ${options.issueId} has system-altering changes (${reasons.join(", ")}), but lacks a 'Вики:' line. Enforcing 422 in 3 days.`,
      );
      return {
        passed: true,
        warning: true,
        isSystemAltering: true,
        reasons,
        missing: [{ slug: "", rev: "", reason: "missing_wiki_line" }],
      };
    }

    throw unprocessable(KNOWLEDGE_NOTE_REQUIRED, {
      code: KNOWLEDGE_NOTE_REQUIRED,
      message: `Changes altering system architecture or infra (${reasons.join(", ")}) require a knowledge note: 'Вики: <slug>@<rev>'`,
      reasons,
      missing: [{ slug: "", rev: "", reason: "missing_wiki_line" }],
    });
  }

  // If parsedWiki has isNoChangesClaim:
  if (parsedWiki.isNoChangesClaim) {
    if (mode === "warning") {
      logger.warn(
        {
          errorKind: "knowledge_note_required_warning",
          companyId: options.companyId,
          issueId: options.issueId,
          reasons,
        },
        `Warning: Issue ${options.issueId} has system-altering changes (${reasons.join(", ")}), but only claims 'устройство не менялось'. Enforcing 422 in 3 days.`,
      );
      return {
        passed: true,
        warning: true,
        isSystemAltering: true,
        reasons,
        missing: [{ slug: "", rev: "", reason: "knowledge_revision_required" }],
      };
    }

    throw unprocessable(KNOWLEDGE_NOTE_REQUIRED, {
      code: KNOWLEDGE_NOTE_REQUIRED,
      message: `Changes altering system architecture or infra (${reasons.join(", ")}) require a knowledge note revision: 'Вики: <slug>@<rev>'`,
      reasons,
      missing: [{ slug: "", rev: "", reason: "knowledge_revision_required" }],
    });
  }

  // If no references found in the Вики: line:
  if (parsedWiki.references.length === 0) {
    if (mode === "warning") {
      logger.warn(
        {
          errorKind: "knowledge_note_required_warning",
          companyId: options.companyId,
          issueId: options.issueId,
          reasons,
        },
        `Warning: Issue ${options.issueId} has 'Вики:' line but no valid slug@rev references. Enforcing 422 in 3 days.`,
      );
      return {
        passed: true,
        warning: true,
        isSystemAltering: true,
        reasons,
        missing: [{ slug: "", rev: "", reason: "no_valid_slug_rev_references" }],
      };
    }

    throw unprocessable(KNOWLEDGE_NOTE_REQUIRED, {
      code: KNOWLEDGE_NOTE_REQUIRED,
      message: `Missing valid slug@rev in 'Вики:' line for system-altering changes (${reasons.join(", ")})`,
      reasons,
      missing: [{ slug: "", rev: "", reason: "no_valid_slug_rev_references" }],
    });
  }

  // Step 4: Validate all references in DB
  const { valid, missing } = await validateKnowledgeNoteRevisions(
    db,
    options.companyId,
    parsedWiki.references,
  );

  if (!valid) {
    if (mode === "warning") {
      logger.warn(
        {
          errorKind: "knowledge_note_required_warning",
          companyId: options.companyId,
          issueId: options.issueId,
          reasons,
          missing,
        },
        `Warning: Knowledge note revisions not found for ${missing.map((m) => `${m.slug}@${m.rev}`).join(", ")}. Enforcing 422 in 3 days.`,
      );
      return {
        passed: true,
        warning: true,
        isSystemAltering: true,
        reasons,
        missing,
      };
    }

    throw unprocessable(KNOWLEDGE_NOTE_REQUIRED, {
      code: KNOWLEDGE_NOTE_REQUIRED,
      message: `Knowledge note revision not found for ${missing.map((m) => `${m.slug}@${m.rev}`).join(", ")}`,
      reasons,
      missing,
    });
  }

  return {
    passed: true,
    isSystemAltering: true,
    reasons,
  };
}
