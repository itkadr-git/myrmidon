import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDocumentParserAdapterServer,
  DEFAULT_CHUNK_MAX_CHARS,
  isUnsupportedFormat,
  splitTextIntoPages,
  type DocumentParserAdapterServer,
} from "./document-parser-adapter.js";
import { createDocumentParserClient } from "./document-parser-client.js";

describe("DocumentParser HTTP adapter", () => {
  describe("splitTextIntoPages", () => {
    it("handles empty or small text", () => {
      expect(splitTextIntoPages("")).toEqual([{ pageNumber: 1, text: "" }]);
      expect(splitTextIntoPages("hello world", 1500)).toEqual([
        { pageNumber: 1, text: "hello world" },
      ]);
    });

    it("splits long text into chunks <= 1500 characters", () => {
      // 4500 chars of text across paragraphs
      const paragraphs = Array.from({ length: 15 }, (_, i) => `Paragraph ${i + 1}: ${"word ".repeat(60)}`).join("\n\n");
      expect(paragraphs.length).toBeGreaterThan(3000);

      const pages = splitTextIntoPages(paragraphs, 1500);
      expect(pages.length).toBeGreaterThan(1);
      for (const page of pages) {
        expect(page.text.length).toBeLessThanOrEqual(1500);
        expect(page.pageNumber).toBeGreaterThan(0);
      }
      // Sequential page numbers starting at 1
      expect(pages.map((p) => p.pageNumber)).toEqual(
        Array.from({ length: pages.length }, (_, i) => i + 1),
      );
    });

    it("splits long unbroken strings without separators", () => {
      const longUnbroken = "A".repeat(3500);
      const pages = splitTextIntoPages(longUnbroken, 1500);
      expect(pages.length).toBe(3);
      expect(pages[0].text.length).toBe(1500);
      expect(pages[1].text.length).toBe(1500);
      expect(pages[2].text.length).toBe(500);
      expect(pages[0].pageNumber).toBe(1);
      expect(pages[1].pageNumber).toBe(2);
      expect(pages[2].pageNumber).toBe(3);
    });
  });

  describe("isUnsupportedFormat", () => {
    it("detects EPUB and FB2 extensions and mimeTypes", () => {
      expect(isUnsupportedFormat("book.epub")).toBe(true);
      expect(isUnsupportedFormat("book.EPUB")).toBe(true);
      expect(isUnsupportedFormat("book.fb2")).toBe(true);
      expect(isUnsupportedFormat("book.fb2.zip")).toBe(true);
      expect(isUnsupportedFormat("book.pdf", "application/epub+zip")).toBe(true);
      expect(isUnsupportedFormat("doc.bin", "application/x-fictionbook+xml")).toBe(true);
      expect(isUnsupportedFormat("doc.bin", "application/x-fictionbook")).toBe(true);
      expect(isUnsupportedFormat("doc.bin", "application/fb2+xml")).toBe(true);
    });

    it("allows supported formats like PDF, DOCX, TXT, MD", () => {
      expect(isUnsupportedFormat("manual.pdf", "application/pdf")).toBe(false);
      expect(isUnsupportedFormat("report.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe(false);
      expect(isUnsupportedFormat("notes.txt", "text/plain")).toBe(false);
      expect(isUnsupportedFormat("readme.md", "text/markdown")).toBe(false);
    });
  });

  describe("HTTP server contract and lifecycle", () => {
    let adapter: DocumentParserAdapterServer;

    beforeAll(async () => {
      adapter = await createDocumentParserAdapterServer({
        port: 0,
        host: "127.0.0.1",
        chunkMaxChars: 1500,
        mockDoclingHandler: async (sub) => {
          if (sub.fileName === "error.pdf") {
            throw new Error("Docling conversion crashed");
          }
          const text = sub.contentBase64
            ? Buffer.from(sub.contentBase64, "base64").toString("utf-8")
            : "default extracted text";
          return { text };
        },
      });
    });

    afterAll(async () => {
      await adapter.close();
    });

    it("responds to /health check", async () => {
      const res = await fetch(`${adapter.baseUrl}/health`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("ok");
      expect(body.service).toBe("document-parser-adapter");
    });

    it("POST /v1/parse returns contract { jobId, status, text, pages }", async () => {
      const submission = {
        submissionId: "sub-100",
        fileName: "test.txt",
        mimeType: "text/plain",
        title: "Test File",
        parserVersion: "v1",
        contentBase64: Buffer.from("Hello world from document parser adapter").toString("base64"),
      };

      const res = await fetch(`${adapter.baseUrl}/v1/parse`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(submission),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.jobId).toBeDefined();
      expect(data.status).toBe("succeeded");
      expect(data.text).toContain("Hello world from document parser adapter");
      expect(data.pages).toEqual([
        { pageNumber: 1, text: "Hello world from document parser adapter" },
      ]);
    });

    it("GET /v1/parse/:jobId returns current job state", async () => {
      const submission = {
        submissionId: "sub-101",
        fileName: "test2.txt",
        contentBase64: Buffer.from("Job polling test content").toString("base64"),
      };

      const postRes = await fetch(`${adapter.baseUrl}/v1/parse`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(submission),
      });
      const postData = await postRes.json();

      const getRes = await fetch(`${adapter.baseUrl}/v1/parse/${postData.jobId}`);
      expect(getRes.status).toBe(200);
      const getData = await getRes.json();
      expect(getData.jobId).toBe(postData.jobId);
      expect(getData.status).toBe("succeeded");
      expect(getData.text).toBe("Job polling test content");
    });

    it("GET /v1/parse/:jobId returns 404 for unknown jobs", async () => {
      const res = await fetch(`${adapter.baseUrl}/v1/parse/non-existent-job-999`);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error.code).toBe("job_not_found");
    });

    it("retry-safe idempotency: returns same jobId for same submissionId", async () => {
      const subId = "retry-submission-uuid-12345";
      const payload = {
        submissionId: subId,
        fileName: "idempotent.txt",
        contentBase64: Buffer.from("Idempotency test").toString("base64"),
      };

      const res1 = await fetch(`${adapter.baseUrl}/v1/parse`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data1 = await res1.json();

      const res2 = await fetch(`${adapter.baseUrl}/v1/parse`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data2 = await res2.json();

      expect(data1.jobId).toBe(data2.jobId);
      expect(data2.status).toBe("succeeded");
    });

    it("fails cleanly when docling conversion throws error", async () => {
      const res = await fetch(`${adapter.baseUrl}/v1/parse`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          submissionId: "sub-error",
          fileName: "error.pdf",
          mimeType: "application/pdf",
          contentBase64: Buffer.from("bad binary").toString("base64"),
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe("failed");
      expect(data.error.code).toBe("conversion_failed");
      expect(data.error.message).toContain("Docling conversion crashed");
    });

    it("unsupported EPUB format returns failed job with unsupported_format code", async () => {
      const res = await fetch(`${adapter.baseUrl}/v1/parse`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          submissionId: "epub-sub-1",
          fileName: "war-and-peace.epub",
          mimeType: "application/epub+zip",
          contentBase64: Buffer.from("dummy-epub-bytes").toString("base64"),
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe("failed");
      expect(data.error.code).toBe("unsupported_format");
      expect(data.error.message).toContain("EPUB and FB2 formats are not supported");

      // Verify GET also returns the failed job
      const getRes = await fetch(`${adapter.baseUrl}/v1/parse/${data.jobId}`);
      expect(getRes.status).toBe(200);
      const getData = await getRes.json();
      expect(getData.status).toBe("failed");
      expect(getData.error.code).toBe("unsupported_format");
    });

    it("unsupported FB2 format returns failed job with unsupported_format code", async () => {
      const res = await fetch(`${adapter.baseUrl}/v1/parse`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          submissionId: "fb2-sub-1",
          fileName: "story.fb2",
          mimeType: "application/x-fictionbook+xml",
          contentBase64: Buffer.from("<FictionBook></FictionBook>").toString("base64"),
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe("failed");
      expect(data.error.code).toBe("unsupported_format");
    });

    it("works with createDocumentParserClient end-to-end", async () => {
      const client = createDocumentParserClient({
        baseUrl: adapter.baseUrl,
        pollIntervalMs: 10,
        pollTimeoutMs: 2000,
      });

      const result = await client.parseDocument({
        fileName: "integration-doc.txt",
        mimeType: "text/plain",
        content: new TextEncoder().encode("Testing createDocumentParserClient integration with adapter"),
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.job.status).toBe("succeeded");
        expect(result.job.text).toContain("Testing createDocumentParserClient integration");
        expect(result.job.pages).toHaveLength(1);
      }
    });
  });

  describe("payload limit enforcement", () => {
    let smallLimitAdapter: DocumentParserAdapterServer;

    beforeAll(async () => {
      smallLimitAdapter = await createDocumentParserAdapterServer({
        port: 0,
        host: "127.0.0.1",
        maxBodyBytes: 1024, // 1 KB limit for testing 413
      });
    });

    afterAll(async () => {
      await smallLimitAdapter.close();
    });

    it("rejects payloads exceeding maxBodyBytes with HTTP 413", async () => {
      const largePayload = {
        submissionId: "too-big",
        fileName: "big.txt",
        contentBase64: Buffer.from("X".repeat(2048)).toString("base64"),
      };

      const res = await fetch(`${smallLimitAdapter.baseUrl}/v1/parse`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(largePayload),
      });

      expect(res.status).toBe(413);
      const body = await res.json();
      expect(body.error.code).toBe("payload_too_large");
    });
  });
});
