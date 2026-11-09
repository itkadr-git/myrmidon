// server/src/event-handlers/reflect-hook.ts
//
// myrmidon(1.7 POST-TASK-REFLECT): board event listener hook that captures
// failure events (request_changes verdict or issue_blocked transition) and
// creates a draft lesson for the role bank via the POST-TASK-REFLECT service
// without blocking the main event flow.
//
// Task: OPE-12081 (roadmap-v1 §3.3 NEW POST-TASK-REFLECT)

export const FAILURE_KINDS = ["review_changes", "error", "blocked"] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

export const DEFAULT_LESSON_TTL_DAYS = 30;
export const DEFAULT_ROLE = "engineer";

export interface LessonDraft {
  id?: string;
  role: string;
  failure_kind: FailureKind;
  root_cause: string;
  lesson_text: string;
  companyId?: string | null;
  issueId?: string | null;
  issueKey?: string | null;
  runId?: string | null;
  dedupKey?: string | null;
  createdAt: string;
  expires_at_days: number;
  details?: string | null;
}

export interface BoardEvent {
  type?: string;
  event?: string;
  status?: string;
  toStatus?: string;
  fromStatus?: string;
  verdict?: string;
  decision?: string;
  action?: string;
  companyId?: string | null;
  issueId?: string | null;
  issueKey?: string | null;
  identifier?: string | null;
  role?: string | null;
  assigneeRole?: string | null;
  agentRole?: string | null;
  agentId?: string | null;
  assigneeAgentId?: string | null;
  runId?: string | null;
  reason?: string | null;
  note?: string | null;
  feedback?: string | null;
  root_cause?: string | null;
  details?: string | null;
  unblockDescriptor?: {
    owner?: unknown;
    action?: string | null;
    [key: string]: unknown;
  } | null;
  blockerMetadata?: Record<string, unknown> | null;
  payload?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface PostTaskReflectService {
  createLesson?(draft: LessonDraft): Promise<unknown> | unknown;
  createLessonRecord?(draft: LessonDraft): Promise<unknown> | unknown;
  saveLesson?(draft: LessonDraft): Promise<unknown> | unknown;
  submitLesson?(lesson: unknown, options?: unknown): Promise<unknown>;
}

export type PostTaskReflectHandler = (draft: LessonDraft) => Promise<unknown> | unknown;

export interface ReflectHookLogger {
  warn(obj: Record<string, unknown>, msg?: string): void;
  info?(obj: Record<string, unknown>, msg?: string): void;
  error?(obj: Record<string, unknown>, msg?: string): void;
}

export interface ReflectHookDeps {
  service?: PostTaskReflectService | PostTaskReflectHandler | null;
  defaultRole?: string;
  defaultTtlDays?: number;
  logger?: ReflectHookLogger;
  clock?: () => Date;
}

export interface ReflectHookResult {
  handled: boolean;
  lessonCreated: boolean;
  reason?: string;
  draft?: LessonDraft;
  error?: Error;
}

let globalService: PostTaskReflectService | PostTaskReflectHandler | null = null;

export function setGlobalPostTaskReflectService(
  service: PostTaskReflectService | PostTaskReflectHandler | null,
): void {
  globalService = service;
}

export function getGlobalPostTaskReflectService():
  | PostTaskReflectService
  | PostTaskReflectHandler
  | null {
  return globalService;
}

const defaultLogger: ReflectHookLogger = {
  warn(obj: Record<string, unknown>, msg?: string) {
    if (typeof console !== "undefined" && typeof console.warn === "function") {
      console.warn(`[reflect-hook] ${msg ?? "warning"}:`, obj);
    }
  },
};

function normalizeToken(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

const REVIEW_CHANGES_TOKENS = new Set([
  "request_changes",
  "review_changes",
  "review_change",
  "review_return",
  "return_from_acceptance",
  "changes_requested",
  "review_rejected",
  "rejected",
  "has_changes_requested",
]);

const BLOCKED_TOKENS = new Set([
  "blocked",
  "issue_blocked",
  "status_blocked",
  "issue.blocked",
]);

const TERMINAL_OR_SUCCESS_TOKENS = new Set([
  "done",
  "completed",
  "closed",
  "approve",
  "approved",
  "success",
]);

/**
 * Classifies an incoming board event to determine whether it should trigger
 * a POST-TASK-REFLECT lesson draft.
 *
 * Acceptance rules:
 * - `request_changes` triggers lesson draft (`failure_kind: "review_changes"`).
 * - `issue_blocked` / status `blocked` triggers lesson draft (`failure_kind: "blocked"`).
 * - `done` / `approve` explicitly NEVER triggers lesson draft.
 * - Other non-failure transitions do not trigger lesson creation.
 */
export function classifyBoardEvent(event: BoardEvent): {
  shouldCreateLesson: boolean;
  failureKind: FailureKind | null;
  rootCause: string;
  details: string | null;
} {
  const payload = (event.payload && typeof event.payload === "object" ? event.payload : {}) as Record<string, unknown>;

  const verdict = normalizeToken(event.verdict ?? payload.verdict ?? event.decision ?? payload.decision);
  const action = normalizeToken(event.action ?? payload.action);
  const eventName = normalizeToken(event.event ?? payload.event);
  const eventType = normalizeToken(event.type ?? payload.type);
  const status = normalizeToken(event.toStatus ?? event.status ?? payload.toStatus ?? payload.status);

  // Acceptance rule: done or approved events NEVER create a lesson.
  if (
    TERMINAL_OR_SUCCESS_TOKENS.has(status) ||
    TERMINAL_OR_SUCCESS_TOKENS.has(verdict) ||
    TERMINAL_OR_SUCCESS_TOKENS.has(action) ||
    TERMINAL_OR_SUCCESS_TOKENS.has(eventType) ||
    TERMINAL_OR_SUCCESS_TOKENS.has(eventName)
  ) {
    return {
      shouldCreateLesson: false,
      failureKind: null,
      rootCause: "",
      details: null,
    };
  }

  // 1. Check for request_changes verdict or action.
  if (
    REVIEW_CHANGES_TOKENS.has(verdict) ||
    REVIEW_CHANGES_TOKENS.has(action) ||
    REVIEW_CHANGES_TOKENS.has(eventType) ||
    REVIEW_CHANGES_TOKENS.has(eventName)
  ) {
    const { rootCause, details } = extractCauseAndDetails(event, payload, "review_changes");
    return {
      shouldCreateLesson: true,
      failureKind: "review_changes",
      rootCause,
      details,
    };
  }

  // 2. Check for blocked status or issue_blocked event.
  if (
    BLOCKED_TOKENS.has(status) ||
    BLOCKED_TOKENS.has(eventType) ||
    BLOCKED_TOKENS.has(eventName) ||
    BLOCKED_TOKENS.has(action)
  ) {
    const { rootCause, details } = extractCauseAndDetails(event, payload, "blocked");
    return {
      shouldCreateLesson: true,
      failureKind: "blocked",
      rootCause,
      details,
    };
  }

  return {
    shouldCreateLesson: false,
    failureKind: null,
    rootCause: "",
    details: null,
  };
}

function extractCauseAndDetails(
  event: BoardEvent,
  payload: Record<string, unknown>,
  failureKind: FailureKind,
): { rootCause: string; details: string | null } {
  const directCause =
    (typeof event.root_cause === "string" && event.root_cause.trim()) ||
    (typeof payload.root_cause === "string" && payload.root_cause.trim()) ||
    (typeof event.reason === "string" && event.reason.trim()) ||
    (typeof payload.reason === "string" && payload.reason.trim()) ||
    (typeof event.note === "string" && event.note.trim()) ||
    (typeof payload.note === "string" && payload.note.trim()) ||
    (typeof event.feedback === "string" && event.feedback.trim()) ||
    (typeof payload.feedback === "string" && payload.feedback.trim()) ||
    (typeof event.unblockDescriptor?.action === "string" && event.unblockDescriptor.action.trim()) ||
    (typeof (payload.unblockDescriptor as { action?: string } | undefined)?.action === "string" &&
      (payload.unblockDescriptor as { action?: string }).action?.trim()) ||
    null;

  const directDetails =
    (typeof event.details === "string" && event.details.trim()) ||
    (typeof payload.details === "string" && payload.details.trim()) ||
    null;

  let rootCause = directCause;
  if (!rootCause) {
    switch (failureKind) {
      case "review_changes":
        rootCause = "Review changes requested";
        break;
      case "blocked":
        rootCause = "Task marked blocked";
        break;
      case "error":
        rootCause = "Run failed";
        break;
    }
  }

  const details = directDetails && directDetails !== rootCause ? directDetails : null;
  return { rootCause, details };
}

/**
 * Generates the first-person template lesson text according to
 * roadmap-v1 §3.3 / design §4.1.
 */
export function formatDraftLessonText(input: {
  role: string;
  failure_kind: FailureKind;
  root_cause: string;
  details?: string | null;
}): string {
  const cause = input.root_cause.trim();
  const details = input.details?.trim();
  let body: string;

  switch (input.failure_kind) {
    case "review_changes":
      body =
        `When my work is returned from acceptance with "${cause}", I address ` +
        "the review feedback and re-verify the acceptance criteria before resubmitting.";
      break;
    case "blocked":
      body =
        `When my task becomes blocked on "${cause}", I surface the blocker early ` +
        "and prepare everything around it so work resumes immediately once it clears.";
      break;
    case "error":
      body =
        `When my run fails with "${cause}", I inspect the failure logs and fix ` +
        "the root cause before retrying instead of repeating the same attempt.";
      break;
    default:
      body = `When facing "${cause}", I verify requirements before proceeding.`;
      break;
  }

  const text = details ? `${body} Context: ${details}.` : body;
  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}

/**
 * Builds a structured LessonDraft from a board event.
 */
export function buildLessonDraft(
  event: BoardEvent,
  deps?: ReflectHookDeps,
): LessonDraft | null {
  const classification = classifyBoardEvent(event);
  if (!classification.shouldCreateLesson || !classification.failureKind) {
    return null;
  }

  const payload = (event.payload && typeof event.payload === "object" ? event.payload : {}) as Record<string, unknown>;

  const roleRaw =
    event.role ??
    payload.role ??
    event.assigneeRole ??
    payload.assigneeRole ??
    event.agentRole ??
    payload.agentRole ??
    deps?.defaultRole ??
    DEFAULT_ROLE;

  const role = typeof roleRaw === "string" && roleRaw.trim() ? roleRaw.trim().toLowerCase() : DEFAULT_ROLE;
  const companyId =
    (typeof event.companyId === "string" && event.companyId.trim()) ||
    (typeof payload.companyId === "string" && payload.companyId.trim()) ||
    null;

  const issueId =
    (typeof event.issueId === "string" && event.issueId.trim()) ||
    (typeof payload.issueId === "string" && payload.issueId.trim()) ||
    null;

  const issueKey =
    (typeof event.issueKey === "string" && event.issueKey.trim()) ||
    (typeof event.identifier === "string" && event.identifier.trim()) ||
    (typeof payload.issueKey === "string" && payload.issueKey.trim()) ||
    (typeof payload.identifier === "string" && payload.identifier.trim()) ||
    null;

  const runId =
    (typeof event.runId === "string" && event.runId.trim()) ||
    (typeof payload.runId === "string" && payload.runId.trim()) ||
    null;

  const now = deps?.clock ? deps.clock() : new Date();
  const createdAt = now.toISOString();
  const ttlDays = deps?.defaultTtlDays ?? DEFAULT_LESSON_TTL_DAYS;

  const lessonText = formatDraftLessonText({
    role,
    failure_kind: classification.failureKind,
    root_cause: classification.rootCause,
    details: classification.details,
  });

  const dedupKey = issueId
    ? `${issueId}:${classification.failureKind}:${now.getTime()}`
    : `reflect:${classification.failureKind}:${now.getTime()}`;

  return {
    role,
    failure_kind: classification.failureKind,
    root_cause: classification.rootCause,
    lesson_text: lessonText,
    companyId,
    issueId,
    issueKey,
    runId,
    dedupKey,
    createdAt,
    expires_at_days: ttlDays,
    details: classification.details,
  };
}

/**
 * Dispatches the lesson draft to the POST-TASK-REFLECT service safely.
 * Errors encountered while saving or submitting the lesson are caught
 * and logged; they NEVER bubble up to crash the caller.
 */
async function invokeReflectionService(
  service: PostTaskReflectService | PostTaskReflectHandler,
  draft: LessonDraft,
): Promise<void> {
  if (typeof service === "function") {
    await service(draft);
    return;
  }

  if (typeof service.createLesson === "function") {
    const record = await service.createLesson(draft);
    if (typeof service.submitLesson === "function" && record) {
      await service.submitLesson(record);
    }
    return;
  }

  if (typeof service.createLessonRecord === "function") {
    const record = await service.createLessonRecord(draft);
    if (typeof service.submitLesson === "function" && record) {
      await service.submitLesson(record);
    }
    return;
  }

  if (typeof service.saveLesson === "function") {
    await service.saveLesson(draft);
    return;
  }

  if (typeof service.submitLesson === "function") {
    await service.submitLesson(draft);
  }
}

/**
 * Handles a board event in the reflection hook.
 *
 * Guarantees:
 * 1. Non-blocking: returns cleanly without stalling the board main flow.
 * 2. Safe error boundary: failures in the reflection service or persistence
 *    are trapped and logged, and will NOT throw or crash the caller.
 * 3. Exact triggering rules:
 *    - `request_changes` triggers lesson draft creation.
 *    - `issue_blocked` / status `blocked` triggers lesson draft creation.
 *    - `done` explicitly does NOT trigger lesson draft creation.
 */
export async function handleBoardEvent(
  event: BoardEvent,
  deps?: ReflectHookDeps,
): Promise<ReflectHookResult> {
  const logger = deps?.logger ?? defaultLogger;

  try {
    const draft = buildLessonDraft(event, deps);
    if (!draft) {
      return {
        handled: true,
        lessonCreated: false,
        reason: "event does not trigger lesson creation",
      };
    }

    const service = deps?.service ?? globalService;
    if (!service) {
      return {
        handled: true,
        lessonCreated: false,
        reason: "no post-task-reflect service configured",
        draft,
      };
    }

    try {
      await invokeReflectionService(service, draft);
      return {
        handled: true,
        lessonCreated: true,
        draft,
      };
    } catch (saveError) {
      // Acceptance criterion: ошибка сохранения урока не роняет обработчик.
      const error = saveError instanceof Error ? saveError : new Error(String(saveError));
      logger.warn(
        {
          err: error,
          issueId: draft.issueId,
          failureKind: draft.failure_kind,
          role: draft.role,
        },
        "POST-TASK-REFLECT: saving lesson failed; swallowed safely to preserve board event flow",
      );
      return {
        handled: true,
        lessonCreated: false,
        draft,
        error,
      };
    }
  } catch (unexpectedError) {
    const error = unexpectedError instanceof Error ? unexpectedError : new Error(String(unexpectedError));
    logger.warn(
      { err: error },
      "POST-TASK-REFLECT: unexpected error in event classifier; swallowed safely",
    );
    return {
      handled: false,
      lessonCreated: false,
      error,
    };
  }
}

/**
 * Creates a configured listener function that can be hooked directly into
 * event buses or route lifecycle hooks.
 */
export function createReflectHook(
  deps?: ReflectHookDeps,
): (event: BoardEvent) => Promise<ReflectHookResult> {
  return (event: BoardEvent) => handleBoardEvent(event, deps);
}

/**
 * Completely asynchronous fire-and-forget dispatcher for cases where the
 * caller does not even await the promise.
 */
export function dispatchReflectHook(
  event: BoardEvent,
  deps?: ReflectHookDeps,
): void {
  void handleBoardEvent(event, deps).catch(() => {});
}
