import { describe, expect, it } from "vitest";
import type { BudgetLimitView } from "@myrmidon/shared";
import { agentCastes, agents, issues, projects, type Db } from "@myrmidon/db";
import { resolveEffectiveBudgetLimit, validateBudgetLimitScope } from "./store.js";

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

  it("prefers foraging over caste when both are configured", () => {
    const rows = [limit("foraging", "foraging", 300), limit("caste", "backend", 400)];
    expect(resolveEffectiveBudgetLimit(rows, { issueId: "issue-1", projectId: null, casteKey: "backend" })).toMatchObject({
      amountCents: 300,
      sourceLevel: "foraging",
      sourceRef: "foraging",
    });
  });

  it("falls back through foraging, caste, project, then company", () => {
    const rows = [limit("nest", "company", 100), limit("nest", "project-1", 200), limit("foraging", "foraging", 300), limit("caste", "backend", 400)];
    expect(resolveEffectiveBudgetLimit(rows, { issueId: "issue-1", projectId: "project-1", casteKey: "backend" }).sourceLevel).toBe("foraging");
    expect(resolveEffectiveBudgetLimit(rows, { issueId: "issue-1", projectId: "project-1", casteKey: null }).sourceLevel).toBe("foraging");
    expect(resolveEffectiveBudgetLimit([rows[0]], { issueId: "issue-1", projectId: "project-1", casteKey: null }).sourceRef).toBe("company");
  });
});

describe("validateBudgetLimitScope", () => {
  function mockDb(results: {
    projects?: Array<{ id: string }>;
    castes?: Array<{ key: string }>;
    agents?: Array<{ id: string }>;
    issues?: Array<{ id: string }>;
  }) {
    return {
      select: () => ({
        from: (table: unknown) => ({
          where: () => {
            if (table === projects) return results.projects ?? [];
            if (table === agentCastes) return results.castes ?? [];
            if (table === agents) return results.agents ?? [];
            if (table === issues) return results.issues ?? [];
            return [];
          },
        }),
      }),
    } as unknown as Db;
  }

  it("validates nest level: accepts company and existing project, rejects unknown project", async () => {
    expect(await validateBudgetLimitScope(mockDb({}), "company-1", "nest", "company")).toBeNull();
    expect(
      await validateBudgetLimitScope(
        mockDb({ projects: [{ id: "proj-1" }] }),
        "company-1",
        "nest",
        "proj-1",
      ),
    ).toBeNull();
    expect(
      await validateBudgetLimitScope(mockDb({ projects: [] }), "company-1", "nest", "proj-unknown"),
    ).toBe("nest ref must identify a project in this company");
  });

  it("validates caste level: accepts existing caste or agent role, rejects unknown caste", async () => {
    expect(
      await validateBudgetLimitScope(
        mockDb({ castes: [{ key: "engineer" }] }),
        "company-1",
        "caste",
        "engineer",
      ),
    ).toBeNull();
    expect(
      await validateBudgetLimitScope(
        mockDb({ castes: [], agents: [{ id: "agent-1" }] }),
        "company-1",
        "caste",
        "engineer",
      ),
    ).toBeNull();
    expect(
      await validateBudgetLimitScope(
        mockDb({ castes: [], agents: [] }),
        "company-1",
        "caste",
        "unknown-role",
      ),
    ).toBe("caste ref must identify a caste or agent role in this company");
  });

  it("validates issue level: accepts existing issue, rejects unknown issue", async () => {
    expect(
      await validateBudgetLimitScope(
        mockDb({ issues: [{ id: "iss-1" }] }),
        "company-1",
        "issue",
        "iss-1",
      ),
    ).toBeNull();
    expect(
      await validateBudgetLimitScope(mockDb({ issues: [] }), "company-1", "issue", "iss-unknown"),
    ).toBe("issue ref must identify an issue in this company");
  });

  it("allows foraging without scope lookup", async () => {
    expect(await validateBudgetLimitScope(mockDb({}), "company-1", "foraging", "foraging")).toBeNull();
  });
});
