// myrmidon(CORPUS-2.0): HTTP client of the document parser service.
//
// The service is a separate process that turns PDFs and scans into text. This client owns the
// HTTP details: timeouts, retries with jittered backoff, polling of a parse job, and the
// mapping of every failure onto `DocumentParserError` with a `retryable` flag. `parseDocument`
// never throws for service failures — it returns an outcome — so the corpus worker records a
// failed job and lets the queue decide about a retry instead of losing the worker.

import { randomUUID } from "node:crypto";
import {
  DEFAULT_RETRY_POLICY,
  defaultRetryContext,
  runWithRetries,
  type RetryContext,
  type RetryPolicy,
} from "../retry.js";
import { DocumentParserError, isRetryableDocumentParserError, isRetryableStatus } from "./errors.js";
import type {
  DocumentParseJob,
  DocumentParseOutcome,
  DocumentParseResult,
  DocumentParseStatus,
  DocumentParseSubmission,
} from "./types.js";

export const DEFAULT_PARSER_TIMEOUT_MS = 30_000;
export const DEFAULT_PARSER_POLL_INTERVAL_MS = 500;
export const DEFAULT_PARSER_POLL_TIMEOUT_MS = 120_000;

const SUBMIT_PATH = "/v1/parse";
const PARSE_STATUSES: readonly DocumentParseStatus[] = ["pending", "running", "succeeded", "failed"];

export interface DocumentParserClientOptions {
  /** Base URL of the parser service, without a trailing slash. Comes from the module settings. */
  readonly baseUrl: string;
  /** Bearer token sent with every request, when the service is configured with one. */
  readonly apiKey?: string;
  /** Time one HTTP request may take before it is aborted and retried. */
  readonly timeoutMs?: number;
  /** Delay between two status polls while a job is running. */
  readonly pollIntervalMs?: number;
  /** How long `parseDocument` waits for a job before it reports a retryable timeout. */
  readonly pollTimeoutMs?: number;
  readonly retry?: RetryPolicy;
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly random?: () => number;
  readonly now?: () => number;
}

export interface DocumentParserClient {
  /** Submits a document and returns the accepted job. Idempotent through `submissionId`. */
  submitDocument(submission: DocumentParseSubmission, options?: { signal?: AbortSignal }): Promise<DocumentParseJob>;
  /** Reads the current state of a job. */
  fetchJob(jobId: string, options?: { signal?: AbortSignal }): Promise<DocumentParseJob>;
  /** Submits and polls until the job is done; reports failures instead of throwing them. */
  parseDocument(submission: DocumentParseSubmission, options?: { signal?: AbortSignal }): Promise<DocumentParseOutcome>;
}

