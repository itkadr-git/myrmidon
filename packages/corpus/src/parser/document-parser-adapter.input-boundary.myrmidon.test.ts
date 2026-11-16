import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDocumentParserAdapterServer,
  DEFAULT_MAX_FILE_BYTES,
  type DocumentParserAdapterServer,
} from "./document-parser-adapter.js";

describe("document parser HTTP input boundaries", () => {
  let adapter: DocumentParserAdapterServer | undefined;
  const convert = vi.fn(async () => ({ text: "converted" }));

  afterEach(async () => {
    await adapter?.close();
    adapter = undefined;
    convert.mockClear();
  });

  async function start(maxBodyBytes?: number) {
    adapter = await createDocumentParserAdapterServer({
      host: "127.0.0.1",
      port: 0,
      maxBodyBytes,
      mockDoclingHandler: convert,
    });
    return adapter;
  }

  async function post(server: DocumentParserAdapterServer, body: string) {
    return fetch(`${server.baseUrl}/v1/parse`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  }

  async function expectRejected(response: Response, status: number, code: string) {
    expect(response.status).toBe(status);
    const body = await response.json();
    expect(body.error.code).toBe(code);
    expect(body).not.toHaveProperty("jobId");
    expect(convert).not.toHaveBeenCalled();
  }

  async function expectFreshSubmission(server: DocumentParserAdapterServer, submissionId: string) {
    const response = await post(server, JSON.stringify({ submissionId, sourceUri: "https://example.org/document.pdf" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("succeeded");
    expect(body.jobId).toEqual(expect.any(String));
    expect(server.getJob(body.jobId)?.submissionId).toBe(submissionId);
    expect(convert).toHaveBeenCalledTimes(1);
  }

  it("rejects invalid JSON without creating a job or invoking Docling", async () => {
    const server = await start();
    await expectRejected(await post(server, '{"submissionId":"invalid-json",'), 400, "invalid_json");
    await expectFreshSubmission(server, "invalid-json");
  });

  it("rejects a submission without contentBase64 or sourceUri before creating a job", async () => {
    const server = await start();
    await expectRejected(await post(server, JSON.stringify({ submissionId: "missing-content" })), 400, "invalid_submission");
    await expectFreshSubmission(server, "missing-content");
  });

  it("rejects a declared body larger than maxBodyBytes before creating a job", async () => {
    const server = await start(256);
    await expectRejected(await post(server, JSON.stringify({ submissionId: "body-limit", sourceUri: "x".repeat(256) })), 413, "payload_too_large");
    await expectFreshSubmission(server, "body-limit");
  });

  it("rejects decoded content over the file limit before creating a job", async () => {
    const server = await start();
    const contentBase64 = Buffer.alloc(DEFAULT_MAX_FILE_BYTES + 3).toString("base64");
    await expectRejected(await post(server, JSON.stringify({ submissionId: "file-limit", contentBase64 })), 413, "file_too_large");
    await expectFreshSubmission(server, "file-limit");
  }, 60_000);
});
