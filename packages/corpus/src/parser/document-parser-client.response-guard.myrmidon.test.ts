import { describe, expect, it, vi } from "vitest";

import { createDocumentParserClient } from "./document-parser-client.js";
import { DocumentParserError } from "./errors.js";
import type { DocumentParseSubmission } from "./types.js";

const submission: DocumentParseSubmission = {
  companyId: "company-1",
  datasetId: "dataset-1",
  documentId: "document-1",
  fileName: "document.pdf",
  mimeType: "application/pdf",
  idempotencyKey: "submission-1",
};

const cases = [
  { name: "missing jobId", body: { status: "pending" }, message: "job payload has no jobId" },
  { name: "unknown status", body: { jobId: "job-1", status: "mystery" }, message: "job payload has an unknown status: mystery" },
  { name: "non-object page", body: { jobId: "job-1", status: "succeeded", pages: ["not a page"] }, message: "page entry is not an object" },
  { name: "null page", body: { jobId: "job-1", status: "succeeded", pages: [null] }, message: "page entry is not an object" },
];

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("document parser malformed job response guard", () => {
  it.each(cases)("rejects $name on submission without retrying", async ({ body, message }) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(body, 202));
    const sleep = vi.fn(async () => {});
    const parser = createDocumentParserClient({
      baseUrl: "http://parser.test", fetchImpl, sleep,
      retry: { attempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
    });

    const outcome = await parser.parseDocument(submission);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected invalid response");
    expect(outcome.jobId).toBeUndefined();
    expect(outcome.error).toBeInstanceOf(DocumentParserError);
    expect(outcome.error).toMatchObject({ kind: "invalid-response", retryable: false, message });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://parser.test/v1/parse");
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each(cases)("rejects $name on polling without retrying and cancels the known job", async ({ body, message }) => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ jobId: "job-1", status: "pending" }, 202))
      .mockResolvedValueOnce(response(body))
      .mockResolvedValueOnce(response({ cancelled: true }));
    const sleep = vi.fn(async () => {});
    const parser = createDocumentParserClient({
      baseUrl: "http://parser.test", fetchImpl, sleep, pollIntervalMs: 1,
      retry: { attempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
    });

    const outcome = await parser.parseDocument(submission);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected invalid response");
    expect(outcome.jobId).toBe("job-1");
    expect(outcome.error).toBeInstanceOf(DocumentParserError);
    expect(outcome.error).toMatchObject({ kind: "invalid-response", retryable: false, message });
    expect(fetchImpl.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ["http://parser.test/v1/parse", "POST"],
      ["http://parser.test/v1/parse/job-1", "GET"],
      ["http://parser.test/v1/parse/job-1", "DELETE"],
    ]);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(1);
  });

  it("returns a valid completed job without retrying or cancelling", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({
      jobId: "job-1", status: "succeeded", pages: [{ pageNumber: 1, text: "parsed" }],
    }, 202));
    const sleep = vi.fn(async () => {});
    const parser = createDocumentParserClient({ baseUrl: "http://parser.test", fetchImpl, sleep });

    expect(await parser.parseDocument(submission)).toEqual({
      ok: true, result: { jobId: "job-1", text: "parsed", pages: [{ pageNumber: 1, text: "parsed" }] },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
