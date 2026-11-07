import { describe, expect, it } from "vitest";
import {
  PAPERCLIP_WAKE_PAYLOAD_JSON_MAX_CHARS,
  PAPERCLIP_WAKE_RECENT_MAX_MESSAGES,
  PAPERCLIP_WAKE_RECENT_MESSAGE_MAX_CHARS,
  PAPERCLIP_WAKE_RECENT_TOTAL_MAX_CHARS,
  PAPERCLIP_WAKE_SUMMARY_MAX_CHARS,
  normalizePaperclipWakePayload,
  renderPaperclipWakePrompt,
  resolvePaperclipWakeHistoryMode,
  stringifyPaperclipWakePayload,
} from "./server-utils.js";
import { capWakePayloadJson, truncateWakeText } from "./wake-history.js";

const MESSAGE_COUNT = 30;
const marker = (index: number) => `HISTORY-MARKER-${String(index).padStart(2, "0")}-END`;

function message(index: number, body: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `message-${index}`,
    authorType: "user",
    authorId: "user-a",
    createdByRunId: null,
    body,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deleted: false,
    sourceTrust: { kind: "authenticated_user" },
    ...overrides,
  };
}

/** Thirty ~1k-character messages; the last one is long enough to need shortening. */
function threadMessages() {
  return Array.from({ length: MESSAGE_COUNT }, (_, index) =>
    message(index, `${marker(index)} ${"context ".repeat(index === MESSAGE_COUNT - 1 ? 700 : 115)}`),
  );
}

