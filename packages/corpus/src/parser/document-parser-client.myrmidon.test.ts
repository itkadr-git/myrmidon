import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDocumentParserClient } from "./document-parser-client.js";
import { DocumentParserError } from "./errors.js";
import type { DocumentParseSubmission } from "./types.js";

interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly body: string;
  readonly authorization: string | undefined;
}

type MockHandler = (request: RecordedRequest, response: ServerResponse) => void;

interface MockParserService {
  readonly baseUrl: string;
  readonly requests: RecordedRequest[];
  setHandler(handler: MockHandler): void;
  close(): Promise<void>;
}

const oneAttempt = { attempts: 1, baseDelayMs: 1, maxDelayMs: 2 };
const fastRetries = { attempts: 3, baseDelayMs: 1, maxDelayMs: 2 };

const submission: DocumentParseSubmission = {
  companyId: "aaaaaaaa-0000-0000-0000-000000000001",
  datasetId: "bbbbbbbb-0000-0000-0000-000000000002",
  documentId: "cccccccc-0000-0000-0000-000000000003",
  fileName: "dogovor.pdf",
  mimeType: "application/pdf",
  content: new Uint8Array([1, 2, 3, 4]),
};

let service: MockParserService;

function json(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(typeof payload === "string" ? payload : JSON.stringify(payload));
}

