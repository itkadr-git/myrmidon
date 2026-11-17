import { describe, expect, it, vi } from "vitest";
import { checkCommitMembership, type ReleaseRef } from "./release-membership.js";

const repository = "acme/project";
const firstSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const secondSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const refs: ReleaseRef[] = [
  { ref: "myr-v1.7.1", kind: "tag" },
  { ref: "rel/1.7-fixes", kind: "branch" },
  { ref: "myr-v1.7.2", kind: "tag" },
];
const otherRefs: ReleaseRef[] = [
  { ref: "rel/1.7-next", kind: "branch" },
  { ref: "myr-v1.7.3", kind: "tag" },
];

function response(status: string): Response {
  return new Response(JSON.stringify({ status, ahead_by: status === "diverged" ? 2 : 0 }), { status: 200 });
}

function url(ref: string, sha: string): string {
  return `https://api.github.com/repos/acme/project/compare/${encodeURIComponent(ref)}...${sha}`;
}

function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("checkCommitMembership async isolation", () => {
  it("preserves ref order despite reversed completion and isolates a subsequent call", async () => {
    const pending = refs.map(() => deferred());
    const calls: string[] = [];
    const fetchImpl = vi.fn((input: string) => {
      calls.push(input);
      const index = refs.findIndex(({ ref }) => input === url(ref, firstSha));
      if (index < 0) throw new Error(`Unexpected request: ${input}`);
      return pending[index]!.promise;
    });
    const firstPromise = checkCommitMembership({ repository, sha: firstSha, releasePrefix: "1.7", refs, fetchImpl });
    try {
      expect(calls).toEqual(refs.map(({ ref }) => url(ref, firstSha)));
      pending[2]!.resolve(new Response(null, { status: 404 }));
      await pending[2]!.promise;
      pending[1]!.resolve(response("diverged"));
      await pending[1]!.promise;
      pending[0]!.resolve(response("behind"));
      const first = await firstPromise;
      const expectedFirst = {
        releasePrefix: "1.7", releaseRefs: refs,
        checks: [
          { ref: "myr-v1.7.1", kind: "tag", inRelease: true },
          { ref: "rel/1.7-fixes", kind: "branch", inRelease: false },
          { ref: "myr-v1.7.2", kind: "tag", inRelease: null },
        ], verdict: "present",
      };
      expect(first).toEqual(expectedFirst);

      const nextFetch = vi.fn(async (input: string) => {
        if (!otherRefs.some(({ ref }) => input === url(ref, secondSha))) throw new Error(`Unexpected request: ${input}`);
        return response("diverged");
      });
      const second = await checkCommitMembership({ repository, sha: secondSha, releasePrefix: "1.7", refs: otherRefs, fetchImpl: nextFetch });
      expect(nextFetch.mock.calls.map(([input]) => input)).toEqual(otherRefs.map(({ ref }) => url(ref, secondSha)));
      expect(second).toEqual({
        releasePrefix: "1.7", releaseRefs: otherRefs,
        checks: [
          { ref: "rel/1.7-next", kind: "branch", inRelease: false },
          { ref: "myr-v1.7.3", kind: "tag", inRelease: false },
        ], verdict: "missing_from_release",
      });
      expect(first).toEqual(expectedFirst);
    } finally {
      for (const item of pending) item.resolve(new Response(null, { status: 404 }));
      await firstPromise;
    }
  });

  it("returns unknown for an entirely inconclusive matrix", async () => {
    const fetchImpl = vi.fn(async (_input: string) => new Response(null, { status: 404 }));
    const result = await checkCommitMembership({ repository, sha: firstSha, releasePrefix: "1.7", refs, fetchImpl });
    expect(fetchImpl.mock.calls.map(([input]) => input)).toEqual(refs.map(({ ref }) => url(ref, firstSha)));
    expect(result).toEqual({
      releasePrefix: "1.7", releaseRefs: refs,
      checks: [
        { ref: "myr-v1.7.1", kind: "tag", inRelease: null },
        { ref: "rel/1.7-fixes", kind: "branch", inRelease: null },
        { ref: "myr-v1.7.2", kind: "tag", inRelease: null },
      ], verdict: "unknown",
    });
  });

  it("does not fetch when the SHA is null", async () => {
    const fetchImpl = vi.fn(async (_input: string) => { throw new Error("Unexpected request"); });
    expect(await checkCommitMembership({ repository, sha: null, releasePrefix: "1.7", refs, fetchImpl })).toEqual({
      releasePrefix: "1.7", releaseRefs: refs, checks: [], verdict: "unknown",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
