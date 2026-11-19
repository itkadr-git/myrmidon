import { describe, expect, it, vi } from "vitest";

import { createDocumentParserClient } from "./document-parser-client.js";

const cases = [
  ["slash", "job/other", "job%2Fother"],
  ["query", "job?admin=true", "job%3Fadmin%3Dtrue"],
  ["fragment", "job#section", "job%23section"],
  ["percent", "job%value", "job%25value"],
  ["space", "job name", "job%20name"],
  ["cyrillic", "\u0437\u0430\u0434\u0430\u0447\u0430", "%D0%B7%D0%B0%D0%B4%D0%B0%D1%87%D0%B0"],
  ["already encoded", "job%2Fother%3Fx%3D1", "job%252Fother%253Fx%253D1"],
  ["combined", "a/b?x=1#frag %", "a%2Fb%3Fx%3D1%23frag%20%25"],
] as const;

const baseUrl = "https://parser.example.test/root///";
const submissionId = "submission/attempt?secret=1#part";
const retry = { attempts: 1, baseDelayMs: 1, maxDelayMs: 2 };

describe("document parser job URL encoding", () => {
  it.each(cases)("keeps %s job IDs in a single segment for polling and cancellation", async (_name, jobId, encoded) => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ jobId, status: "running" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ cancelled: true }), { status: 200 }));
    const parser = createDocumentParserClient({ baseUrl, fetchImpl, retry });
    const url = `https://parser.example.test/root/v1/parse/${encoded}`;

    expect(await parser.fetchJob(jobId, { submissionId })).toEqual({ jobId, status: "running" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenNthCalledWith(1, url, expect.objectContaining({
      method: "GET", headers: expect.objectContaining({ "x-submission-id": submissionId }),
    }));
    expect(await parser.cancelJob(jobId, { submissionId })).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenNthCalledWith(2, url, expect.objectContaining({
      method: "DELETE", headers: expect.objectContaining({ "x-submission-id": submissionId }),
    }));
  });

  it("preserves the encoded URL and returns failure on a rejected poll and cancel", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "job_not_found" }), { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "job_not_found" }), { status: 404 }));
    const parser = createDocumentParserClient({ baseUrl, fetchImpl, retry });
    const url = "https://parser.example.test/root/v1/parse/missing%2Fjob%3Fq%3D1%23fragment";

    await expect(parser.fetchJob("missing/job?q=1#fragment", { submissionId })).rejects.toMatchObject({
      kind: "rejected", status: 404, code: "job_not_found", retryable: false, attempts: 1,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenNthCalledWith(1, url, expect.objectContaining({
      method: "GET", headers: expect.objectContaining({ "x-submission-id": submissionId }),
    }));
    expect(await parser.cancelJob("missing/job?q=1#fragment", { submissionId })).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenNthCalledWith(2, url, expect.objectContaining({
      method: "DELETE", headers: expect.objectContaining({ "x-submission-id": submissionId }),
    }));
  });
});
