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
  const hasOriginInMeta =
    Boolean(input.metadata) &&
    typeof input.metadata === "object" &&
    ("origin" in (input.metadata as Record<string, unknown>) ||
      "source" in (input.metadata as Record<string, unknown>));

  const hasOriginInDesc =
    /откуда/i.test(desc) ||
    (/(сессия|chat|session)/i.test(desc) && /(дата|date)/i.test(desc) && /(кто|автор|author)/i.test(desc));

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
