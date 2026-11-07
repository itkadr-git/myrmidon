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
    ...(options.parserTimeoutMs === undefined ? { pollTimeoutMs: 2_000 } : {}),
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
      contentBase64: Buffer.from(submission.content ?? new Uint8Array()).toString("base64"),
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

  it("uses parserTimeoutMs for a long-running job when no dedicated poll timeout is set", async () => {
    let currentTime = 0;
    let polls = 0;
    service.setHandler((request, response) => {
      if (request.method === "POST") {
        json(response, 202, { jobId: "long-job", status: "pending" });
        return;
      }
      polls += 1;
      if (polls === 1) {
        currentTime = 120_001;
        json(response, 200, { jobId: "long-job", status: "running" });
        return;
      }
      json(response, 200, { jobId: "long-job", status: "succeeded", text: "finished after two minutes" });
    });

    const outcome = await client({
      parserTimeoutMs: 600_000,
      pollIntervalMs: 1,
      now: () => currentTime,
      sleep: async (milliseconds) => {
        currentTime += milliseconds;
      },
    }).parseDocument(submission);

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.result.text).toBe("finished after two minutes");
    expect(polls).toBe(2);
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
describe("document parser client: time limit from the start of the job, cancellation of a job nobody waits for", () => {
  const deleteRequests = () => service.requests.filter((request) => request.method === "DELETE");

  /** A fake clock: `now` and `sleep` move the same counter, nothing waits for real. */
  function fakeClock() {
    const clock = { time: 0 };
    return {
      clock,
      now: () => clock.time,
      sleep: async (milliseconds: number) => {
        clock.time += milliseconds;
      },
    };
  }

  it("does not count the wait in the service's queue against the time limit of the job", async () => {
    const { clock, now, sleep } = fakeClock();
    let polls = 0;
    service.setHandler((request, response) => {
      if (request.method === "POST") {
        json(response, 202, { jobId: "queued-job", status: "pending" });
        return;
      }
      polls += 1;
      // 40 polls of 1 s in the queue, three times the 10 s limit, then 5 s of running.
      if (polls <= 40) return json(response, 200, { jobId: "queued-job", status: "pending" });
      if (polls <= 45) return json(response, 200, { jobId: "queued-job", status: "running" });
      json(response, 200, { jobId: "queued-job", status: "succeeded", text: "done after a long wait" });
    });
    const before = service.requests.length;

    const outcome = await client({ pollIntervalMs: 1_000, pollTimeoutMs: 10_000, now, sleep }).parseDocument(submission);

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.result.text).toBe("done after a long wait");
    expect(clock.time).toBeGreaterThan(30_000);
    expect(service.requests.slice(before).some((request) => request.method === "DELETE")).toBe(false);
  });

  it("starts the clock when the job runs and gives up pollTimeoutMs later", async () => {
    const { clock, now, sleep } = fakeClock();
    let runningFrom: number | undefined;
    service.setHandler((request, response) => {
      if (request.method === "POST") {
        json(response, 202, { jobId: "slow-job", status: "pending" });
        return;
      }
      if (request.method === "DELETE") {
        json(response, 200, { jobId: "slow-job", cancelled: true, status: "cancelled" });
        return;
      }
      if (clock.time < 50_000) return json(response, 200, { jobId: "slow-job", status: "pending" });
      runningFrom ??= clock.time;
      json(response, 200, { jobId: "slow-job", status: "running" });
    });

    const outcome = await client({ pollIntervalMs: 1_000, pollTimeoutMs: 10_000, now, sleep }).parseDocument(submission);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe("timeout");
    expect(outcome.error.retryable).toBe(true);
    expect(outcome.error.message).toContain("of running");
    expect(outcome.jobId).toBe("slow-job");
    // The limit was hit 10 s after the first poll that saw the job running, not 10 s after the submission.
    expect(runningFrom).toBe(50_000);
    expect(clock.time).toBe(60_000);
  });

  it("stops the clock while a job is back in the queue", async () => {
    const { clock, now, sleep } = fakeClock();
    let polls = 0;
    service.setHandler((request, response) => {
      if (request.method === "POST") {
        json(response, 202, { jobId: "requeued-job", status: "pending" });
        return;
      }
      polls += 1;
      // running 6 s, back in the queue 30 s (the service restarted), running 6 s, done: no single run exceeds 10 s.
      if (polls <= 6) return json(response, 200, { jobId: "requeued-job", status: "running" });
      if (polls <= 36) return json(response, 200, { jobId: "requeued-job", status: "pending" });
      if (polls <= 42) return json(response, 200, { jobId: "requeued-job", status: "running" });
      json(response, 200, { jobId: "requeued-job", status: "succeeded", text: "finished" });
    });

    const outcome = await client({ pollIntervalMs: 1_000, pollTimeoutMs: 10_000, now, sleep }).parseDocument(submission);

    expect(outcome.ok).toBe(true);
    expect(clock.time).toBeGreaterThan(40_000);
  });

  it("gives up on a job that never leaves the queue and cancels it", async () => {
    const { now, sleep } = fakeClock();
    service.setHandler((request, response) => {
      if (request.method === "POST") {
        json(response, 202, { jobId: "stuck-job", status: "pending" });
        return;
      }
      if (request.method === "DELETE") {
        json(response, 200, { jobId: "stuck-job", cancelled: true, status: "cancelled" });
        return;
      }
      json(response, 200, { jobId: "stuck-job", status: "pending" });
    });
    const before = deleteRequests().length;

    const outcome = await client({ pollIntervalMs: 1_000, pollTimeoutMs: 10_000, queueTimeoutMs: 60_000, now, sleep })
      .parseDocument(submission);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe("timeout");
    expect(outcome.error.retryable).toBe(true);
    expect(outcome.error.message).toContain("did not start");
    expect(deleteRequests().length - before).toBe(1);
    expect(deleteRequests().at(-1)?.url).toBe("/v1/parse/stuck-job");
  });

  it("cancels the job in the service when it gives up, and sends the cancel with the token", async () => {
    service.setHandler((request, response) => {
      if (request.method === "POST") {
        json(response, 202, { jobId: "abandoned-job", status: "pending" });
        return;
      }
      if (request.method === "DELETE") {
        json(response, 200, { jobId: "abandoned-job", cancelled: true, status: "cancelled" });
        return;
      }
      json(response, 200, { jobId: "abandoned-job", status: "running" });
    });
    const before = deleteRequests().length;

    const outcome = await client({ pollIntervalMs: 5, pollTimeoutMs: 30, apiKey: "test-key" }).parseDocument(submission);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe("timeout");
    expect(deleteRequests().length - before).toBe(1);
    expect(deleteRequests().at(-1)?.url).toBe("/v1/parse/abandoned-job");
    expect(deleteRequests().at(-1)?.authorization).toBe("Bearer test-key");
  });

  it("does not disturb the outcome when the service does not know the cancel endpoint", async () => {
    service.setHandler((request, response) => {
      if (request.method === "POST") {
        json(response, 202, { jobId: "old-service-job", status: "pending" });
        return;
      }
      if (request.method === "DELETE") {
        json(response, 405, { code: "method_not_allowed", message: "use GET" });
        return;
      }
      json(response, 200, { jobId: "old-service-job", status: "running" });
    });

    const outcome = await client({ pollIntervalMs: 5, pollTimeoutMs: 30 }).parseDocument(submission);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe("timeout");
    expect(outcome.jobId).toBe("old-service-job");
  });

  it("cancels the job when polling keeps failing", async () => {
    service.setHandler((request, response) => {
      if (request.method === "POST") {
        json(response, 202, { jobId: "lost-job", status: "pending" });
        return;
      }
      json(response, 503, { code: "overloaded" });
    });
    const before = deleteRequests().length;

    const outcome = await client({ retry: oneAttempt }).parseDocument(submission);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe("unavailable");
    expect(outcome.jobId).toBe("lost-job");
    expect(deleteRequests().length - before).toBe(1);
  });

  it("cancels the job when the caller aborts the attempt", async () => {
    const controller = new AbortController();
    service.setHandler((request, response) => {
      if (request.method === "POST") {
        json(response, 202, { jobId: "aborted-job", status: "pending" });
        return;
      }
      if (request.method === "DELETE") {
        json(response, 200, { jobId: "aborted-job", cancelled: true, status: "cancelled" });
        return;
      }
      controller.abort();
      setTimeout(() => json(response, 200, { jobId: "aborted-job", status: "running" }), 50);
    });
    const before = deleteRequests().length;

    const outcome = await client({ retry: oneAttempt }).parseDocument(submission, { signal: controller.signal });

    expect(outcome.ok).toBe(false);
    expect(deleteRequests().length - before).toBe(1);
    expect(deleteRequests().at(-1)?.url).toBe("/v1/parse/aborted-job");
  });

  it("leaves a finished job alone: no cancel after a result or a permanent failure", async () => {
    const before = deleteRequests().length;
    service.setHandler((request, response) => {
      if (request.method === "POST") {
        json(response, 202, { jobId: "finished-job", status: "pending" });
        return;
      }
      json(response, 200, { jobId: "finished-job", status: "succeeded", text: "done" });
    });
    expect((await client().parseDocument(submission)).ok).toBe(true);

    service.setHandler((request, response) => {
      if (request.method === "POST") {
        json(response, 202, { jobId: "failed-job", status: "pending" });
        return;
      }
      json(response, 200, { jobId: "failed-job", status: "failed", error: { code: "encrypted_pdf", message: "locked" } });
    });
    expect((await client().parseDocument(submission)).ok).toBe(false);

    expect(deleteRequests().length - before).toBe(0);
  });

  it("cancelJob reports what the service did and never throws", async () => {
    const parser = client({ retry: oneAttempt });

    service.setHandler((_request, response) => json(response, 200, { jobId: "j", cancelled: true, status: "cancelled" }));
    expect(await parser.cancelJob("j")).toBe(true);
    expect(service.requests.at(-1)).toMatchObject({ method: "DELETE", url: "/v1/parse/j" });

    service.setHandler((_request, response) => json(response, 200, { jobId: "j", cancelled: false, status: "succeeded" }));
    expect(await parser.cancelJob("j")).toBe(false);

    service.setHandler((_request, response) => json(response, 404, { code: "job_not_found" }));
    expect(await parser.cancelJob("j")).toBe(false);

    const closed = await startMockParserService();
    const baseUrl = closed.baseUrl;
    await closed.close();
    expect(await createDocumentParserClient({ baseUrl, retry: oneAttempt }).cancelJob("j")).toBe(false);
  });

  it("takes any queueTimeoutMs that is a positive integer", () => {
    expect(() => createDocumentParserClient({ baseUrl: service.baseUrl, queueTimeoutMs: 0 })).toThrow(RangeError);
    expect(() => createDocumentParserClient({ baseUrl: service.baseUrl, queueTimeoutMs: 1_000 })).not.toThrow();
    expect(() => createDocumentParserClient({ baseUrl: service.baseUrl, parserTimeoutMs: 7_200_000 })).not.toThrow();
  });
});
