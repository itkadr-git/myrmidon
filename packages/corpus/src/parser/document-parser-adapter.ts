import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

export interface DocumentParseSubmissionPayload {
  submissionId?: string;
  companyId?: string;
  datasetId?: string;
  documentId?: string;
  fileName?: string;
  mimeType?: string;
  title?: string;
  parserVersion?: string;
  contentBase64?: string;
  sourceUri?: string;
}

export interface DocumentParserAdapterJob {
  jobId: string;
  submissionId?: string;
  status: "pending" | "running" | "succeeded" | "failed";
  text?: string;
  pages?: Array<{ pageNumber: number; text: string }>;
  error?: { code: string; message: string };
  createdAt: number;
}

export interface DocumentParserAdapterOptions {
  port?: number;
  host?: string;
  doclingServeUrl?: string;
  maxBodyBytes?: number;
  chunkMaxChars?: number;
  mockDoclingHandler?: (
    submission: DocumentParseSubmissionPayload,
  ) => Promise<{ text: string; pages?: Array<{ pageNumber: number; text: string }> }>;
}

export interface DocumentParserAdapterServer {
  readonly server: Server;
  readonly baseUrl: string;
  readonly port: number;
  getJob(jobId: string): DocumentParserAdapterJob | undefined;
  close(): Promise<void>;
}

export const DEFAULT_MAX_BODY_BYTES = 150 * 1024 * 1024; // 150 MiB (supports ~110 MiB base64 + JSON overhead)
export const DEFAULT_MAX_FILE_BYTES = 110 * 1024 * 1024; // 110 MiB binary content limit
export const DEFAULT_CHUNK_MAX_CHARS = 1500;

export function isUnsupportedFormat(fileName?: string, mimeType?: string): boolean {
  const lowerName = (fileName ?? "").toLowerCase().trim();
  const lowerMime = (mimeType ?? "").toLowerCase().trim();

  if (
    lowerName.endsWith(".epub") ||
    lowerName.endsWith(".fb2") ||
    lowerName.endsWith(".fb2.zip")
  ) {
    return true;
  }

  if (
    lowerMime === "application/epub+zip" ||
    lowerMime.includes("fictionbook") ||
    lowerMime.includes("fb2")
  ) {
    return true;
  }

  return false;
}

export function splitTextIntoPages(
  text: string,
  maxChars: number = DEFAULT_CHUNK_MAX_CHARS,
): Array<{ pageNumber: number; text: string }> {
  if (!text || text.length === 0) {
    return [{ pageNumber: 1, text: "" }];
  }

  if (text.length <= maxChars) {
    return [{ pageNumber: 1, text }];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxChars) {
      chunks.push(remaining);
      break;
    }

    let splitIdx = -1;
    // Prefer paragraph boundary
    const pIdx = remaining.lastIndexOf("\n\n", maxChars);
    if (pIdx > 0 && pIdx >= Math.floor(maxChars * 0.3)) {
      splitIdx = pIdx + 2;
    } else {
      // Then single newline
      const nIdx = remaining.lastIndexOf("\n", maxChars);
      if (nIdx > 0 && nIdx >= Math.floor(maxChars * 0.3)) {
        splitIdx = nIdx + 1;
      } else {
        // Then sentence end
        const sIdx = Math.max(
          remaining.lastIndexOf(". ", maxChars),
          remaining.lastIndexOf("? ", maxChars),
          remaining.lastIndexOf("! ", maxChars),
        );
        if (sIdx > 0 && sIdx >= Math.floor(maxChars * 0.3)) {
          splitIdx = sIdx + 2;
        } else {
          // Then space
          const spaceIdx = remaining.lastIndexOf(" ", maxChars);
          if (spaceIdx > 0 && spaceIdx >= Math.floor(maxChars * 0.3)) {
            splitIdx = spaceIdx + 1;
          } else {
            // Hard cut
            splitIdx = maxChars;
          }
        }
      }
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx);
  }

  return chunks.map((chunk, index) => ({
    pageNumber: index + 1,
    text: chunk,
  }));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

