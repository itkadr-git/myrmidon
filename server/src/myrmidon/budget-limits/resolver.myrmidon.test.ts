import { describe, expect, it } from "vitest";
import type { BudgetLimitView } from "@paperclipai/shared";
import { resolveEffectiveBudgetLimit } from "./store.js";

const limit = (level: BudgetLimitView["level"], ref: string, amountCents: number): BudgetLimitView => ({
  id: `${level}-${ref}`,
  companyId: "company-1",
  level,
  ref,
  amountCents,
  period: "calendar_month_utc",
  mode: "hard",
  isActive: true,
  createdAt: "2026-10-20T00:00:00.000Z",
  updatedAt: "2026-10-20T00:00:00.000Z",
});

describe("resolveEffectiveBudgetLimit", () => {
  it("selects the deepest configured level", () => {
    const result = resolveEffectiveBudgetLimit(
      [
        limit("nest", "company", 100),
        limit("nest", "project-1", 200),
        limit("foraging", "foraging", 300),
        limit("caste", "backend", 400),
        limit("issue", "issue-1", 500),
      ],
      { issueId: "issue-1", projectId: "project-1", casteKey: "backend" },
    );
    expect(result).toMatchObject({ amountCents: 500, sourceLevel: "issue", sourceRef: "issue-1" });
  });

  it("falls back through caste, foraging, project, then company", () => {
    const rows = [limit("nest", "company", 100), limit("nest", "project-1", 200), limit("foraging", "foraging", 300), limit("caste", "backend", 400)];
    expect(resolveEffectiveBudgetLimit(rows, { issueId: "issue-1", projectId: "project-1", casteKey: "backend" }).sourceLevel).toBe("caste");
    expect(resolveEffectiveBudgetLimit(rows, { issueId: "issue-1", projectId: "project-1", casteKey: null }).sourceLevel).toBe("foraging");
    expect(resolveEffectiveBudgetLimit([rows[0]], { issueId: "issue-1", projectId: "project-1", casteKey: null }).sourceRef).toBe("company");
  });
});
