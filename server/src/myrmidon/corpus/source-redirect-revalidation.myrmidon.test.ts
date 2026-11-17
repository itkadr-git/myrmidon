import { describe, expect, it, vi } from "vitest";
import { createCorpusUrlFetcher, createDownloadLimiter } from "./source-fetch.js";
import type { GuardedRemoteHttpFetchOptions } from "../../services/remote-http-fetch.js";

const start = "https://docs.example.com/start";
const destination = "https://other.example.com/document";
const limits = { maxBytes: 1024 };
const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });

describe("corpus source redirect revalidation", () => {
  it.each([
    ["file", "file:///etc/passwd"],
    ["ftp", "ftp://example.com/document"],
    ["credentials", "https://user:password@example.com/document"],
    ["disallowed port", "https://example.com:8443/document"],
  ])("rejects a redirect to %s before a second transport call", async (_label, location) => {
    const transport = vi.fn(async () => redirect(location));
    const fetchUrl = createCorpusUrlFetcher({ transport, lookup, limiter: createDownloadLimiter(1, 0) });

    await expect(fetchUrl(start, limits)).rejects.toMatchObject({ status: 422, code: "source_url_invalid" });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("passes the guard settings and the same deadline to the second hop and stops on guard refusal", async () => {
    const calls: Array<{ url: string; signal: AbortSignal | null | undefined; options: GuardedRemoteHttpFetchOptions }> = [];
    const transport = vi.fn(async (url: URL, init: RequestInit, options: GuardedRemoteHttpFetchOptions) => {
      calls.push({ url: url.toString(), signal: init.signal, options });
      if (calls.length === 1) return redirect(destination);
      throw options.error("private endpoint", "remote_http_private_endpoint");
    });
    const fetchUrl = createCorpusUrlFetcher({ transport, lookup, limiter: createDownloadLimiter(1, 0) });

    await expect(fetchUrl(start, limits)).rejects.toMatchObject({ status: 422, code: "source_url_blocked" });
    expect(transport).toHaveBeenCalledTimes(2);
    expect(calls.map((call) => call.url)).toEqual([start, destination]);
    expect(calls[0].signal).toBeInstanceOf(AbortSignal);
    expect(calls[1].signal).toBe(calls[0].signal);
    expect(calls[1].options.allowPrivateNetwork).toBe(false);
    expect(calls[1].options.lookup).toBe(lookup);
  });

  it("returns the bytes from a public HTTPS redirect", async () => {
    const transport = vi.fn(async (url: URL) => url.toString() === start
      ? redirect(destination)
      : new Response("redirected content", { headers: { "content-type": "text/plain" } }));
    const fetchUrl = createCorpusUrlFetcher({ transport, lookup, limiter: createDownloadLimiter(1, 0) });

    const result = await fetchUrl(start, limits);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(result.finalUrl).toBe(destination);
    expect(new TextDecoder().decode(result.bytes)).toBe("redirected content");
  });
});
