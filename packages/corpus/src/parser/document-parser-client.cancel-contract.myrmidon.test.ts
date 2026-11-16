import { afterEach, describe, expect, it, vi } from "vitest";

import { createDocumentParserClient } from "./document-parser-client.js";

const retry = { attempts: 3, baseDelayMs: 1, maxDelayMs: 2 };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("document parser cancellation contract", () => {
  it.each<[string, number, string | null, boolean]>([
    ["cancelled true", 200, '{"cancelled":true}', true],
    ["cancelled false", 200, '{"cancelled":false}', false],
    ["missing cancelled", 200, '{"jobId":"job-1"}', true],
    ["empty 204", 204, null, false],
    ["invalid JSON", 200, '{broken', false],
    ["JSON null", 200, 'null', false],
    ["JSON array", 200, '[]', false],
    ...[404, 405, 429, 500, 501].map<[string, number, string | null, boolean]>((status) => [`HTTP ${status}`, status, '{}', false]),
  ])("returns the expected result for %s with one DELETE", async (_name, status, body, expected) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status }));
    const client = createDocumentParserClient({ baseUrl: "http://parser.test", fetchImpl, retry });

    await expect(client.cancelJob("job/1", { submissionId: "attempt-1" })).resolves.toBe(expected);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith("http://parser.test/v1/parse/job%2F1", expect.objectContaining({
      method: "DELETE",
      headers: expect.objectContaining({ "x-submission-id": "attempt-1" }),
    }));
  });

  it("returns false on a transport rejection without retrying", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("network failure"));
    const client = createDocumentParserClient({ baseUrl: "http://parser.test", fetchImpl, retry });

    await expect(client.cancelJob("job-1")).resolves.toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe("DELETE");
  });

  it.each([[250, 250], [30_000, 10_000]])(
    "aborts one DELETE at min(%i, 10000) ms",
    async (timeoutMs, deadline) => {
      vi.useFakeTimers();
      let aborted = false;
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation((_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      }));
      const client = createDocumentParserClient({ baseUrl: "http://parser.test", fetchImpl, retry, timeoutMs });
      const result = client.cancelJob("job-1");

      await vi.advanceTimersByTimeAsync(deadline - 1);
      expect(aborted).toBe(false);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toBe(false);
      expect(aborted).toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe("DELETE");
    },
  );
});