function wakePayload(options: { completedWork?: string; summaryBody?: string } = {}) {
  const messages = threadMessages();
  const summaryBody = options.summaryBody ?? "S".repeat(2_111);
  return {
    reason: "issue_continuation_needed",
    issue: { id: "issue-a", identifier: "TEST-1", title: "Example task", status: "in_progress" },
    executionContinuation: {
      version: 1,
      companyId: "company-a",
      issueId: "issue-a",
      trigger: { reason: "issue_continuation_needed", interactionId: null, sourceRunId: "run-previous" },
      originCommentIds: ["message-3"],
      objective: "Finish the example task.",
      messages,
      resumeDelta: { baseRunId: "run-previous", messages },
      interactionOutcomes: [],
      previousRun: { runId: "run-previous", status: "succeeded" },
      completedWork: options.completedWork ?? summaryBody,
      unresolvedInteractionIds: ["interaction-a"],
      coverage: { kind: "full_task_history", throughCommentId: "message-29", summaryThroughCommentId: null },
    },
    continuationSummary: {
      key: "continuation-summary",
      title: null,
      body: summaryBody,
      bodyTruncated: false,
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    comments: [],
    commentWindow: { requestedCount: 0, includedCount: 0, missingCount: 0 },
    fallbackFetchNeeded: false,
  };
}

const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

/** The request-context JSON line of the rendered continuation section. */
function requestContextOf(prompt: string): Record<string, any> {
  const section = prompt.split("## Current request and continuation context")[1] ?? "";
  const line = section.split("\n").find((entry) => entry.startsWith("{"));
  expect(line).toBeDefined();
  return JSON.parse(line!);
}

function evidenceOf(prompt: string): Record<string, any> {
  const section = prompt.split("### Untrusted continuation evidence")[1] ?? "";
  const line = section.split("\n").find((entry) => entry.startsWith("{"));
  expect(line).toBeDefined();
  return JSON.parse(line!);
}

describe("resolvePaperclipWakeHistoryMode", () => {
  it.each([
    [{ sessionKeyStrategy: "run" }, "summary"],
    [{ sessionKeyStrategy: "none" }, "summary"],
    [{ sessionKeyStrategy: "RUN " }, "summary"],
    [{ sessionKeyStrategy: "issue" }, "recent"],
    [{ sessionKeyStrategy: "agent" }, "recent"],
    [{}, "recent"],
    [null, "recent"],
    [{ sessionKeyStrategy: "run", wakeHistory: "recent" }, "recent"],
    [{ sessionKeyStrategy: "issue", wakeHistory: "summary" }, "summary"],
    [{ sessionKeyStrategy: "run", wakeHistory: "full" }, "full"],
    [{ sessionKeyStrategy: "run", wakeHistory: "auto" }, "summary"],
    [{ sessionKeyStrategy: "issue", wakeHistory: "bogus" }, "recent"],
  ] as const)("%j -> %s", (config, expected) => {
    expect(resolvePaperclipWakeHistoryMode(config)).toBe(expected);
  });
});

describe("continuation history reaches the model once", () => {
  it("never repeats a message between the rendered prompt and the JSON copy", () => {
    const wake = wakePayload();
    const json = stringifyPaperclipWakePayload(wake)!;
    for (const resumedSession of [false, true]) {
      const prompt = renderPaperclipWakePrompt(wake, { resumedSession });
      for (let index = 0; index < MESSAGE_COUNT; index++) {
        expect(occurrences(`${prompt}\n${json}`, marker(index)), `${marker(index)} resumed=${resumedSession}`).toBe(1);
      }
    }
  });

  it("keeps the JSON copy parseable with the envelope shape and cursors intact", () => {
    const parsed = JSON.parse(stringifyPaperclipWakePayload(wakePayload())!);
    const continuation = parsed.executionContinuation;
    expect(continuation).toMatchObject({
      version: 1,
      companyId: "company-a",
      issueId: "issue-a",
      trigger: { sourceRunId: "run-previous" },
      originCommentIds: ["message-3"],
      objective: "Finish the example task.",
      previousRun: { runId: "run-previous", status: "succeeded" },
      unresolvedInteractionIds: ["interaction-a"],
      messages: [],
      resumeDelta: { baseRunId: "run-previous", messages: [] },
      omittedFromJson: { messages: MESSAGE_COUNT, resumeDeltaMessages: MESSAGE_COUNT },
    });
    // A consumer that reads the JSON back still gets a version-1 envelope.
    expect(normalizePaperclipWakePayload(parsed)?.executionContinuation?.version).toBe(1);
  });

  it("leaves a payload without a continuation untouched", () => {
    const { executionContinuation: _drop, ...plain } = wakePayload();
    const parsed = JSON.parse(stringifyPaperclipWakePayload(plain)!);
    expect(parsed.executionContinuation).toBeNull();
    expect(parsed.jsonTruncation).toBeUndefined();
  });

  it("keeps the full history in the prompt when no history mode is asked for", () => {
    const prompt = renderPaperclipWakePrompt(wakePayload());
    for (let index = 0; index < MESSAGE_COUNT; index++) {
      expect(prompt).toContain(marker(index));
    }
    expect(prompt).toContain("complete authorized task history");
    expect(requestContextOf(prompt).coverage.kind).toBe("full_task_history");
  });
});

describe("summary history (run / none sessions)", () => {
  it("carries the previous run, its status, the summary and the open interactions, no messages", () => {
    const prompt = renderPaperclipWakePrompt(wakePayload(), { wakeHistory: "summary" });
    for (let index = 0; index < MESSAGE_COUNT; index++) {
      expect(prompt).not.toContain(marker(index));
    }
    const context = requestContextOf(prompt);
    expect(context.messages).toEqual([]);
    expect(context).toMatchObject({
      objective: "Finish the example task.",
      previousRun: { runId: "run-previous", status: "succeeded" },
      trigger: { sourceRunId: "run-previous" },
      originCommentIds: ["message-3"],
      unresolvedInteractionIds: ["interaction-a"],
      coverage: { kind: "summary_only" },
      wakeHistory: { mode: "summary", messagesIncluded: 0, messagesOmitted: MESSAGE_COUNT },
    });
    expect(context.wakeHistory.thread).toContain("/api/issues/issue-a/comments");
    expect(prompt).toContain("wake history: summary");
    expect(prompt).not.toContain("complete authorized task history");
    expect(prompt).toContain("Issue continuation summary:");
  });

  it("states the summary once when completed work is the continuation summary", () => {
    const prompt = renderPaperclipWakePrompt(wakePayload(), { wakeHistory: "summary" });
    // The 2111-character summary is rendered once (cut to the 2000-character cap), not twice.
    expect(occurrences(prompt, "S".repeat(1_500))).toBe(1);
    expect(evidenceOf(prompt).completedWork).toContain("identical to the 'Issue continuation summary'");
  });

  it("caps a different completed-work text and the continuation summary at 2000 characters", () => {
    const wake = wakePayload({ completedWork: "W".repeat(9_000), summaryBody: "S".repeat(3_900) });
    const prompt = renderPaperclipWakePrompt(wake, { wakeHistory: "summary" });
    const completedWork = evidenceOf(prompt).completedWork as string;
    expect(completedWork.length).toBeLessThanOrEqual(PAPERCLIP_WAKE_SUMMARY_MAX_CHARS);
    expect(completedWork).toContain("[wake cap:");
    const summarySection = prompt.split("Issue continuation summary:\n")[1]!.split("\n[continuation summary truncated]")[0]!;
    expect(summarySection.length).toBeLessThanOrEqual(PAPERCLIP_WAKE_SUMMARY_MAX_CHARS);
    expect(prompt).toContain("[continuation summary truncated]");
  });

  it("reduces a wake that was 3x the thread to a small fraction of its old size", () => {
    const wake = wakePayload();
    const legacy =
      renderPaperclipWakePrompt(wake).length + JSON.stringify(normalizePaperclipWakePayload(wake)).length;
    const slim =
      renderPaperclipWakePrompt(wake, { wakeHistory: "summary" }).length + stringifyPaperclipWakePayload(wake)!.length;
    expect(legacy).toBeGreaterThan(80_000);
    expect(slim).toBeLessThan(legacy / 5);
  });
});

describe("recent history (other sessions)", () => {
  it("keeps at most 8 messages once, each at most 1000 characters, 8000 in total", () => {
    const wake = wakePayload();
    const prompt = renderPaperclipWakePrompt(wake, { wakeHistory: "recent" });
    const context = requestContextOf(prompt);
    const messages = context.messages as Array<{ id: string; body: string }>;
    expect(messages.length).toBeLessThanOrEqual(PAPERCLIP_WAKE_RECENT_MAX_MESSAGES);
    for (const entry of messages) {
      expect(entry.body.length).toBeLessThanOrEqual(PAPERCLIP_WAKE_RECENT_MESSAGE_MAX_CHARS);
    }
    expect(messages.reduce((sum, entry) => sum + entry.body.length, 0)).toBeLessThanOrEqual(
      PAPERCLIP_WAKE_RECENT_TOTAL_MAX_CHARS,
    );
    // The newest entries and the comment the run was woken for stay; the middle goes.
    expect(messages.map((entry) => entry.id)).toEqual([
      "message-3",
      ...Array.from({ length: 7 }, (_, offset) => `message-${23 + offset}`),
    ]);
    expect(prompt).toContain(marker(3));
    expect(prompt).toContain(marker(29));
    expect(prompt).not.toContain(marker(10));
    expect(context.wakeHistory).toMatchObject({ mode: "recent", messagesIncluded: 8, messagesOmitted: 22 });
    expect(context.coverage.kind).toBe("recent_messages");
    expect(prompt).toContain("wake history: recent");
  });

  it("marks a shortened body with where the full text lives", () => {
    const prompt = renderPaperclipWakePrompt(wakePayload(), { wakeHistory: "recent" });
    const longest = (requestContextOf(prompt).messages as Array<{ id: string; body: string }>).find(
      (entry) => entry.id === "message-29",
    )!;
    expect(longest.body.length).toBeLessThanOrEqual(PAPERCLIP_WAKE_RECENT_MESSAGE_MAX_CHARS);
    expect(longest.body).toContain("[wake cap:");
    expect(longest.body).toContain("/api/issues/issue-a/comments");
    expect(requestContextOf(prompt).wakeHistory.bodiesShortened).toBe(1);
  });

  it("uses the delta of a resumed session as the message source", () => {
    const wake = wakePayload();
    wake.executionContinuation.resumeDelta = {
      baseRunId: "run-previous",
      messages: [message(7, `${marker(7)} edited`)],
    };
    const prompt = renderPaperclipWakePrompt(wake, { wakeHistory: "recent", resumedSession: true });
    const ids = (requestContextOf(prompt).messages as Array<{ id: string }>).map((entry) => entry.id);
    expect(ids).toEqual(["message-7"]);
  });
});

describe("structured wake payload JSON cap", () => {
  const bigComments = Array.from({ length: 12 }, (_, index) => ({
    id: `comment-${index}`,
    body: `comment ${index} ${"y".repeat(2_000)}`,
    author: { type: "user", id: "user-a" },
    createdAt: "2026-01-01T00:00:00.000Z",
  }));

  it("caps the JSON at 12000 characters and names what it emptied", () => {
    const wake = { ...wakePayload(), comments: bigComments, commentWindow: { requestedCount: 12, includedCount: 12, missingCount: 0 } };
    const json = stringifyPaperclipWakePayload(wake)!;
    expect(json.length).toBeLessThanOrEqual(PAPERCLIP_WAKE_PAYLOAD_JSON_MAX_CHARS);
    const parsed = JSON.parse(json);
    expect(parsed.jsonTruncation.droppedKeys).toContain("comments");
    expect(parsed.jsonTruncation).toMatchObject({ limitChars: PAPERCLIP_WAKE_PAYLOAD_JSON_MAX_CHARS });
    expect(parsed.jsonTruncation.originalChars).toBeGreaterThan(PAPERCLIP_WAKE_PAYLOAD_JSON_MAX_CHARS);
    expect(parsed.comments).toEqual([]);
    // Flags and ids the guards read are never emptied.
    expect(parsed.reason).toBe("issue_continuation_needed");
    expect(parsed.issue.identifier).toBe("TEST-1");
    // The prompt text still carries the comments.
    expect(renderPaperclipWakePrompt(wake, { wakeHistory: "summary" })).toContain("comment 5 ");
  });

  it("leaves a small payload as it is and honours maxChars 0", () => {
    const small = JSON.parse(stringifyPaperclipWakePayload(wakePayload())!);
    expect(small.jsonTruncation).toBeUndefined();
    const wake = { ...wakePayload(), comments: bigComments, commentWindow: { requestedCount: 12, includedCount: 12, missingCount: 0 } };
    const uncapped = stringifyPaperclipWakePayload(wake, { maxChars: 0 })!;
    expect(uncapped.length).toBeGreaterThan(PAPERCLIP_WAKE_PAYLOAD_JSON_MAX_CHARS);
    expect(JSON.parse(uncapped).jsonTruncation).toBeUndefined();
  });

  it("empties the largest cappable key first and trims a huge issue description last", () => {
    const capped = JSON.parse(
      capWakePayloadJson(
        {
          reason: "x",
          eventDigest: { text: "e".repeat(5_000) },
          comments: [{ body: "c".repeat(9_000) }],
          issue: { id: "issue-a", description: "d".repeat(20_000) },
        },
        4_000,
      ),
    );
    expect(capped.jsonTruncation.droppedKeys.slice(0, 2)).toEqual(["comments", "eventDigest"]);
    expect(capped.jsonTruncation.droppedKeys).toContain("issue.description");
    expect(JSON.stringify(capped).length).toBeLessThanOrEqual(4_000);
    expect(capped.issue.descriptionTruncated).toBe(true);
  });

  it("cuts text with a marker inside the budget and never splits a surrogate pair", () => {
    const cut = truncateWakeText("a".repeat(5_000), 1_000, "read it elsewhere");
    expect(cut.length).toBeLessThanOrEqual(1_000);
    expect(cut).toContain("read it elsewhere");
    const emoji = truncateWakeText("\u{1F600}".repeat(800), 500, "x");
    expect(emoji).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    expect(truncateWakeText("short", 1_000, "x")).toBe("short");
  });
});
