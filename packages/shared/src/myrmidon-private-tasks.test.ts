// packages/shared/src/myrmidon-private-tasks.test.ts

import { describe, expect, it } from "vitest";
import {
  issuePrivacyFlagSchema,
  issuePrivacyWriteContract,
} from "./myrmidon-private-tasks.js";

describe("myrmidon(1.7) private tasks — issue privacy contract", () => {
  describe("issuePrivacyFlagSchema", () => {
    it("accepts a boolean flag", () => {
      expect(issuePrivacyFlagSchema.parse(true)).toBe(true);
      expect(issuePrivacyFlagSchema.parse(false)).toBe(false);
    });

    it("rejects non-boolean values", () => {
      expect(issuePrivacyFlagSchema.safeParse("true").success).toBe(false);
      expect(issuePrivacyFlagSchema.safeParse(1).success).toBe(false);
      expect(issuePrivacyFlagSchema.safeParse(null).success).toBe(false);
      expect(issuePrivacyFlagSchema.safeParse(undefined).success).toBe(false);
    });
  });

  describe("issuePrivacyWriteContract", () => {
    it("names the field, the allowed actor class, and the agent-facing error code", () => {
      expect(issuePrivacyWriteContract.field).toBe("isPrivate");
      expect(issuePrivacyWriteContract.actorAllowed).toBe("board");
      expect(issuePrivacyWriteContract.agentError).toBe(
        "issue_write_private_flag_rejected",
      );
    });

    it("agent error code is a known issue-write denial code", () => {
      // Keep the shared contract honest: the error code emitted to agents must
      // resolve to copy in issue-write-denial.ts so the denial is actionable.
      expect(issuePrivacyWriteContract.agentError).toMatch(
        /^issue_write_private_flag_rejected$/,
      );
    });
  });

  describe("create-issue validator accepts the flag (route enforces actor)", () => {
    it("isPrivate is accepted by the shared create schema", async () => {
      const { createIssueSchema } = await import("./validators/issue.js");
      const parsed = createIssueSchema.safeParse({
        title: "Private task",
        status: "todo",
        priority: "medium",
        isPrivate: true,
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.isPrivate).toBe(true);
      }
    });

    it("isPrivate is rejected by the shared create schema when not a boolean", async () => {
      const { createIssueSchema } = await import("./validators/issue.js");
      const parsed = createIssueSchema.safeParse({
        title: "Private task",
        status: "todo",
        priority: "medium",
        isPrivate: "yes",
      });
      expect(parsed.success).toBe(false);
    });
  });

  describe("update-issue validator accepts the flag (route enforces actor)", () => {
    it("isPrivate is accepted by the shared update schema", async () => {
      const { updateIssueSchema } = await import("./validators/issue.js");
      const parsed = updateIssueSchema.safeParse({ isPrivate: false });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.isPrivate).toBe(false);
      }
    });
  });
});
