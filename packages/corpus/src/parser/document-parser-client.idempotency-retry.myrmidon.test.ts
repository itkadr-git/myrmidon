import { describe, expect, it } from "vitest";
import { createDocumentParserClient } from "./document-parser-client.js";
import type { DocumentParseSubmission } from "./types.js";

const submission: DocumentParseSubmission = {
  companyId: "company-1", datasetId: "dataset-1", documentId: "document-1",
  fileName: "test.pdf", mimeType: "application/pdf", content: new Uint8Array([1, 2, 3]),
};
const retry = { attempts: 3, baseDelayMs: 1, maxDelayMs: 2 };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const client = (fetchImpl: typeof fetch) => createDocumentParserClient({
  baseUrl: "http://parser.test", fetchImpl, retry, sleep: async () => {}, random: () => 0,
});

describe("parser submission identity across retries", () => {
  it("reuses the exact POST body and identity after two retryable failures", async () => {
    const bodies: string[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      expect(init?.method).toBe("POST");
      bodies.push(String(init?.body));
      return bodies.length < 3 ? json({ code: "overloaded" }, 503) : json({ jobId: "job-1", status: "pending" }, 202);
    };
    const result = await client(fetchImpl).submitDocument(submission);
    expect(result).toEqual({ jobId: "job-1", status: "pending" });
    expect(bodies).toHaveLength(3);
    expect(bodies[1]).toBe(bodies[0]);
    expect(bodies[2]).toBe(bodies[0]);
    const body = JSON.parse(bodies[0]);
    expect(body).toEqual({ submissionId: expect.any(String), companyId: "company-1", datasetId: "dataset-1", documentId: "document-1", fileName: "test.pdf", mimeType: "application/pdf", contentBase64: "AQID" });
    expect(body.submissionId.length).toBeGreaterThan(0);
  });

  it("generates a distinct nonempty id per call and preserves an explicit key", async () => {
    const bodies: string[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      expect(init?.method).toBe("POST");
      bodies.push(String(init?.body));
      return json({ jobId: `job-${bodies.length}`, status: "pending" }, 202);
    };
    const parser = client(fetchImpl);
    expect(await parser.submitDocument(submission)).toEqual({ jobId: "job-1", status: "pending" });
    expect(await parser.submitDocument(submission)).toEqual({ jobId: "job-2", status: "pending" });
    expect(await parser.submitDocument({ ...submission, idempotencyKey: "explicit-key" })).toEqual({ jobId: "job-3", status: "pending" });
    expect(bodies).toHaveLength(3);
    const parsed = bodies.map((body) => JSON.parse(body));
    for (const body of parsed) expect(body).toEqual({ submissionId: expect.any(String), companyId: "company-1", datasetId: "dataset-1", documentId: "document-1", fileName: "test.pdf", mimeType: "application/pdf", contentBase64: "AQID" });
    expect(parsed[0].submissionId.length).toBeGreaterThan(0);
    expect(parsed[1].submissionId.length).toBeGreaterThan(0);
    expect(parsed[0].submissionId).not.toBe(parsed[1].submissionId);
    expect(parsed[2].submissionId).toBe("explicit-key");
  });

  it("isolates identities on concurrent polling failures and cancellation", async () => {
    const requests: { method: string; url: string; body: string; id: string | null }[] = [];
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    let polls = 0;
    const fetchImpl: typeof fetch = async (url, init) => {
      const method = init?.method ?? "GET";
      const body = String(init?.body ?? "");
      const path = new URL(String(url)).pathname;
      requests.push({ method, url: path, body, id: new Headers(init?.headers).get("x-submission-id") });
      if (method === "POST") {
        const documentId = JSON.parse(body).documentId;
        return json({ jobId: `job-${documentId}`, status: "pending" }, 202);
      }
      if (method === "GET") {
        polls += 1;
        if (polls === 2) release();
        await barrier;
        return json({ code: "bad-request" }, 400);
      }
      return json({ cancelled: true });
    };
    const parser = client(fetchImpl);
    const results = await Promise.all([
      parser.parseDocument({ ...submission, documentId: "one" }),
      parser.parseDocument({ ...submission, documentId: "two" }),
    ]);
    expect(requests).toHaveLength(6);
    expect(polls).toBe(2);
    for (const [index, documentId] of ["one", "two"].entries()) {
      const result = results[index];
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.jobId).toBe(`job-${documentId}`);
      expect(result.error.kind).toBe("rejected");
      expect(result.error.status).toBe(400);
      expect(result.error.retryable).toBe(false);
      const posts = requests.filter((r) => r.method === "POST" && JSON.parse(r.body).documentId === documentId);
      expect(posts).toHaveLength(1);
      const body = JSON.parse(posts[0].body);
      expect(body).toEqual({ submissionId: expect.any(String), companyId: "company-1", datasetId: "dataset-1", documentId, fileName: "test.pdf", mimeType: "application/pdf", contentBase64: "AQID" });
      expect(body.submissionId.length).toBeGreaterThan(0);
      expect(posts[0].id).toBeNull();
      const followups = requests.filter((r) => r.url === `/v1/parse/job-${documentId}`);
      expect(followups.map((r) => r.method)).toEqual(["GET", "DELETE"]);
      expect(followups.map((r) => r.id)).toEqual([body.submissionId, body.submissionId]);
      expect(followups.map((r) => r.body)).toEqual(["", ""]);
    }
    const ids = requests.filter((r) => r.method === "POST").map((r) => JSON.parse(r.body).submissionId);
    expect(ids[0]).not.toBe(ids[1]);
  });
});
