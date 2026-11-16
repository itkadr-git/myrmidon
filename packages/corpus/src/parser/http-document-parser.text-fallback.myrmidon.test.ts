import { describe, expect, it, vi } from "vitest";

import type { DocumentParseRequest } from "../ports.js";
import { DocumentParserError } from "./errors.js";
import { createHttpDocumentParser } from "./http-document-parser.js";

const request: DocumentParseRequest = {
  sourceUri: null,
  content: new Uint8Array([37, 80, 68, 70]),
  contentType: "application/pdf",
  title: "contract.pdf",
  parserVersion: "parse-v1",
};

describe("HTTP document parser text fallback", () => {
  it("returns one block with the original text and request version when pages are absent", async () => {
    const text = "First line\n\n  Second line  \n";
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ jobId: "text-job", status: "succeeded", text }),
    );
    const parser = createHttpDocumentParser({ baseUrl: "https://parser.example.test", fetchImpl });

    const result = await parser.parse(request);

    expect(result).toEqual({
      chunks: [{ chunkIndex: 0, content: text, tokenCount: null, metadata: {} }],
      metadata: { jobId: "text-job", parserVersion: "parse-v1", pageCount: 0 },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://parser.example.test/v1/parse");
    expect(options?.method).toBe("POST");
    expect(JSON.parse(String(options?.body))).toEqual({
      submissionId: expect.any(String),
      fileName: "contract.pdf",
      mimeType: "application/pdf",
      title: "contract.pdf",
      parserVersion: "parse-v1",
      contentBase64: Buffer.from(request.content ?? []).toString("base64"),
    });
  });

  it("throws the failed job error instead of returning its text as a block", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ jobId: "failed-job", status: "failed", text: "must not be returned", error: { code: "encrypted", message: "pdf is encrypted" } }),
    );
    const parser = createHttpDocumentParser({ baseUrl: "https://parser.example.test", fetchImpl });

    const error = await parser.parse(request).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(DocumentParserError);
    expect(error).toMatchObject({ kind: "parse-failed", code: "encrypted", message: "pdf is encrypted", retryable: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects a request without a source before calling the service", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const parser = createHttpDocumentParser({ baseUrl: "https://parser.example.test", fetchImpl });

    const error = await parser.parse({ ...request, content: null }).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(DocumentParserError);
    expect(error).toMatchObject({ kind: "rejected", message: "a parse request needs either the document bytes or a source URI", retryable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
