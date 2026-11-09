// server/src/modules/issues/domain/reflect-job.test.ts

import { describe, expect, it } from "vitest";
import {
  computeReflectJobDedupKey,
  shouldEnqueueReflectJob,
} from "./reflect-job.js";

describe("reflect-job domain", () => {
  describe("computeReflectJobDedupKey", () => {
    it("computes deterministic dedup key using issueId and event", () => {
      expect(computeReflectJobDedupKey("issue-123", "done")).toBe("issue-123:done");
    });

    it("defaults event to 'done' when omitted", () => {
      expect(computeReflectJobDedupKey("issue-456")).toBe("issue-456:done");
    });

    it("normalizes whitespace and case", () => {
      expect(computeReflectJobDedupKey("  issue-789  ", "DONE")).toBe("issue-789:done");
    });
  });

  describe("shouldEnqueueReflectJob", () => {
    it("returns true when transitioning from in_progress to done", () => {
      expect(shouldEnqueueReflectJob("in_progress", "done")).toBe(true);
    });

    it("returns true when transitioning from in_review to done", () => {
      expect(shouldEnqueueReflectJob("in_review", "done")).toBe(true);
    });

    it("returns true when transitioning from todo to done", () => {
      expect(shouldEnqueueReflectJob("todo", "done")).toBe(true);
    });

    it("returns true when transitioning from undefined/null to done", () => {
      expect(shouldEnqueueReflectJob(undefined, "done")).toBe(true);
      expect(shouldEnqueueReflectJob(null, "done")).toBe(true);
    });

    it("returns false when transitioning from done to done (repeated done)", () => {
      expect(shouldEnqueueReflectJob("done", "done")).toBe(false);
      expect(shouldEnqueueReflectJob("DONE", "done")).toBe(false);
    });

    it("returns false when toStatus is not done", () => {
      expect(shouldEnqueueReflectJob("in_progress", "in_review")).toBe(false);
      expect(shouldEnqueueReflectJob("todo", "in_progress")).toBe(false);
      expect(shouldEnqueueReflectJob("in_progress", "blocked")).toBe(false);
      expect(shouldEnqueueReflectJob("in_progress", "cancelled")).toBe(false);
    });
  });
});
