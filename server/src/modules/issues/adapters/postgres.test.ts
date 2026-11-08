// server/src/modules/issues/adapters/postgres.test.ts

import { describe, expect, it } from "vitest";
import type { ReflectJobRow } from "@myrmidon/db";
import { mapRowToReflectJob } from "./postgres.js";

describe("postgres adapter", () => {
  describe("mapRowToReflectJob", () => {
    it("maps db row into domain entity correctly", () => {
      const now = new Date();
      const row: ReflectJobRow = {
        id: "job-uuid-1",
        companyId: "comp-uuid-1",
        issueId: "issue-uuid-1",
        jobType: "post_task_reflect",
        status: "pending",
        dedupKey: "issue-uuid-1:done",
        event: "done",
        role: "engineer",
        assigneeAgentId: "agent-uuid-1",
        payload: { source: "test" },
        error: null,
        createdAt: now,
        updatedAt: now,
        startedAt: null,
        finishedAt: null,
      };

      const entity = mapRowToReflectJob(row);

      expect(entity.id).toBe("job-uuid-1");
      expect(entity.companyId).toBe("comp-uuid-1");
      expect(entity.issueId).toBe("issue-uuid-1");
      expect(entity.jobType).toBe("post_task_reflect");
      expect(entity.status).toBe("pending");
      expect(entity.dedupKey).toBe("issue-uuid-1:done");
      expect(entity.event).toBe("done");
      expect(entity.role).toBe("engineer");
      expect(entity.assigneeAgentId).toBe("agent-uuid-1");
      expect(entity.payload).toEqual({ source: "test" });
      expect(entity.error).toBeNull();
      expect(entity.createdAt).toBe(now);
      expect(entity.updatedAt).toBe(now);
      expect(entity.startedAt).toBeNull();
      expect(entity.finishedAt).toBeNull();
    });

    it("handles null role, assigneeAgentId, and error gracefully", () => {
      const now = new Date();
      const row: ReflectJobRow = {
        id: "job-uuid-2",
        companyId: "comp-uuid-2",
        issueId: "issue-uuid-2",
        jobType: "post_task_reflect",
        status: "completed",
        dedupKey: "issue-uuid-2:done",
        event: "done",
        role: null,
        assigneeAgentId: null,
        payload: null as unknown as Record<string, unknown>,
        error: null,
        createdAt: now,
        updatedAt: now,
        startedAt: now,
        finishedAt: now,
      };

      const entity = mapRowToReflectJob(row);

      expect(entity.role).toBeNull();
      expect(entity.assigneeAgentId).toBeNull();
      expect(entity.payload).toEqual({});
      expect(entity.error).toBeNull();
      expect(entity.startedAt).toBe(now);
      expect(entity.finishedAt).toBe(now);
    });
  });
});
