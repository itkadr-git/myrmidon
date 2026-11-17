import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createCorpusUrlFetcher, createDownloadLimiter } from "./source-fetch.js";

const URL = "https://docs.example.com/page";
const MAX_BYTES = 5;

function source(chunks: Uint8Array[], contentLength?: number) {
  let pulls = 0;
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[pulls++];
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel,
  }, { highWaterMark: 0 });
  const headers: Record<string, string> = contentLength === undefined ? {} : { "content-length": String(contentLength) };
  const fetchUrl = createCorpusUrlFetcher({
    limiter: createDownloadLimiter(1, 0),
    transport: async () => new Response(stream, { headers }),
  });
  return { fetchUrl, cancel, pulls: () => pulls };
}

const tooLarge = {
  status: 413,
  code: "document_too_large",
  details: { maxDocumentBytes: MAX_BYTES },
};

describe("corpus source stream byte ceiling", () => {
  it("returns every byte and the correct hash at the limit across UTF-8 chunks", async () => {
    const bytes = new TextEncoder().encode("a\u20acb");
    const input = source([bytes.slice(0, 2), bytes.slice(2, 4), bytes.slice(4)]);

    const result = await input.fetchUrl(URL, { maxBytes: MAX_BYTES });

    expect(result.bytes).toEqual(bytes);
    expect(result.contentHash).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(input.cancel).not.toHaveBeenCalled();
  });

  it.each([
    ["without content-length", undefined],
    ["with an understated content-length", 2],
  ])("rejects an oversized stream %s and stops reading", async (_description, contentLength) => {
    // The first two chunks contain six UTF-8 bytes but only four characters.
    const input = source([
      new TextEncoder().encode("a\u20ac"),
      new TextEncoder().encode("bc"),
      new TextEncoder().encode("must not be read"),
    ], contentLength);

    await expect(input.fetchUrl(URL, { maxBytes: MAX_BYTES })).rejects.toMatchObject(tooLarge);
    expect(input.cancel).toHaveBeenCalledTimes(1);
    expect(input.pulls()).toBe(2);
  });

  it("rejects an overstated content-length before reading the body", async () => {
    const input = source([new TextEncoder().encode("ok")], MAX_BYTES + 1);

    await expect(input.fetchUrl(URL, { maxBytes: MAX_BYTES })).rejects.toMatchObject(tooLarge);
    expect(input.pulls()).toBe(0);
    expect(input.cancel).toHaveBeenCalledTimes(1);
  });
});
