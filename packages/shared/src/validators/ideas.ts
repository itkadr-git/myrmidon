export interface IdeasProjectConstraintsInput {
  projectName?: string | null;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  dueDate?: unknown;
  description?: string | null;
  metadata?: unknown;
}

export function isIdeasProjectName(name?: string | null): boolean {
  if (!name) return false;
  const normalized = name.trim().toLowerCase();
  return normalized === "идеи" || normalized === "ideas";
}

export function validateIdeasProjectConstraints(input: IdeasProjectConstraintsInput): { valid: boolean; error?: string } {
  if (!isIdeasProjectName(input.projectName)) {
    return { valid: true };
  }

  // 1. Without assignee
  if (input.assigneeAgentId || input.assigneeUserId) {
    return {
      valid: false,
      error: "Карточки в проекте «Идеи» должны быть без исполнителя (статус «идея»)",
    };
  }

  // 2. Without deadline/dueDate
  if (input.dueDate) {
    return {
      valid: false,
      error: "Карточки в проекте «Идеи» должны быть без срока",
    };
  }

  // 3. Mandatory origin ("откуда")
  const desc = typeof input.description === "string" ? input.description : "";
  const meta = input.metadata && typeof input.metadata === "object" ? (input.metadata as Record<string, unknown>) : null;
  const hasOriginInMeta =
    Boolean(meta) &&
    (("origin" in meta! && Boolean(meta!.origin)) ||
      ("source" in meta! && Boolean(meta!.source)));

  const hasOriginHeader = /(?:^|[\r\n])\s*(?:#+\s*)?(?:\*{1,2}|\[)?(?:откуда|источник|origin|source)(?:\*{1,2}|\])?\s*[:\n\-#]/i.test(desc);
  const hasOriginFields =
    /(?:^|[\r\n])\s*[-*]?\s*(?:сессия|session|chat)\s*:/i.test(desc) &&
    /(?:^|[\r\n])\s*[-*]?\s*(?:дата|date)\s*:/i.test(desc) &&
    /(?:^|[\r\n])\s*[-*]?\s*(?:кто(?:\s+сказал)?|автор|author)\s*:/i.test(desc);

  const hasOriginInDesc = hasOriginHeader || hasOriginFields;

  if (!hasOriginInMeta && !hasOriginInDesc) {
    return {
      valid: false,
      error: "Карточки в проекте «Идеи» требуют обязательного поля «откуда» (сессия, дата, кто сказал) в описании или метаданных",
    };
  }

  return { valid: true };
}

export interface IdeasWeeklySLAResult {
  total: number;
  compliant: number;
  staleCount: number;
  staleIssueIds: string[];
}

export function checkIdeasWeeklySLA(
  issues: Array<{ id: string; status: string; createdAt: Date | string }>,
  now: Date = new Date(),
): IdeasWeeklySLAResult {
  const cutoff = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  const staleIssueIds: string[] = [];
  let compliant = 0;

  for (const issue of issues) {
    const isProcessed = issue.status === "done" || issue.status === "cancelled";
    const createdTime = new Date(issue.createdAt).getTime();
    if (isProcessed || createdTime >= cutoff) {
      compliant += 1;
    } else {
      staleIssueIds.push(issue.id);
    }
  }

  return {
    total: issues.length,
    compliant,
    staleCount: staleIssueIds.length,
    staleIssueIds,
  };
}
