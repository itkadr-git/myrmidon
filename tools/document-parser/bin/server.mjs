#!/usr/bin/env node

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const PORT = parseInt(process.env.PORT || "5001", 10);
const HOST = process.env.HOST || "0.0.0.0";
const DOCLING_SERVE_URL = process.env.DOCLING_SERVE_URL || "http://127.0.0.1:5002";
const MAX_BODY_BYTES = parseInt(process.env.MAX_BODY_BYTES || "157286400", 10); // 150 MiB
const MAX_FILE_BYTES = parseInt(process.env.MAX_FILE_BYTES || "115343360", 10); // 110 MiB
const CHUNK_MAX_CHARS = parseInt(process.env.CHUNK_MAX_CHARS || "1500", 10);

function isUnsupportedFormat(fileName, mimeType) {
  const lowerName = (fileName || "").toLowerCase().trim();
  const lowerMime = (mimeType || "").toLowerCase().trim();

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

function splitTextIntoPages(text, maxChars = CHUNK_MAX_CHARS) {
  if (!text || text.length === 0) {
    return [{ pageNumber: 1, text: "" }];
  }

  if (text.length <= maxChars) {
    return [{ pageNumber: 1, text }];
  }

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxChars) {
      chunks.push(remaining);
      break;
    }

    let splitIdx = -1;
    const pIdx = remaining.lastIndexOf("\n\n", maxChars);
    if (pIdx > 0 && pIdx >= Math.floor(maxChars * 0.3)) {
      splitIdx = pIdx + 2;
    } else {
      const nIdx = remaining.lastIndexOf("\n", maxChars);
      if (nIdx > 0 && nIdx >= Math.floor(maxChars * 0.3)) {
        splitIdx = nIdx + 1;
      } else {
        const sIdx = Math.max(
          remaining.lastIndexOf(". ", maxChars),
          remaining.lastIndexOf("? ", maxChars),
          remaining.lastIndexOf("! ", maxChars),
        );
        if (sIdx > 0 && sIdx >= Math.floor(maxChars * 0.3)) {
          splitIdx = sIdx + 2;
        } else {
          const spaceIdx = remaining.lastIndexOf(" ", maxChars);
          if (spaceIdx > 0 && spaceIdx >= Math.floor(maxChars * 0.3)) {
            splitIdx = spaceIdx + 1;
          } else {
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

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

const jobs = new Map();
const submissionMap = new Map();

async function convertViaDocling(submission) {
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

  const res = await fetch(`${DOCLING_SERVE_URL.replace(/\/+$/, "")}/v1/convert/source`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Docling-serve conversion failed (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const doc = data.document;
  const text = doc?.text_content || doc?.md_content || "";
  return { text };
}

async function processJob(job, submission) {
  try {
    job.status = "running";
    let extractedText = "";

    const isPlainText =
      submission.mimeType?.startsWith("text/") ||
      submission.fileName?.endsWith(".txt") ||
      submission.fileName?.endsWith(".md") ||
      submission.fileName?.endsWith(".json");

    try {
      const result = await convertViaDocling(submission);
      extractedText = result.text;
    } catch (err) {
      if (isPlainText && submission.contentBase64) {
        extractedText = Buffer.from(submission.contentBase64, "base64").toString("utf-8");
      } else {
        throw err;
      }
    }

    const pages = splitTextIntoPages(extractedText, CHUNK_MAX_CHARS);
    job.status = "succeeded";
    job.text = extractedText;
    job.pages = pages;
  } catch (err) {
    job.status = "failed";
    job.error = {
      code: "conversion_failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

const server = createServer(async (req, res) => {
  try {
    const method = req.method ?? "GET";
    const parsedUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = parsedUrl.pathname;

    if (pathname === "/health" || pathname === "/") {
      sendJson(res, 200, {
        status: "ok",
        service: "document-parser-adapter",
        doclingServeUrl: DOCLING_SERVE_URL,
        maxBodyBytes: MAX_BODY_BYTES,
        chunkMaxChars: CHUNK_MAX_CHARS,
      });
      return;
    }

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

    if (method === "POST" && pathname === "/v1/parse") {
      const contentLengthHeader = req.headers["content-length"];
      if (contentLengthHeader) {
        const declaredLength = parseInt(contentLengthHeader, 10);
        if (declaredLength > MAX_BODY_BYTES) {
          sendJson(res, 413, {
            error: {
              code: "payload_too_large",
              message: `Request payload exceeds maximum allowed size of ${MAX_BODY_BYTES} bytes`,
            },
          });
          return;
        }
      }

      const chunks = [];
      let totalReceived = 0;
      let payloadTooLarge = false;

      for await (const chunk of req) {
        totalReceived += chunk.length;
        if (totalReceived > MAX_BODY_BYTES) {
          payloadTooLarge = true;
          break;
        }
        chunks.push(chunk);
      }

      if (payloadTooLarge) {
        sendJson(res, 413, {
          error: {
            code: "payload_too_large",
            message: `Request payload exceeds maximum allowed size of ${MAX_BODY_BYTES} bytes`,
          },
        });
        return;
      }

      const rawBody = Buffer.concat(chunks).toString("utf-8");
      let submission;
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

      if (!submission.contentBase64 && !submission.sourceUri) {
        sendJson(res, 400, {
          error: {
            code: "invalid_submission",
            message: "Either contentBase64 or sourceUri must be provided",
          },
        });
        return;
      }

      if (submission.contentBase64) {
        const approxDecodedSize = Math.floor((submission.contentBase64.length * 3) / 4);
        if (approxDecodedSize > MAX_FILE_BYTES) {
          sendJson(res, 413, {
            error: {
              code: "file_too_large",
              message: `Decoded file size exceeds maximum limit of ${MAX_FILE_BYTES} bytes (110 MiB)`,
            },
          });
          return;
        }
      }

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

      if (isUnsupportedFormat(submission.fileName, submission.mimeType)) {
        const failedJob = {
          jobId,
          submissionId: submission.submissionId,
          status: "failed",
          error: {
            code: "unsupported_format",
            message: `EPUB and FB2 formats are not supported by the document parser (detected fileName=${submission.fileName || "unknown"}, mimeType=${submission.mimeType || "unknown"})`,
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

      const job = {
        jobId,
        submissionId: submission.submissionId,
        status: "pending",
        createdAt: Date.now(),
      };
      jobs.set(jobId, job);
      if (submission.submissionId) {
        submissionMap.set(submission.submissionId, jobId);
      }

      processJob(job, submission);

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
  } catch (err) {
    sendJson(res, 500, {
      error: {
        code: "internal_error",
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`DocumentParser adapter listening on http://${HOST}:${PORT}`);
  console.log(`Docling-serve URL: ${DOCLING_SERVE_URL}`);
  console.log(`Max body size: ${MAX_BODY_BYTES} bytes, chunk limit: ${CHUNK_MAX_CHARS} chars`);
});