export function createDocumentParserClient(options: DocumentParserClientOptions): DocumentParserClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  if (!/^https?:\/\//.test(baseUrl)) {
    throw new RangeError("document parser baseUrl must be an absolute http(s) URL");
  }
  const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_PARSER_TIMEOUT_MS, "timeoutMs");
  const pollIntervalMs = positiveInteger(options.pollIntervalMs ?? DEFAULT_PARSER_POLL_INTERVAL_MS, "pollIntervalMs");
  const pollTimeoutMs = positiveInteger(options.pollTimeoutMs ?? DEFAULT_PARSER_POLL_TIMEOUT_MS, "pollTimeoutMs");
  const retry = options.retry ?? DEFAULT_RETRY_POLICY;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const retryContext: RetryContext = {
    ...defaultRetryContext(),
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.random ? { random: options.random } : {}),
  };
  const now = options.now ?? (() => Date.now());

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;

  async function requestJson(
    path: string,
    init: { method: "GET" | "POST"; body?: string },
    context: { attempt: number; signal?: AbortSignal },
  ): Promise<unknown> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    if (context.signal) {
      if (context.signal.aborted) controller.abort();
      else context.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }

    try {
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}${path}`, {
          method: init.method,
          headers,
          body: init.body,
          signal: controller.signal,
        });
      } catch (error) {
        throw new DocumentParserError({
          kind: timedOut ? "timeout" : "unavailable",
          message: timedOut
            ? `document parser did not answer within ${timeoutMs} ms`
            : "document parser is not reachable",
          retryable: true,
          attempts: context.attempt,
          cause: error,
        });
      }

      const raw = await response.text();
      if (!response.ok) {
        const parsed = parseJson(raw);
        throw new DocumentParserError({
          kind: isRetryableStatus(response.status) ? "unavailable" : "rejected",
          message: `document parser answered HTTP ${response.status}`,
          status: response.status,
          code: errorCodeOf(parsed),
          retryable: isRetryableStatus(response.status),
          attempts: context.attempt,
        });
      }
      const parsed = parseJson(raw);
      if (parsed === undefined) {
        throw new DocumentParserError({
          kind: "invalid-response",
          message: "document parser answered with a body that is not JSON",
          status: response.status,
          retryable: false,
          attempts: context.attempt,
        });
      }
      return parsed;
    } finally {
      clearTimeout(timer);
    }
  }

  function submitDocument(
    submission: DocumentParseSubmission,
    submissionOptions: { signal?: AbortSignal } = {},
  ): Promise<DocumentParseJob> {
    const body = JSON.stringify({
      submissionId: submission.idempotencyKey ?? randomUUID(),
      companyId: submission.companyId,
      datasetId: submission.datasetId,
      documentId: submission.documentId,
      fileName: submission.fileName,
      mimeType: submission.mimeType,
      title: submission.title,
      parserVersion: submission.parserVersion,
      sourceUri: submission.sourceUri,
      contentBase64: submission.content ? Buffer.from(submission.content).toString("base64") : undefined,
    });
    return runWithRetries(
      retry,
      retryContext,
      async (attempt) =>
        toJob(await requestJson(SUBMIT_PATH, { method: "POST", body }, { attempt, signal: submissionOptions.signal })),
      isRetryableDocumentParserError,
    );
  }

  function fetchJob(jobId: string, jobOptions: { signal?: AbortSignal } = {}): Promise<DocumentParseJob> {
    return runWithRetries(
      retry,
      retryContext,
      async (attempt) =>
        toJob(
          await requestJson(`${SUBMIT_PATH}/${encodeURIComponent(jobId)}`, { method: "GET" }, {
            attempt,
            signal: jobOptions.signal,
          }),
        ),
      isRetryableDocumentParserError,
    );
  }

  return {
    submitDocument,
    fetchJob,

    async parseDocument(submission, parseOptions = {}): Promise<DocumentParseOutcome> {
      let jobId: string | undefined;
      try {
        let job = await submitDocument(submission, parseOptions);
        jobId = job.jobId;
        const deadline = now() + pollTimeoutMs;

        for (;;) {
          if (job.status === "succeeded") {
            return { ok: true, result: toResult(job) };
          }
          if (job.status === "failed") {
            return {
              ok: false,
              jobId: job.jobId,
              error: new DocumentParserError({
                kind: "parse-failed",
                message: job.error?.message ?? "document parser reported a failed job",
                code: job.error?.code,
                retryable: false,
              }),
            };
          }
          if (now() >= deadline) {
            return {
              ok: false,
              jobId: job.jobId,
              error: new DocumentParserError({
                kind: "timeout",
                message: `document parser job ${job.jobId} did not finish within ${pollTimeoutMs} ms`,
                retryable: true,
              }),
            };
          }
          await retryContext.sleep(pollIntervalMs);
          job = await fetchJob(job.jobId, parseOptions);
        }
      } catch (error) {
        return {
          ok: false,
          jobId,
          error:
            error instanceof DocumentParserError
              ? error
              : new DocumentParserError({
                  kind: "unavailable",
                  message: error instanceof Error ? error.message : "document parser call failed",
                  retryable: true,
                  cause: error,
                }),
        };
      }
    },
  };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`document parser ${name} must be a positive integer`);
  return value;
}

function parseJson(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function errorCodeOf(body: Record<string, unknown> | undefined): string | undefined {
  const code = body?.code;
  return typeof code === "string" ? code : undefined;
}

function toJob(body: unknown): DocumentParseJob {
  if (typeof body !== "object" || body === null) throw invalidResponse("job payload is not an object");
  const record = body as Record<string, unknown>;
  const jobId = record.jobId;
  const status = record.status;
  if (typeof jobId !== "string" || jobId.length === 0) throw invalidResponse("job payload has no jobId");
  if (typeof status !== "string" || !PARSE_STATUSES.includes(status as DocumentParseStatus)) {
    throw invalidResponse(`job payload has an unknown status: ${String(status)}`);
  }
  const job: {
    jobId: string;
    status: DocumentParseStatus;
    pages?: readonly { pageNumber: number; text: string }[];
    text?: string;
    error?: { code: string; message: string };
  } = { jobId, status: status as DocumentParseStatus };
  const pages = toPages(record.pages);
  if (pages) job.pages = pages;
  if (typeof record.text === "string") job.text = record.text;
  const error = record.error;
  if (typeof error === "object" && error !== null) {
    const record2 = error as Record<string, unknown>;
    job.error = {
      code: typeof record2.code === "string" ? record2.code : "parse_failed",
      message: typeof record2.message === "string" ? record2.message : "document parser reported a failed job",
    };
  }
  return job;
}

function toPages(value: unknown): readonly { pageNumber: number; text: string }[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) throw invalidResponse("page entry is not an object");
    const record = entry as Record<string, unknown>;
    const pageNumber = typeof record.pageNumber === "number" ? record.pageNumber : index + 1;
    const text = typeof record.text === "string" ? record.text : "";
    return { pageNumber, text };
  });
}

function toResult(job: DocumentParseJob): DocumentParseResult {
  // Reading order matters for the downstream chunker, and the service is not required to send
  // pages in order.
  const pages = [...(job.pages ?? [])].sort((left, right) => left.pageNumber - right.pageNumber);
  const text = job.text ?? pages.map((page) => page.text).join("\n\n");
  if (text.length === 0) {
    throw new DocumentParserError({
      kind: "invalid-response",
      message: `document parser job ${job.jobId} succeeded without text`,
      retryable: false,
    });
  }
  return { jobId: job.jobId, text, pages };
}

function invalidResponse(message: string): DocumentParserError {
  return new DocumentParserError({ kind: "invalid-response", message, retryable: false });
}