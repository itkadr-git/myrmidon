import { describe, expect, it, vi } from "vitest";
import { resolveReleaseRefs } from "./release-membership.js";

type Endpoint = "tags" | "branches";
type Failure = "403" | "500" | "fetch" | "json" | "non-array";

const urls = {
  tags: "https://api.github.com/repos/acme/project/git/matching-refs/tags/myr-v1.6",
  branches: "https://api.github.com/repos/acme/project/git/matching-refs/branches/rel%2F1.6",
};
const refs = {
  tags: { ref: "myr-v1.6.8", kind: "tag" },
  branches: { ref: "rel/1.6.8-fixes", kind: "branch" },
} as const;

function success(endpoint: Endpoint): Response {
  const prefix = endpoint === "tags" ? "refs/tags/" : "refs/heads/";
  return new Response(JSON.stringify([{ ref: prefix + refs[endpoint].ref }]), { status: 200 });
}

function failure(mode: Failure): Promise<Response> {
  if (mode === "fetch") return Promise.reject(new Error("network unavailable"));
  if (mode === "json") return Promise.resolve(new Response("{", { status: 200 }));
  if (mode === "non-array") return Promise.resolve(new Response("{}", { status: 200 }));
  return Promise.resolve(new Response("error", { status: Number(mode) }));
}

function transport(failures: Partial<Record<Endpoint, Failure>>) {
  return vi.fn(async (input: string, _init?: RequestInit): Promise<Response> => {
    const endpoint = (Object.keys(urls) as Endpoint[]).find((kind) => urls[kind] === input);
    if (!endpoint) throw new Error(`Unexpected request: ${input}`);
    const mode = failures[endpoint];
    return mode ? failure(mode) : success(endpoint);
  });
}

function assertRequests(fetchImpl: ReturnType<typeof transport>) {
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([urls.tags, urls.branches]);
  for (const [, init] of fetchImpl.mock.calls) {
    expect(init?.headers).toEqual({
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      authorization: "Bearer synthetic-token",
    });
  }
}

const options = { repository: "acme/project", releasePrefix: "1.6", token: "synthetic-token" };

describe("resolveReleaseRefs partial failures", () => {
  for (const endpoint of ["tags", "branches"] as const) {
    for (const mode of ["403", "500", "fetch", "json", "non-array"] as const) {
      it(`keeps the other endpoint when ${endpoint} fails with ${mode}, then recovers`, async () => {
        const failures: Partial<Record<Endpoint, Failure>> = { [endpoint]: mode };
        const fetchImpl = transport(failures);
        const survivor = endpoint === "tags" ? refs.branches : refs.tags;
        expect(await resolveReleaseRefs({ ...options, fetchImpl })).toEqual([survivor]);
        assertRequests(fetchImpl);

        delete failures[endpoint];
        fetchImpl.mockClear();
        expect(await resolveReleaseRefs({ ...options, fetchImpl })).toEqual([refs.tags, refs.branches]);
        assertRequests(fetchImpl);
      });
    }
  }

  it("returns no defaults when both endpoints are unavailable", async () => {
    const fetchImpl = transport({ tags: "fetch", branches: "500" });
    expect(await resolveReleaseRefs({ ...options, fetchImpl })).toEqual([]);
    assertRequests(fetchImpl);
  });
});
