import { describe, expect, it } from "vitest";

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

function fixture(respond: (attempt: number) => Response) {
  const requests: { url: string; method: string | undefined }[] = [];
  const delays: number[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), method: init?.method });
    return respond(requests.length);
  };
  const parser = createDocumentParserClient({
    baseUrl: "https://parser.example",
    retry: { attempts: 3, baseDelayMs: 100, maxDelayMs: 1000 },
    fetchImpl,
    random: () => 0,
    sleep: async (ms) => { delays.push(ms); },
  });
  return { parser, requests, delays };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function expectPosts(requests: { url: string; method: string | undefined }[], count: number) {
  expect(requests).toEqual(Array.from({ length: count }, () => ({
    url: "https://parser.example/v1/parse", method: "POST",
  })));
}

describe("document parser HTTP status matrix", () => {
  it.each([408, 429, 500, 502, 503, 504])("exhausts retries for HTTP %i", async (status) => {
    const { parser, requests, delays } = fixture((attempt) => json(status, { code: `failure-${attempt}` }));
    const error = await parser.submitDocument(submission).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(DocumentParserError);
    expect(error).toMatchObject({ kind: "unavailable", status, code: "failure-3", attempts: 3, retryable: true });
    expectPosts(requests, 3);
    expect(delays).toEqual([50, 100]);
  });

  it.each([400, 401, 403, 404, 409, 422])("rejects HTTP %i without retry", async (status) => {
    const { parser, requests, delays } = fixture(() => json(status, { code: "refused" }));
    const error = await parser.submitDocument(submission).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(DocumentParserError);
    expect(error).toMatchObject({ kind: "rejected", status, code: "refused", attempts: 1, retryable: false });
    expectPosts(requests, 1);
    expect(delays).toEqual([]);
  });

  it("returns success without a stale error after a retry", async () => {
    const { parser, requests, delays } = fixture((attempt) => attempt === 1
      ? json(429, { code: "busy" })
      : json(202, { jobId: "job-1", status: "succeeded", text: "parsed" }));
    const outcome = await parser.parseDocument(submission);
    expect(outcome).toEqual({ ok: true, result: { jobId: "job-1", text: "parsed", pages: [] } });
    expectPosts(requests, 2);
    expect(delays).toEqual([50]);
  });

  it.each([null, 123, false, { nested: "value" }, ["code"]])("ignores non-string JSON code %j", async (code) => {
    const { parser, requests, delays } = fixture(() => json(400, { code }));
    const error = await parser.submitDocument(submission).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(DocumentParserError);
    expect(error).toMatchObject({ kind: "rejected", status: 400, code: undefined, attempts: 1, retryable: false });
    expectPosts(requests, 1);
    expect(delays).toEqual([]);
  });

  it.each([{ status: 503, kind: "unavailable", attempts: 3, retryable: true, delays: [50, 100] },
    { status: 404, kind: "rejected", attempts: 1, retryable: false, delays: [] }])(
    "preserves HTTP classification for HTML error $status", async ({ status, kind, attempts, retryable, delays: expectedDelays }) => {
      const { parser, requests, delays } = fixture(() => new Response("<html>error</html>", {
        status, headers: { "content-type": "text/html" },
      }));
      const error = await parser.submitDocument(submission).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(DocumentParserError);
      expect(error).toMatchObject({ kind, status, code: undefined, attempts, retryable });
      expectPosts(requests, attempts);
      expect(delays).toEqual(expectedDelays);
    },
  );
});
