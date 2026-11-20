import { describe, expect, it, vi } from "vitest";
import { createCorpusUrlFetcher } from "./source-fetch.js";

const start = "https://example.com/a/b/start";
const bytes = new TextEncoder().encode("final document");

function fixture(locations: string[]) {
  const calls: string[] = [];
  const cancelled = locations.map(() => vi.fn());
  const fetch = createCorpusUrlFetcher({
    limiter: { run: (task) => task() },
    transport: async (url) => {
      calls.push(url.toString());
      const index = calls.length - 1;
      if (index < locations.length) {
        return new Response(new ReadableStream({ cancel: cancelled[index] }), {
          status: 302,
          headers: { location: locations[index] },
        });
      }
      return new Response(bytes, { status: 200 });
    },
  });
  return { fetch, calls, cancelled };
}

describe("corpus source redirect depth", () => {
  it.each([
    { locations: [], expected: [start] },
    { locations: ["../one?x=1#ignored"], expected: [start, "https://example.com/a/one?x=1"] },
    {
      locations: ["../one?x=1#ignored", "./two", "?page=3#part", "../four", "./five#end"],
      expected: [start, "https://example.com/a/one?x=1", "https://example.com/a/two", "https://example.com/a/two?page=3", "https://example.com/four", "https://example.com/five"],
    },
  ])("loads the final response after $locations.length redirects", async ({ locations, expected }) => {
    const f = fixture(locations);
    const result = await f.fetch(`${start}#initial`, { maxBytes: 1024 });
    expect(f.calls).toEqual(expected);
    expect(result.finalUrl).toBe(expected[expected.length - 1]);
    expect(result.bytes).toEqual(bytes);
    for (const cancel of f.cancelled) expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects the sixth redirect without fetching its target", async () => {
    const f = fixture(["/1", "/2", "/3", "/4", "/5", "/6"]);
    await expect(f.fetch(start, { maxBytes: 1024 })).rejects.toMatchObject({ status: 422, code: "too_many_redirects" });
    expect(f.calls).toEqual([start, "https://example.com/1", "https://example.com/2", "https://example.com/3", "https://example.com/4", "https://example.com/5"]);
    for (const cancel of f.cancelled) expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects a malformed location without another transport call", async () => {
    const f = fixture(["http://[invalid"]);
    await expect(f.fetch(start, { maxBytes: 1024 })).rejects.toMatchObject({ status: 502, code: "source_fetch_failed" });
    expect(f.calls).toEqual([start]);
    expect(f.cancelled[0]).toHaveBeenCalledOnce();
  });
});
