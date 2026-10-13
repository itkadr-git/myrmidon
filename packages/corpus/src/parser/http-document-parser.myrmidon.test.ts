import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import type { DocumentParseRequest } from "../ports.js";
import { DocumentParserError } from "./errors.js";
import { createHttpDocumentParser } from "./http-document-parser.js";

interface MockService {
  readonly baseUrl: string;
  readonly requests: { readonly method: string; readonly url: string; readonly body: Record<string, unknown> }[];
  close(): Promise<void>;
}

function json(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

async function startService(
  handler: (request: { method: string; url: string; body: Record<string, unknown> }, response: ServerResponse, call: number) => void,
): Promise<MockService> {
  const requests: MockService["requests"] = [];
  let call = 0;
  const server: Server = createServer((incoming: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(raw.length > 0 ? raw : "{}");
        if (typeof parsed === "object" && parsed !== null) body = parsed as Record<string, unknown>;
      } catch {
        body = {};
      }
      const request = { method: incoming.method ?? "", url: incoming.url ?? "", body };
      requests.push(request);
      call += 1;
      handler(request, response, call);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function parser(service: MockService) {
  return createHttpDocumentParser({
    baseUrl: service.baseUrl,
    retry: { attempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
    pollIntervalMs: 1,
    pollTimeoutMs: 50,
    sleep: async () => {},
  });
}

const bytesRequest: DocumentParseRequest = {
  sourceUri: null,
  content: new Uint8Array([37, 80, 68, 70]),
  contentType: "application/pdf",
  title: "contract.pdf",
  parserVersion: "parse-v1",
};

async function failureOf(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("the DocumentParser port adapter", () => {
  it("sends the bytes, then answers with one parsed block per page in reading order", async () => {
    const service = await startService((_request, response) => {
      json(response, 200, {
        jobId: "job-1",
        status: "succeeded",
        pages: [
          { pageNumber: 2, text: "second page" },
          { pageNumber: 1, text: "first page" },
        ],
      });
    });
    try {
      const result = await parser(service).parse(bytesRequest);

      expect(service.requests).toHaveLength(1);
      expect(service.requests[0].method).toBe("POST");
      expect(service.requests[0].body.contentBase64).toBe(Buffer.from(bytesRequest.content ?? []).toString("base64"));
      expect(service.requests[0].body.sourceUri).toBeUndefined();
      expect(service.requests[0].body.title).toBe("contract.pdf");
      expect(service.requests[0].body.parserVersion).toBe("parse-v1");
      expect(result.chunks).toEqual([
        { chunkIndex: 0, content: "first page", tokenCount: null, metadata: { pageNumber: 1 } },
        { chunkIndex: 1, content: "second page", tokenCount: null, metadata: { pageNumber: 2 } },
      ]);
      expect(result.metadata).toEqual({ jobId: "job-1", parserVersion: "parse-v1", pageCount: 2 });
    } finally {
      await service.close();
    }
  });

  it("hands a fetchable URL to the service when there are no bytes", async () => {
    const service = await startService((_request, response) => {
      json(response, 200, { jobId: "job-2", status: "succeeded", text: "the whole document" });
    });
    try {
      const result = await parser(service).parse({
        sourceUri: "https://blobs.example.test/abc/contract.pdf?token=1",
        content: null,
        contentType: null,
        title: "contract",
        parserVersion: "parse-v1",
      });

      expect(service.requests[0].body.sourceUri).toBe("https://blobs.example.test/abc/contract.pdf?token=1");
      expect(service.requests[0].body.contentBase64).toBeUndefined();
      expect(service.requests[0].body.fileName).toBe("contract.pdf");
      expect(service.requests[0].body.mimeType).toBe("application/octet-stream");
      expect(result.chunks).toEqual([{ chunkIndex: 0, content: "the whole document", tokenCount: null, metadata: {} }]);
    } finally {
      await service.close();
    }
  });

  it("retries a 5xx answer and still returns the chunks", async () => {
    const service = await startService((_request, response, call) => {
      if (call === 1) json(response, 503, { code: "busy" });
      else json(response, 200, { jobId: "job-3", status: "succeeded", pages: [{ pageNumber: 1, text: "page" }] });
    });
    try {
      const result = await parser(service).parse(bytesRequest);
      expect(service.requests).toHaveLength(2);
      expect(result.chunks).toHaveLength(1);
    } finally {
      await service.close();
    }
  });

  it("rejects a refused request with an error the worker must not retry", async () => {
    const service = await startService((_request, response) => json(response, 400, { code: "bad_pdf" }));
    try {
      const error = await failureOf(() => parser(service).parse(bytesRequest));
      expect(error instanceof DocumentParserError).toBe(true);
      expect((error as DocumentParserError).kind).toBe("rejected");
      expect((error as DocumentParserError).retryable).toBe(false);
      expect(service.requests).toHaveLength(1);
    } finally {
      await service.close();
    }
  });

  it("reports an unreachable service as a retryable failure instead of throwing something raw", async () => {
    const service = await startService((_request, response) => json(response, 200, { jobId: "x", status: "succeeded" }));
    const baseUrl = service.baseUrl;
    await service.close();

    const error = await failureOf(() => createHttpDocumentParser({ baseUrl, retry: { attempts: 1, baseDelayMs: 1, maxDelayMs: 2 } }).parse(bytesRequest));
    expect(error instanceof DocumentParserError).toBe(true);
    expect((error as DocumentParserError).retryable).toBe(true);
  });

  it("rejects a failed job and a request without a source", async () => {
    const failing = await startService((_request, response) =>
      json(response, 200, { jobId: "job-4", status: "failed", error: { code: "encrypted", message: "pdf is encrypted" } }),
    );
    try {
      const error = await failureOf(() => parser(failing).parse(bytesRequest));
      expect((error as DocumentParserError).kind).toBe("parse-failed");
      expect((error as DocumentParserError).retryable).toBe(false);
    } finally {
      await failing.close();
    }

    const quiet = await startService((_request, response) => json(response, 500, { code: "no_handler" }));
    try {
      const error = await failureOf(() =>
        parser(quiet).parse({ sourceUri: null, content: null, contentType: null, title: "nothing", parserVersion: "parse-v1" }),
      );
      expect((error as DocumentParserError).kind).toBe("rejected");
      expect(quiet.requests).toHaveLength(0);
    } finally {
      await quiet.close();
    }
  });
});