export async function createDocumentParserAdapterServer(
  options: DocumentParserAdapterOptions = {},
): Promise<DocumentParserAdapterServer> {
  const maxBodyBytes =
    options.maxBodyBytes ??
    (process.env.MAX_BODY_BYTES ? parseInt(process.env.MAX_BODY_BYTES, 10) : DEFAULT_MAX_BODY_BYTES);
  const chunkMaxChars =
    options.chunkMaxChars ??
    (process.env.CHUNK_MAX_CHARS ? parseInt(process.env.CHUNK_MAX_CHARS, 10) : DEFAULT_CHUNK_MAX_CHARS);
  const doclingServeUrl =
    options.doclingServeUrl ?? process.env.DOCLING_SERVE_URL ?? "http://127.0.0.1:5002";

  const jobs = new Map<string, DocumentParserAdapterJob>();
  const submissionMap = new Map<string, string>();

  async function convertViaDocling(
    submission: DocumentParseSubmissionPayload,
  ): Promise<{ text: string; pages?: Array<{ pageNumber: number; text: string }> }> {
    if (options.mockDoclingHandler) {
      return options.mockDoclingHandler(submission);
    }

    if (!submission.contentBase64 && !submission.sourceUri) {
      throw new Error("No document content or sourceUri provided");
    }

    const payload = {
      file_sources: submission.contentBase64
        ? [
            {
              base64_string: submission.contentBase64,
              filename: submission.fileName || "document.bin",
            },
          ]
        : undefined,
      http_sources: submission.sourceUri ? [{ url: submission.sourceUri }] : undefined,
      options: {
        to_formats: ["md", "text"],
      },
    };

    const res = await fetch(`${doclingServeUrl.replace(/\/+$/, "")}/v1/convert/source`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Docling-serve conversion failed (${res.status}): ${errText}`);
    }

    const data = (await res.json()) as {
      document?: {
        text_content?: string;
        md_content?: string;
        pages?: Array<{ page_no?: number; text?: string }>;
      };
    };

    const doc = data.document;
    const text = doc?.text_content || doc?.md_content || "";
    return { text };
  }

  async function processJob(
    job: DocumentParserAdapterJob,
    submission: DocumentParseSubmissionPayload,
  ): Promise<void> {
    try {
      job.status = "running";

      let extractedText = "";

      // Check text fallback if mimeType is text or docling conversion
      const isPlainText =
        submission.mimeType?.startsWith("text/") ||
        submission.fileName?.endsWith(".txt") ||
        submission.fileName?.endsWith(".md") ||
        submission.fileName?.endsWith(".json");

      try {
        const result = await convertViaDocling(submission);
        extractedText = result.text;
      } catch (err: unknown) {
        if (isPlainText && submission.contentBase64) {
          extractedText = Buffer.from(submission.contentBase64, "base64").toString("utf-8");
        } else {
          throw err;
        }
      }

      const pages = splitTextIntoPages(extractedText, chunkMaxChars);
      job.status = "succeeded";
      job.text = extractedText;
      job.pages = pages;
    } catch (err: unknown) {
      job.status = "failed";
      job.error = {
        code: "conversion_failed",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const method = req.method ?? "GET";
      const parsedUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      const pathname = parsedUrl.pathname;

      // Health probe
      if (pathname === "/health" || pathname === "/") {
        sendJson(res, 200, {
          status: "ok",
          service: "document-parser-adapter",
          doclingServeUrl,
          maxBodyBytes,
          chunkMaxChars,
        });
        return;
      }

      // GET /v1/parse/:jobId
      if (method === "GET" && pathname.startsWith("/v1/parse/")) {
        const jobId = decodeURIComponent(pathname.slice("/v1/parse/".length));
        const job = jobs.get(jobId);
        if (!job) {
          sendJson(res, 404, {
            error: {
              code: "job_not_found",
              message: `Job ${jobId} not found`,
            },
          });
          return;
        }

        sendJson(res, 200, {
          jobId: job.jobId,
          status: job.status,
          text: job.text,
          pages: job.pages,
          error: job.error,
        });
        return;
      }

      // POST /v1/parse
      if (method === "POST" && pathname === "/v1/parse") {
        // Enforce Content-Length if present
        const contentLengthHeader = req.headers["content-length"];
        if (contentLengthHeader) {
          const declaredLength = parseInt(contentLengthHeader, 10);
          if (declaredLength > maxBodyBytes) {
            sendJson(res, 413, {
              error: {
                code: "payload_too_large",
                message: `Request payload exceeds maximum allowed size of ${maxBodyBytes} bytes`,
              },
            });
            return;
          }
        }

        // Stream body with strict byte limit
        const chunks: Buffer[] = [];
        let totalReceived = 0;
        let payloadTooLarge = false;

        for await (const chunk of req) {
          totalReceived += chunk.length;
          if (totalReceived > maxBodyBytes) {
            payloadTooLarge = true;
            break;
          }
          chunks.push(chunk);
        }

        if (payloadTooLarge) {
          sendJson(res, 413, {
            error: {
              code: "payload_too_large",
              message: `Request payload exceeds maximum allowed size of ${maxBodyBytes} bytes`,
            },
          });
          return;
        }

        const rawBody = Buffer.concat(chunks).toString("utf-8");
        let submission: DocumentParseSubmissionPayload;
        try {
          submission = JSON.parse(rawBody);
        } catch {
          sendJson(res, 400, {
            error: {
              code: "invalid_json",
              message: "Request body is not valid JSON",
            },
          });
          return;
        }

        // Validate submission
        if (!submission.contentBase64 && !submission.sourceUri) {
          sendJson(res, 400, {
            error: {
              code: "invalid_submission",
              message: "Either contentBase64 or sourceUri must be provided",
            },
          });
          return;
        }

        // Check if contentBase64 decodes to more than 110 MiB
        if (submission.contentBase64) {
          // Approx decoded size = length * 3 / 4
          const approxDecodedSize = Math.floor((submission.contentBase64.length * 3) / 4);
          if (approxDecodedSize > DEFAULT_MAX_FILE_BYTES) {
            sendJson(res, 413, {
              error: {
                code: "file_too_large",
                message: `Decoded file size exceeds maximum limit of ${DEFAULT_MAX_FILE_BYTES} bytes (110 MiB)`,
              },
            });
            return;
          }
        }

        // Idempotency: check submissionId
        if (submission.submissionId) {
          const existingJobId = submissionMap.get(submission.submissionId);
          if (existingJobId) {
            const existingJob = jobs.get(existingJobId);
            if (existingJob) {
              sendJson(res, 200, {
                jobId: existingJob.jobId,
                status: existingJob.status,
                text: existingJob.text,
                pages: existingJob.pages,
                error: existingJob.error,
              });
              return;
            }
          }
        }

        const jobId = randomUUID();

        // Check unsupported formats: EPUB / FB2
        if (isUnsupportedFormat(submission.fileName, submission.mimeType)) {
          const failedJob: DocumentParserAdapterJob = {
            jobId,
            submissionId: submission.submissionId,
            status: "failed",
            error: {
              code: "unsupported_format",
              message: `EPUB and FB2 formats are not supported by the document parser (detected fileName=${submission.fileName ?? "unknown"}, mimeType=${submission.mimeType ?? "unknown"})`,
            },
            createdAt: Date.now(),
          };
          jobs.set(jobId, failedJob);
          if (submission.submissionId) {
            submissionMap.set(submission.submissionId, jobId);
          }

          sendJson(res, 200, {
            jobId: failedJob.jobId,
            status: failedJob.status,
            error: failedJob.error,
          });
          return;
        }

        const job: DocumentParserAdapterJob = {
          jobId,
          submissionId: submission.submissionId,
          status: "pending",
          createdAt: Date.now(),
        };
        jobs.set(jobId, job);
        if (submission.submissionId) {
          submissionMap.set(submission.submissionId, jobId);
        }

        // Trigger processing
        const processingPromise = processJob(job, submission);

        // If mock handler or synchronous, await briefly or return pending
        if (options.mockDoclingHandler) {
          await processingPromise;
          sendJson(res, 200, {
            jobId: job.jobId,
            status: job.status,
            text: job.text,
            pages: job.pages,
            error: job.error,
          });
          return;
        }

        // For real requests: respond 202 Accepted with pending/running status
        sendJson(res, 202, {
          jobId: job.jobId,
          status: job.status,
        });
        return;
      }

      sendJson(res, 404, {
        error: {
          code: "not_found",
          message: `Cannot ${method} ${pathname}`,
        },
      });
    } catch (err: unknown) {
      sendJson(res, 500, {
        error: {
          code: "internal_error",
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  });

  const host = options.host ?? "0.0.0.0";
  const requestedPort = options.port ?? 0;

  await new Promise<void>((resolve) => {
    server.listen(requestedPort, host, resolve);
  });

  const address = server.address() as AddressInfo;
  const boundPort = address.port;
  const baseUrl = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${boundPort}`;

  return {
    server,
    baseUrl,
    port: boundPort,
    getJob: (jobId: string) => jobs.get(jobId),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
