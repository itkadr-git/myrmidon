import { describe, expect, it } from "vitest";
import { verifyReleaseComposition, type ReleaseVerificationOptions } from "./release-verification.js";

const a = { id: "synthetic-A", repository: "synthetic/release-fixture", sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", ref: "myr-v1.7.0", time: "2026-11-13T12:00:00.000Z" };
const b = { id: "synthetic-B", repository: "synthetic/other-fixture", sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", ref: "myr-v1.7.1", time: "2026-11-14T12:00:00.000Z" };
type Fixture = typeof a;

function deferred() {
  let resolve!: (value: Response) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<Response>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function response(status: "identical" | "diverged") {
  return new Response(JSON.stringify({ status, ahead_by: status === "identical" ? 0 : 3 }), { status: 200 });
}

function options(f: Fixture, fetchImpl: NonNullable<ReleaseVerificationOptions["fetchImpl"]>): ReleaseVerificationOptions {
  const refs = [{ ref: f.ref, kind: "tag" as const }];
  return { releasePrefix: "1.7", deployedVersion: f.ref, members: [{ id: f.id, repository: f.repository, mergeCommitSha: f.sha, merged: true }], resolvedRefs: refs, refs, now: () => new Date(f.time), fetchImpl };
}

function expected(f: Fixture, membership: "present" | "missing_from_release" | "unknown") {
  const present = membership === "present";
  return {
    verdict: present ? "confirmed" : "failed",
    reason: present ? "Все 1 задач кандидата присутствуют в выкаченной версии." : membership === "unknown"
      ? "Выкаченная версия не установлена или membership неразрешим (1 из 1 задач в статусе unknown)."
      : "В выкаченной версии отсутствуют 1 из 1 задач кандидата.",
    failureReason: present ? null : membership === "unknown" ? "deployed_version_unknown" : "member_missing_from_release",
    releasePrefix: "1.7", deployedVersion: f.ref,
    members: [{ id: f.id, repository: f.repository, mergeCommitSha: f.sha, membership, releaseRefs: [f.ref] }],
    allMembersPresent: present, checkedAt: f.time,
  };
}

function url(f: Fixture) {
  return `https://api.github.com/repos/${f.repository}/compare/${f.ref}...${f.sha}`;
}

describe("verifyReleaseComposition async isolation", () => {
  it("keeps concurrent present and missing results separate when B completes first", async () => {
    const da = deferred();
    const db = deferred();
    const callsA: string[] = [];
    const callsB: string[] = [];
    const pa = verifyReleaseComposition(options(a, (input) => { callsA.push(input); return da.promise; }));
    const pb = verifyReleaseComposition(options(b, (input) => { callsB.push(input); return db.promise; }));
    expect(callsA).toEqual([url(a)]);
    expect(callsB).toEqual([url(b)]);
    db.resolve(response("diverged"));
    expect(await pb).toEqual(expected(b, "missing_from_release"));
    da.resolve(response("identical"));
    expect(await pa).toEqual(expected(a, "present"));
    expect(callsA).toEqual([url(a)]);
    expect(callsB).toEqual([url(b)]);
  });

  it("isolates a transport rejection and a later successful A", async () => {
    const da = deferred();
    const db = deferred();
    const callsA: string[] = [];
    const callsB: string[] = [];
    const pa = verifyReleaseComposition(options(a, (input) => { callsA.push(input); return da.promise; }));
    const pb = verifyReleaseComposition(options(b, (input) => { callsB.push(input); return db.promise; }));
    expect(callsA).toEqual([url(a)]);
    expect(callsB).toEqual([url(b)]);
    db.reject(new Error("synthetic transport failure"));
    expect(await pb).toEqual(expected(b, "unknown"));
    da.resolve(response("identical"));
    expect(await pa).toEqual(expected(a, "present"));
    const againCalls: string[] = [];
    const again = await verifyReleaseComposition(options(a, async (input) => { againCalls.push(input); return response("identical"); }));
    expect(again).toEqual(expected(a, "present"));
    expect(againCalls).toEqual([url(a)]);
    expect(callsA).toEqual([url(a)]);
    expect(callsB).toEqual([url(b)]);
  });
});
