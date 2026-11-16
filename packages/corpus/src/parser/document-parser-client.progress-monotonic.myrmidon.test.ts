import { describe, expect, it } from "vitest";
import { createDocumentParserClient } from "./document-parser-client.js";
import type { DocumentParseSubmission } from "./types.js";

const submission: DocumentParseSubmission = {
  companyId: "company", datasetId: "dataset", documentId: "document",
  fileName: "test.pdf", mimeType: "application/pdf", content: new Uint8Array([1]),
  idempotencyKey: "attempt-1",
};

type State = { status: "running" | "pending"; progress?: unknown };
const running = (done: number, total = 100): State => ({ status: "running", progress: { done, total } });

describe("parser progress monotonicity", () => {
  it.each([
    { name: "equal and regressing progress", trace: [running(2), running(2), running(1), running(2), running(2)], timeout: 4, max: 20, end: 4, reason: "made no progress for 4 ms" },
    { name: "growth resets inactivity", trace: [running(2), running(2), running(3), running(3), running(3), running(3), running(3)], timeout: 4, max: 20, end: 6, reason: "made no progress for 4 ms" },
    { name: "growth cannot reset maximum run", trace: [running(2), running(2), running(3), running(4), running(5)], timeout: 4, max: 4, end: 4, reason: "still running after 4 ms" },
    { name: "negative progress", trace: [running(-4), running(-3), running(-2), running(-1), running(-1)], timeout: 4, max: 20, end: 4, reason: "made no progress for 4 ms" },
    { name: "fractional progress", trace: [running(0), running(0.1), running(0.2), running(0.3), running(0.4)], timeout: 4, max: 20, end: 4, reason: "made no progress for 4 ms" },
    { name: "missing total", trace: [0, 1, 2, 3, 4].map((done) => ({ status: "running" as const, progress: { done } })), timeout: 4, max: 20, end: 4, reason: "made no progress for 4 ms" },
    { name: "new running interval resets baseline and maximum", trace: [running(8), running(8), { status: "pending" as const }, running(1), running(2), running(2), running(2), running(2), running(2)], timeout: 4, max: 6, end: 8, reason: "made no progress for 4 ms" },
  ])("$name", async ({ trace, timeout, max, end, reason }) => {
    let time = 0;
    let polls = 0;
    let deletes = 0;
    let posts = 0;
    const fetchImpl: typeof fetch = async (_url, init) => {
      if (init?.method === "DELETE") {
        deletes++;
        return Response.json({ cancelled: true });
      }
      if (init?.method === "POST") posts++;
      else polls++;
      // A finite fallback prevents an incorrect heartbeat from hanging the test.
      const state = trace[Math.min(time, trace.length - 1)];
      return Response.json({ jobId: "job-1", ...state });
    };
    const parser = createDocumentParserClient({
      baseUrl: "http://parser.test", fetchImpl,
      pollIntervalMs: 1, pollTimeoutMs: timeout, maxRunMs: max,
      now: () => time, sleep: async (ms) => { time += ms; },
      retry: { attempts: 1, baseDelayMs: 1, maxDelayMs: 2 },
    });
    const outcome = await parser.parseDocument(submission);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected timeout");
    expect(outcome.jobId).toBe("job-1");
    expect(outcome.error.kind).toBe("timeout");
    expect(outcome.error.retryable).toBe(true);
    expect(outcome.error.message).toContain(reason);
    expect(time).toBe(end);
    expect(posts).toBe(1);
    expect(polls).toBe(end);
    expect(deletes).toBe(1);
  });
});
