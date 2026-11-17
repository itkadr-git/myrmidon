import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCorpusUrlFetcher, createDownloadLimiter } from "./source-fetch.js";

const start = "https://docs.example.com/start";
const limits = { maxBytes: 1024 };
const fixtures = [
  ["binary", Uint8Array.from([0xff, 0x81, 0x42, 0xfe])],
  ["zero byte", Uint8Array.from([0x41, 0x00, 0x42])],
  ["UTF-8", new TextEncoder().encode("caf\u00e9 \u4e16\u754c")],
] as const;

function responseStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, 1));
      controller.enqueue(bytes.slice(1));
      controller.close();
    },
  });
}

describe("corpus source result metadata", () => {
  for (const status of [200, 201, 206]) {
    it.each(fixtures)(`preserves %s bytes and their SHA-256 for HTTP ${status}`, async (_name, fixture) => {
      const fetchUrl = createCorpusUrlFetcher({
        limiter: createDownloadLimiter(1, 0),
        transport: async () => new Response(responseStream(fixture), { status }),
      });
      const result = await fetchUrl(start, limits);

      expect(result.bytes).toEqual(fixture);
      expect(result.bytes.byteLength).toBeGreaterThan(0);
      expect(result.contentHash).toBe(createHash("sha256").update(fixture).digest("hex"));
      expect(result.finalUrl).toBe(start);
    });
  }

  it.each([
    ["mixed case with parameters", "Text/HTML; charset=UTF-8", "text/html"],
    ["empty", "", null],
    ["absent", undefined, null],
  ])("normalizes %s Content-Type", async (_label, header, expected) => {
    const fetchUrl = createCorpusUrlFetcher({
      limiter: createDownloadLimiter(1, 0),
      transport: async () => new Response(responseStream(fixtures[0][1]), {
        headers: header === undefined ? {} : { "content-type": header },
      }),
    });

    const result = await fetchUrl(start, limits);
    expect(result.contentType).toBe(expected);
    expect(result.bytes).toEqual(fixtures[0][1]);
  });

  it("returns the last redirect target and its actual bytes and metadata", async () => {
    const finalUrl = "https://cdn.example.com/final?version=2";
    const visited: string[] = [];
    const fixture = fixtures[2][1];
    const fetchUrl = createCorpusUrlFetcher({
      limiter: createDownloadLimiter(1, 0),
      transport: async (url) => {
        visited.push(url.toString());
        if (url.toString() === start) {
          return new Response(null, { status: 302, headers: { location: finalUrl } });
        }
        return new Response(responseStream(fixture), { headers: { "content-type": "Text/HTML; charset=UTF-8" } });
      },
    });

    const result = await fetchUrl(start, limits);
    expect(visited).toEqual([start, finalUrl]);
    expect(result.finalUrl).toBe(finalUrl);
    expect(result.contentType).toBe("text/html");
    expect(result.bytes).toEqual(fixture);
    expect(result.contentHash).toBe(createHash("sha256").update(fixture).digest("hex"));
  });

  it.each(["empty stream", "null body"])("rejects a successful response with %s", async (kind) => {
    const fetchUrl = createCorpusUrlFetcher({
      limiter: createDownloadLimiter(1, 0),
      transport: async () => new Response(
        kind === "null body" ? null : new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
        { status: 200 },
      ),
    });

    await expect(fetchUrl(start, limits)).rejects.toMatchObject({ status: 422, code: "empty_document" });
  });
});
