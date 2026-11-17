import { describe, expect, it } from "vitest";
import { assertClaudeProfileImportOwner } from "./claude-profile-import-auth.js";

describe("Claude profile import authorization", () => {
  it("allows only an active owner of the selected company", () => {
    expect(() => assertClaudeProfileImportOwner({
      type: "board", userId: "owner", memberships: [
        { companyId: "company-a", status: "active", membershipRole: "owner" },
      ],
    }, "company-a")).not.toThrow();
    expect(() => assertClaudeProfileImportOwner({
      type: "board", userId: "owner", memberships: [
        { companyId: "company-b", status: "active", membershipRole: "owner" },
      ],
    }, "company-a")).toThrow();
    expect(() => assertClaudeProfileImportOwner({
      type: "board", userId: "admin", memberships: [
        { companyId: "company-a", status: "active", membershipRole: "admin" },
      ],
    }, "company-a")).toThrow();
    expect(() => assertClaudeProfileImportOwner({ type: "agent", userId: null }, "company-a")).toThrow();
  });
});
