// server/src/event-handlers/reflect-hook.test.ts
//
// myrmidon(1.7 POST-TASK-REFLECT): unit tests for reflect-hook event listener.
// Acceptance criteria:
// 1. событие request_changes триггерит вызов создания урока
// 2. событие done урока не создаёт
// 3. ошибка сохранения урока не роняет обработчик
// 4. CI зелёный

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  classifyBoardEvent,
  formatDraftLessonText,
  buildLessonDraft,
  handleBoardEvent,
  createReflectHook,
  dispatchReflectHook,
  setGlobalPostTaskReflectService,
  type BoardEvent,
  type PostTaskReflectService,
  type ReflectHookDeps,
  type LessonDraft,
} from "./reflect-hook.js";

describe("POST-TASK-REFLECT reflect-hook (OPE-12081)", () => {
  beforeEach(() => {
    setGlobalPostTaskReflectService(null);
  });

  describe("classifyBoardEvent", () => {
    it("identifies request_changes verdict as review_changes failure", () => {
      const res = classifyBoardEvent({
        verdict: "request_changes",
        feedback: "Please add missing error boundary",
      });
      expect(res.shouldCreateLesson).toBe(true);
      expect(res.failureKind).toBe("review_changes");
      expect(res.rootCause).toBe("Please add missing error boundary");
    });

    it("identifies action request_changes as review_changes failure", () => {
      const res = classifyBoardEvent({
        action: "request_changes",
        reason: "Test failure on shard 2",
      });
      expect(res.shouldCreateLesson).toBe(true);
      expect(res.failureKind).toBe("review_changes");
      expect(res.rootCause).toBe("Test failure on shard 2");
    });

    it("identifies decision request_changes in payload as review_changes failure", () => {
      const res = classifyBoardEvent({
        type: "issue.review_verdict",
        payload: {
          decision: "request_changes",
          note: "Refactor duplicated code",
        },
      });
      expect(res.shouldCreateLesson).toBe(true);
      expect(res.failureKind).toBe("review_changes");
      expect(res.rootCause).toBe("Refactor duplicated code");
    });

    it("identifies status blocked as blocked failure", () => {
      const res = classifyBoardEvent({
        status: "blocked",
        reason: "Waiting for API tokens from IT",
      });
      expect(res.shouldCreateLesson).toBe(true);
      expect(res.failureKind).toBe("blocked");
      expect(res.rootCause).toBe("Waiting for API tokens from IT");
    });

    it("identifies toStatus blocked with unblockDescriptor as blocked failure", () => {
      const res = classifyBoardEvent({
        toStatus: "blocked",
        unblockDescriptor: {
          action: "Provide database migration approval",
        },
      });
      expect(res.shouldCreateLesson).toBe(true);
      expect(res.failureKind).toBe("blocked");
      expect(res.rootCause).toBe("Provide database migration approval");
    });

    it("explicitly does NOT trigger lesson for done status (acceptance rule)", () => {
      const res = classifyBoardEvent({
        status: "done",
        verdict: "approve",
      });
      expect(res.shouldCreateLesson).toBe(false);
      expect(res.failureKind).toBeNull();
    });

    it("explicitly does NOT trigger lesson for toStatus done", () => {
      const res = classifyBoardEvent({
        type: "issue_status_changed",
        toStatus: "done",
      });
      expect(res.shouldCreateLesson).toBe(false);
      expect(res.failureKind).toBeNull();
    });

    it("does NOT trigger lesson for neutral/in_progress transition", () => {
      const res = classifyBoardEvent({
        status: "in_progress",
        reason: "Agent resumed work",
      });
      expect(res.shouldCreateLesson).toBe(false);
      expect(res.failureKind).toBeNull();
    });
  });

  describe("formatDraftLessonText", () => {
    it("formats first-person advice for review_changes failure", () => {
      const text = formatDraftLessonText({
        role: "engineer",
        failure_kind: "review_changes",
        root_cause: "missing unit tests for edge cases",
      });
      expect(text).toContain('When my work is returned from acceptance with "missing unit tests for edge cases"');
      expect(text).toContain("I address the review feedback and re-verify the acceptance criteria before resubmitting");
    });

    it("formats first-person advice for blocked failure", () => {
      const text = formatDraftLessonText({
        role: "engineer",
        failure_kind: "blocked",
        root_cause: "waiting for upstream PR #1234",
      });
      expect(text).toContain('When my task becomes blocked on "waiting for upstream PR #1234"');
      expect(text).toContain("I surface the blocker early and prepare everything around it");
    });

    it("includes context details when provided", () => {
      const text = formatDraftLessonText({
        role: "engineer",
        failure_kind: "review_changes",
        root_cause: "Lint errors",
        details: "run pnpm lint locally before pushing",
      });
      expect(text).toContain("Context: run pnpm lint locally before pushing.");
    });
  });

  describe("buildLessonDraft", () => {
    it("builds a valid LessonDraft for request_changes event", () => {
      const event: BoardEvent = {
        companyId: "comp-1",
        issueId: "issue-42",
        issueKey: "OPE-1234",
        role: "engineer",
        verdict: "request_changes",
        note: "Add input bounds checking",
        runId: "run-99",
      };

      const draft = buildLessonDraft(event, { defaultRole: "engineer" });
      expect(draft).not.toBeNull();
      expect(draft?.companyId).toBe("comp-1");
      expect(draft?.issueId).toBe("issue-42");
      expect(draft?.issueKey).toBe("OPE-1234");
      expect(draft?.role).toBe("engineer");
      expect(draft?.failure_kind).toBe("review_changes");
      expect(draft?.root_cause).toBe("Add input bounds checking");
      expect(draft?.runId).toBe("run-99");
      expect(draft?.expires_at_days).toBe(30);
      expect(draft?.dedupKey).toContain("issue-42:review_changes:");
    });

    it("returns null for done event", () => {
      const event: BoardEvent = {
        issueId: "issue-42",
        status: "done",
      };
      const draft = buildLessonDraft(event);
      expect(draft).toBeNull();
    });
  });

  describe("Acceptance Criteria 1: событие request_changes триггерит вызов создания урока", () => {
    it("triggers service createLesson when verdict is request_changes", async () => {
      const createLessonMock = vi.fn().mockImplementation((draft: LessonDraft) => ({
        id: "lesson-1",
        ...draft,
      }));
      const service: PostTaskReflectService = {
        createLesson: createLessonMock,
      };

      const event: BoardEvent = {
        companyId: "comp-1",
        issueId: "issue-100",
        verdict: "request_changes",
        feedback: "Missing required validation for empty inputs",
        role: "engineer",
      };

      const result = await handleBoardEvent(event, { service });

      expect(result.handled).toBe(true);
      expect(result.lessonCreated).toBe(true);
      expect(createLessonMock).toHaveBeenCalledTimes(1);

      const capturedDraft: LessonDraft = createLessonMock.mock.calls[0][0];
      expect(capturedDraft.failure_kind).toBe("review_changes");
      expect(capturedDraft.root_cause).toBe("Missing required validation for empty inputs");
      expect(capturedDraft.issueId).toBe("issue-100");
      expect(capturedDraft.role).toBe("engineer");
    });

    it("triggers service saveLesson when action is request_changes", async () => {
      const saveLessonMock = vi.fn().mockResolvedValue({ ok: true });
      const service: PostTaskReflectService = {
        saveLesson: saveLessonMock,
      };

      const event: BoardEvent = {
        companyId: "comp-1",
        issueId: "issue-101",
        action: "request_changes",
        reason: "CI pipeline failed on linters",
        role: "qa",
      };

      const result = await handleBoardEvent(event, { service });

      expect(result.handled).toBe(true);
      expect(result.lessonCreated).toBe(true);
      expect(saveLessonMock).toHaveBeenCalledTimes(1);
      expect(saveLessonMock.mock.calls[0][0].failure_kind).toBe("review_changes");
      expect(saveLessonMock.mock.calls[0][0].role).toBe("qa");
    });

    it("triggers service submitLesson when createLesson returns a record", async () => {
      const mockRecord = { id: "rec-123", content: "lesson text" };
      const createLessonMock = vi.fn().mockResolvedValue(mockRecord);
      const submitLessonMock = vi.fn().mockResolvedValue({ success: true, bankId: "role-comp-1-engineer" });

      const service: PostTaskReflectService = {
        createLesson: createLessonMock,
        submitLesson: submitLessonMock,
      };

      const event: BoardEvent = {
        companyId: "comp-1",
        issueId: "issue-102",
        type: "request_changes",
        root_cause: "Incompatible database migration",
      };

      const result = await handleBoardEvent(event, { service });

      expect(result.lessonCreated).toBe(true);
      expect(createLessonMock).toHaveBeenCalledTimes(1);
      expect(submitLessonMock).toHaveBeenCalledWith(mockRecord);
    });

    it("triggers service when issue becomes blocked", async () => {
      const createLessonMock = vi.fn().mockReturnValue({ id: "lesson-blk" });
      const service: PostTaskReflectService = {
        createLesson: createLessonMock,
      };

      const event: BoardEvent = {
        companyId: "comp-1",
        issueId: "issue-200",
        status: "blocked",
        unblockDescriptor: {
          action: "Approval required from lead",
        },
      };

      const result = await handleBoardEvent(event, { service });

      expect(result.handled).toBe(true);
      expect(result.lessonCreated).toBe(true);
      expect(createLessonMock).toHaveBeenCalledTimes(1);
      expect(createLessonMock.mock.calls[0][0].failure_kind).toBe("blocked");
      expect(createLessonMock.mock.calls[0][0].root_cause).toBe("Approval required from lead");
    });

    it("triggers global service if no explicit deps service is provided", async () => {
      const globalCreateLesson = vi.fn().mockResolvedValue({ id: "global-1" });
      setGlobalPostTaskReflectService({ createLesson: globalCreateLesson });

      const event: BoardEvent = {
        companyId: "comp-1",
        issueId: "issue-300",
        verdict: "request_changes",
      };

      const result = await handleBoardEvent(event);
      expect(result.lessonCreated).toBe(true);
      expect(globalCreateLesson).toHaveBeenCalledTimes(1);
    });
  });

  describe("Acceptance Criteria 2: событие done урока не создаёт", () => {
    it("does NOT trigger lesson creation for status done", async () => {
      const createLessonMock = vi.fn();
      const service: PostTaskReflectService = {
        createLesson: createLessonMock,
      };

      const event: BoardEvent = {
        companyId: "comp-1",
        issueId: "issue-400",
        status: "done",
        reason: "All tasks finished cleanly",
      };

      const result = await handleBoardEvent(event, { service });

      expect(result.handled).toBe(true);
      expect(result.lessonCreated).toBe(false);
      expect(createLessonMock).not.toHaveBeenCalled();
    });

    it("does NOT trigger lesson creation for toStatus done in state transition", async () => {
      const saveLessonMock = vi.fn();
      const service: PostTaskReflectService = {
        saveLesson: saveLessonMock,
      };

      const event: BoardEvent = {
        type: "issue_status_changed",
        fromStatus: "in_review",
        toStatus: "done",
        issueId: "issue-401",
      };

      const result = await handleBoardEvent(event, { service });

      expect(result.handled).toBe(true);
      expect(result.lessonCreated).toBe(false);
      expect(saveLessonMock).not.toHaveBeenCalled();
    });

    it("does NOT trigger lesson creation for verdict approve", async () => {
      const createLessonMock = vi.fn();
      const service: PostTaskReflectService = {
        createLesson: createLessonMock,
      };

      const event: BoardEvent = {
        type: "review_decision",
        verdict: "approve",
        issueId: "issue-402",
      };

      const result = await handleBoardEvent(event, { service });

      expect(result.handled).toBe(true);
      expect(result.lessonCreated).toBe(false);
      expect(createLessonMock).not.toHaveBeenCalled();
    });
  });

  describe("Acceptance Criteria 3: ошибка сохранения урока не роняет обработчик", () => {
    it("catches synchronous throw from service and does not crash caller", async () => {
      const warnMock = vi.fn();
      const failingService: PostTaskReflectService = {
        createLesson: () => {
          throw new Error("Database connection failed during lesson write");
        },
      };

      const event: BoardEvent = {
        companyId: "comp-1",
        issueId: "issue-500",
        verdict: "request_changes",
      };

      // Must not throw!
      const result = await handleBoardEvent(event, {
        service: failingService,
        logger: { warn: warnMock },
      });

      expect(result.handled).toBe(true);
      expect(result.lessonCreated).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain("Database connection failed");
      expect(warnMock).toHaveBeenCalledTimes(1);
    });

    it("catches asynchronous rejection from service and does not crash caller", async () => {
      const warnMock = vi.fn();
      const failingService: PostTaskReflectService = {
        saveLesson: () => Promise.reject(new Error("Hindsight retain 503 Service Unavailable")),
      };

      const event: BoardEvent = {
        companyId: "comp-1",
        issueId: "issue-501",
        status: "blocked",
        reason: "Needs key",
      };

      // Must not throw!
      const result = await handleBoardEvent(event, {
        service: failingService,
        logger: { warn: warnMock },
      });

      expect(result.handled).toBe(true);
      expect(result.lessonCreated).toBe(false);
      expect(result.error?.message).toContain("Hindsight retain 503");
      expect(warnMock).toHaveBeenCalledTimes(1);
    });

    it("catches submitLesson rejection after successful createLesson", async () => {
      const warnMock = vi.fn();
      const failingService: PostTaskReflectService = {
        createLesson: vi.fn().mockReturnValue({ id: "draft-1" }),
        submitLesson: () => Promise.reject(new Error("Network timeout to memory service")),
      };

      const event: BoardEvent = {
        companyId: "comp-1",
        issueId: "issue-502",
        action: "request_changes",
      };

      const result = await handleBoardEvent(event, {
        service: failingService,
        logger: { warn: warnMock },
      });

      expect(result.handled).toBe(true);
      expect(result.lessonCreated).toBe(false);
      expect(result.error?.message).toContain("Network timeout");
      expect(warnMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("Listener factory and non-blocking dispatch", () => {
    it("createReflectHook returns an invocable hook function", async () => {
      const createLessonMock = vi.fn().mockResolvedValue({ id: "ok" });
      const hook = createReflectHook({
        service: { createLesson: createLessonMock },
      });

      const res = await hook({ verdict: "request_changes" });
      expect(res.lessonCreated).toBe(true);
      expect(createLessonMock).toHaveBeenCalledTimes(1);
    });

    it("dispatchReflectHook runs without blocking and does not throw even on error", () => {
      const failingService: PostTaskReflectService = {
        createLesson: () => {
          throw new Error("Fatal failure in background");
        },
      };

      expect(() => {
        dispatchReflectHook(
          { verdict: "request_changes" },
          { service: failingService },
        );
      }).not.toThrow();
    });
  });
});
