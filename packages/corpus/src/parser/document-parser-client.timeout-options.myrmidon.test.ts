import { afterEach, describe, expect, it, vi } from "vitest";
import { createDocumentParserClient, type DocumentParserClientOptions } from "./document-parser-client.js";
import type { DocumentParseSubmission } from "./types.js";

const submission: DocumentParseSubmission = {
  companyId: "company", datasetId: "dataset", documentId: "document",
  fileName: "document.pdf", mimeType: "application/pdf", content: new Uint8Array([1]),
};
const baseUrl = "http://parser.test";
const retry = { attempts: 1, baseDelayMs: 1, maxDelayMs: 2 };
const fields = ["timeoutMs", "pollIntervalMs", "pollTimeoutMs", "queueTimeoutMs", "maxRunMs"] as const;

afterEach(() => vi.useRealTimers());

describe("document parser timeout options", () => {
  for (const field of fields) {
    for (const value of [0, -1, 1.5, NaN, Infinity]) {
      it(`rejects ${field}=${String(value)} before transport`, () => {
        const fetchImpl = vi.fn<typeof fetch>();
        expect(() => createDocumentParserClient({ baseUrl, fetchImpl, [field]: value }))
          .toThrowError(new RangeError(`document parser ${field} must be a positive integer`));
        expect(fetchImpl).toHaveBeenCalledTimes(0);
      });
    }
    it(`accepts ${field}=1 and makes one request`, async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ jobId: "job", status: "pending" })));
      const client = createDocumentParserClient({ baseUrl, fetchImpl, [field]: 1 });
      await expect(client.submitDocument(submission)).resolves.toEqual({ jobId: "job", status: "pending" });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
  }

  it.each([
    [{ parserTimeoutMs: 200_000, timeoutMs: 150_000 }, 150_000],
    [{ parserTimeoutMs: 200_000 }, 120_000],
    [{ parserTimeoutMs: 42_000 }, 42_000],
  ])("aborts the request at the selected timeout %#", async (options, deadline) => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      signal = init?.signal ?? undefined;
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const client = createDocumentParserClient({ baseUrl, retry, fetchImpl, ...options });
    const result = client.submitDocument(submission).catch((error: unknown) => error);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(deadline - 1);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    expect(await result).toMatchObject({ kind: "timeout", attempts: 1, message: `document parser did not answer within ${deadline} ms` });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ parserTimeoutMs: 150_000 }, 150_000],
    [{ parserTimeoutMs: 150_000, pollTimeoutMs: 3_000 }, 3_000],
  ])("uses the selected running timeout without capping it %#", async (options: Partial<DocumentParserClientOptions>, deadline: number) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const payload = init?.method === "DELETE" ? { cancelled: true } : { jobId: "job", status: "running" };
      return new Response(JSON.stringify(payload));
    });
    const client = createDocumentParserClient({ baseUrl, fetchImpl, retry, pollIntervalMs: 1_000, ...options });
    const result = client.parseDocument(submission);
    await vi.advanceTimersByTimeAsync(deadline - 1);
    expect(fetchImpl).toHaveBeenCalledTimes(deadline / 1_000);
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({ ok: false, jobId: "job", error: { kind: "timeout", retryable: true, message: `document parser job job made no progress for ${deadline} ms of running` } });
    expect(fetchImpl).toHaveBeenCalledTimes(deadline / 1_000 + 2);
    expect(fetchImpl.mock.calls.at(-1)?.[1]?.method).toBe("DELETE");
  });
});