async function startMockParserService(): Promise<MockParserService> {
  const requests: RecordedRequest[] = [];
  let handler: MockHandler = (_request, response) => json(response, 500, { code: "no_handler" });
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const recorded: RecordedRequest = {
        method: request.method ?? "",
        url: request.url ?? "",
        body: Buffer.concat(chunks).toString("utf8"),
        authorization: request.headers.authorization,
      };
      requests.push(recorded);
      handler(recorded, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    setHandler: (next) => {
      handler = next;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function client(options: Partial<Parameters<typeof createDocumentParserClient>[0]> = {}) {
  return createDocumentParserClient({
    baseUrl: service.baseUrl,
    pollIntervalMs: 1,
    pollTimeoutMs: 2_000,
    sleep: async () => {},
    retry: fastRetries,
    ...options,
  });
}

beforeAll(async () => {
  service = await startMockParserService();
});

afterAll(async () => {
  await service.close();
});

describe("document parser client", () => {
  it("submits a document with the contract body and returns the accepted job", async () => {
    service.setHandler((_request, response) => json(response, 202, { jobId: "job-1", status: "pending" }));
    const parser = client({ apiKey: "test-key" });

    const job = await parser.submitDocument(submission, { signal: undefined });

    expect(job).toEqual({ jobId: "job-1", status: "pending" });
    const request = service.requests.at(-1);
    expect(request?.method).toBe("POST");
    expect(request?.url).toBe("/v1/parse");
    expect(request?.authorization).toBe("Bearer test-key");
    const body = JSON.parse(request?.body ?? "{}");
    expect(body).toMatchObject({
      companyId: submission.companyId,
      datasetId: submission.datasetId,
      documentId: submission.documentId,
      fileName: "dogovor.pdf",
      mimeType: "application/pdf",
      contentBase64: Buffer.from(submission.content).toString("base64"),
    });
    expect(typeof body.submissionId).toBe("string");
  });

  it("keeps the caller's idempotency key when one is given", async () => {
    service.setHandler((_request, response) => json(response, 202, { jobId: "job-1", status: "pending" }));
    await client({ apiKey: "test-key" }).submitDocument({ ...submission, idempotencyKey: "submission-42" });
    expect(JSON.parse(service.requests.at(-1)?.body ?? "{}").submissionId).toBe("submission-42");
  });

  it("polls a job until it is parsed and joins the pages when there is no plain text", async () => {
    let polls = 0;
    service.setHandler((request, response) => {
      if (request.method === "POST") {
        json(response, 202, { jobId: "job-2", status: "pending" });
        return;
      }
      polls += 1;
      if (polls < 2) {
        json(response, 200, { jobId: "job-2", status: "running" });
        return;
      }
      json(response, 200, {
        jobId: "job-2",
        status: "succeeded",
        pages: [
          { pageNumber: 1, text: "first page" },
          { pageNumber: 2, text: "second page" },
        ],
      });
    });

    const outcome = await client().parseDocument(submission);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.jobId).toBe("job-2");
    expect(outcome.result.pages).toHaveLength(2);
    expect(outcome.result.text).toBe("first page\n\nsecond page");
    expect(service.requests.at(-1)?.url).toBe("/v1/parse/job-2");
  });

  it("orders the pages of a job by page number", async () => {
    service.setHandler((request, response) => {
      if (request.method === "POST") {
        json(response, 202, { jobId: "job-8", status: "pending" });
        return;
      }
      json(response, 200, {
        jobId: "job-8",
        status: "succeeded",
        pages: [
          { pageNumber: 2, text: "second page" },
          { pageNumber: 1, text: "first page" },
        ],
      });
    });

    const outcome = await client().parseDocument(submission);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.pages.map((page) => page.pageNumber)).toEqual([1, 2]);
    expect(outcome.result.text).toBe("first page\n\nsecond page");
  });

  it("retries a service that answers 503 and succeeds on the next attempt", async () => {
    let submissions = 0;
    service.setHandler((request, response) => {
      if (request.method === "POST") {
        submissions += 1;
        if (submissions <= 2) {
          json(response, 503, { code: "overloaded", message: "try later" });
          return;
        }
        json(response, 202, { jobId: "job-3", status: "pending" });
        return;
      }
      json(response, 200, { jobId: "job-3", status: "succeeded", text: "parsed text" });
    });

    const outcome = await client().parseDocument(submission);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.text).toBe("parsed text");
    expect(submissions).toBe(3);
  });

  it("reports an accepted but failed job as a permanent failure", async () => {
    service.setHandler((request, response) => {
      if (request.method === "POST") {
        json(response, 202, { jobId: "job-4", status: "pending" });
        return;
      }
      json(response, 200, {
        jobId: "job-4",
        status: "failed",
        error: { code: "encrypted_pdf", message: "document is password protected" },
      });
    });

    const outcome = await client().parseDocument(submission);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.jobId).toBe("job-4");
    expect(outcome.error.kind).toBe("parse-failed");
    expect(outcome.error.code).toBe("encrypted_pdf");
    expect(outcome.error.retryable).toBe(false);
  });

  it("reports a refused request as a permanent failure without retrying", async () => {
    const before = service.requests.length;
    service.setHandler((_request, response) => json(response, 415, { code: "unsupported_media_type" }));

    const outcome = await client().parseDocument(submission);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe("rejected");
    expect(outcome.error.status).toBe(415);
    expect(outcome.error.code).toBe("unsupported_media_type");
    expect(outcome.error.retryable).toBe(false);
    expect(service.requests.length - before).toBe(1);
  });

  it("reports a service that does not answer in time as a retryable timeout", async () => {
    service.setHandler((_request, response) => {
      setTimeout(() => json(response, 200, { jobId: "job-5", status: "succeeded", text: "late" }), 300);
    });

    const outcome = await client({ timeoutMs: 20, retry: oneAttempt }).parseDocument(submission);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toBeInstanceOf(DocumentParserError);
    expect(outcome.error.kind).toBe("timeout");
    expect(outcome.error.retryable).toBe(true);
  });

  it("reports a job that never finishes as a retryable timeout", async () => {
    service.setHandler((request, response) => {
      if (request.method === "POST") {
        json(response, 202, { jobId: "job-6", status: "pending" });
        return;
      }
      json(response, 200, { jobId: "job-6", status: "running" });
    });

    const outcome = await client({ pollIntervalMs: 5, pollTimeoutMs: 30 }).parseDocument(submission);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe("timeout");
    expect(outcome.error.retryable).toBe(true);
    expect(outcome.jobId).toBe("job-6");
  });

  it("reports a body outside the contract as an invalid response", async () => {
    service.setHandler((_request, response) => json(response, 202, "not json at all"));

    const outcome = await client().parseDocument(submission);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe("invalid-response");
    expect(outcome.error.retryable).toBe(false);
  });

  it("reports a succeeded job without text as an invalid response", async () => {
    service.setHandler((request, response) => {
      if (request.method === "POST") {
        json(response, 202, { jobId: "job-7", status: "pending" });
        return;
      }
      json(response, 200, { jobId: "job-7", status: "succeeded", text: "" });
    });

    const outcome = await client().parseDocument(submission);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe("invalid-response");
  });

  it("reports an unreachable service as a retryable failure", async () => {
    const closed = await startMockParserService();
    const baseUrl = closed.baseUrl;
    await closed.close();

    const outcome = await createDocumentParserClient({ baseUrl, retry: oneAttempt }).parseDocument(submission);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe("unavailable");
    expect(outcome.error.retryable).toBe(true);
    expect(outcome.error.attempts).toBe(1);
  });

  it("rejects a base URL that is not absolute and timeouts outside the contract", () => {
    expect(() => createDocumentParserClient({ baseUrl: "parser:8080" })).toThrow(RangeError);
    expect(() => createDocumentParserClient({ baseUrl: service.baseUrl, timeoutMs: 0 })).toThrow(RangeError);
    expect(() => createDocumentParserClient({ baseUrl: service.baseUrl, pollTimeoutMs: -1 })).toThrow(RangeError);
  });
});