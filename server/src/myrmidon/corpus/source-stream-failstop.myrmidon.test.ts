import { describe, expect, it, vi } from "vitest";
import { CorpusSourceError, createCorpusUrlFetcher, createDownloadLimiter } from "./source-fetch.js";

vi.mock("../../middleware/logger.js", () => ({ logger: { warn: vi.fn() } }));

const url = "https://docs.example.com/page";
const limits = { maxBytes: 1024 };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("corpus source stream failures", () => {
  it("refuses a partial stream and releases its slot to a queued download", async () => {
    const readStarted = deferred();
    const failRead = deferred();
    const sentinel = "private-stream-sentinel";
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(new TextEncoder().encode("partial content"));
        } else {
          readStarted.resolve();
          await failRead.promise;
          controller.error(new Error(sentinel));
        }
      },
    });
    const transport = vi.fn()
      .mockResolvedValueOnce(new Response(stream))
      .mockResolvedValueOnce(new Response("complete", { headers: { "content-type": "text/plain" } }));
    const fetchUrl = createCorpusUrlFetcher({ limiter: createDownloadLimiter(1, 1), transport });
    const first = fetchUrl(url, limits);
    const rejected = expect(first).rejects.toMatchObject({
      status: 502, code: "source_fetch_failed", message: "the address could not be fetched",
    });
    await readStarted.promise;
    const second = fetchUrl(url, limits);
    await expect(fetchUrl(url, limits)).rejects.toMatchObject({ status: 503, code: "source_fetch_busy" });
    expect(transport).toHaveBeenCalledTimes(1);
    failRead.resolve();
    await rejected;
    const error = await first.catch((err: unknown) => err);
    expect(error).toBeInstanceOf(CorpusSourceError);
    expect(error).not.toHaveProperty("bytes");
    expect(error).not.toHaveProperty("contentHash");
    expect(JSON.stringify(error)).not.toContain(sentinel);
    expect((error as Error).message).not.toContain(sentinel);
    const result = await second;
    expect(new TextDecoder().decode(result.bytes)).toBe("complete");
    expect(result.contentType).toBe("text/plain");
    expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("normalizes transport rejection without exposing its message", async () => {
    const sentinel = "private-transport-sentinel";
    const fetchUrl = createCorpusUrlFetcher({
      limiter: createDownloadLimiter(1, 1),
      transport: async () => { throw new Error(sentinel); },
    });
    const error = await fetchUrl(url, limits).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(CorpusSourceError);
    expect(error).toMatchObject({ status: 502, code: "source_fetch_failed", message: "the address could not be fetched" });
    expect(JSON.stringify(error)).not.toContain(sentinel);
  });

  it("preserves a typed transport refusal", async () => {
    const refusal = new CorpusSourceError(422, "source_url_blocked", "address refused");
    const fetchUrl = createCorpusUrlFetcher({
      limiter: createDownloadLimiter(1, 1),
      transport: async () => { throw refusal; },
    });
    await expect(fetchUrl(url, limits)).rejects.toBe(refusal);
    expect(refusal).toMatchObject({ status: 422, code: "source_url_blocked", message: "address refused" });
  });
});
