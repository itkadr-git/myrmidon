// packages/shared/src/myrmidon-release-stage.test.ts
//
// myrmidon(1.8 RELEASE-STAGE): the authority + gates + signature contract
// tests. The release-manager caste is a company-defined caste key; the matrix
// rows are pinned here and the tests prove the three acceptance sides:
//
//   1. positive: a release-manager agent may sign and publish when the gates
//      are complete and the artifact is signed;
//   2. negative: any other caste, an unknown caste and a caste with no
//      matrix row cannot take a release action (no bypass of the gates);
//   3. the publication gate: publish is refused while any release gate is
//      incomplete or the artifact is unsigned, for every caller including
//      the release manager itself.

import { describe, expect, it } from "vitest";
import {
  RELEASE_ACTIONS,
  canPublishRelease,
  canReleaseAction,
  type ReleaseStage,
} from "./myrmidon-release-stage.js";

const RELEASE_CASTE = "release_manager";

function stage(overrides: Partial<ReleaseStage> = {}): ReleaseStage {
  return {
    releaseId: "rel-1.8.0",
    gates: [
      { key: "ci-green", completed: true },
      { key: "review-approved", completed: true },
    ],
    artifact: {
      artifactId: "myrmidon-1.8.0",
      digest: "sha256:abc123",
      signedAt: "2026-11-13T00:00:00.000Z",
      signedBy: { type: "agent", id: "agent-rel", casteKey: RELEASE_CASTE },
      verificationUrl: "https://releases.example.com/1.8.0/verify",
    },
    publishedAt: null,
    publishedBy: null,
    publicationUrl: null,
    ...overrides,
  };
}

describe("myrmidon(1.8 RELEASE-STAGE) authority matrix", () => {
  it("positive: the release-manager caste may sign and publish", () => {
    expect(canReleaseAction(RELEASE_CASTE, "sign_artifact").allowed).toBe(true);
    expect(canReleaseAction(RELEASE_CASTE, "publish_release").allowed).toBe(true);
    // Every release action is covered by the role: no action outside the
    // matrix exists for the releaser to hold.
    for (const action of RELEASE_ACTIONS) {
      expect(canReleaseAction(RELEASE_CASTE, action).allowed).toBe(true);
    }
  });

  it("negative: no other built-in caste holds a release action", () => {
    for (const other of ["engineer", "qa", "devops", "ceo", "cto", "security", "architect", "pm"]) {
      for (const action of RELEASE_ACTIONS) {
        const decision = canReleaseAction(other, action);
        expect(decision.allowed).toBe(false);
        if (!decision.allowed) expect(decision.code).toBe("release_action_forbidden");
      }
    }
  });

  it("negative: an unknown or absent caste falls to no authority (total resolver)", () => {
    expect(canReleaseAction("brand-new-caste", "publish_release").allowed).toBe(false);
    expect(canReleaseAction(null, "publish_release").allowed).toBe(false);
    expect(canReleaseAction(undefined, "sign_artifact").allowed).toBe(false);
    // Case and whitespace do not create authority.
    expect(canReleaseAction("  Release-Manager ", "publish_release").allowed).toBe(true);
    expect(canReleaseAction("releasemanager", "publish_release").allowed).toBe(false);
  });
});

describe("myrmidon(1.8 RELEASE-STAGE) publication gates", () => {
  it("positive: a complete stage publishes for the release-manager caste", () => {
    const decision = canPublishRelease(stage(), RELEASE_CASTE);
    expect(decision.allowed).toBe(true);
  });

  it("negative: an incomplete gate blocks publication for any caller", () => {
    const incomplete = stage({
      gates: [
        { key: "ci-green", completed: true },
        { key: "review-approved", completed: false },
      ],
    });
    for (const caller of [RELEASE_CASTE, "engineer", "board-admin"]) {
      const decision = canPublishRelease(incomplete, caller);
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) expect(decision.code).toBe("release_gates_incomplete");
    }
  });

  it("negative: an unsigned artifact blocks publication even with complete gates", () => {
    const unsigned = stage({ artifact: null });
    const decision = canPublishRelease(unsigned, RELEASE_CASTE);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.code).toBe("release_signature_required");
  });

  it("negative: a stage with no gates is never publishable", () => {
    const decision = canPublishRelease(stage({ gates: [] }), RELEASE_CASTE);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.code).toBe("release_gates_incomplete");
  });
});

describe("myrmidon(1.8 RELEASE-STAGE) signed reference", () => {
  it("exposes a verifiable reference with authorship once signed", () => {
    const signed = stage();
    const reference = canPublishRelease(signed, RELEASE_CASTE);
    expect(reference.allowed).toBe(true);
    expect(signed.artifact?.verificationUrl).toMatch(/^https:\/\//);
    expect(signed.artifact?.signedBy.casteKey).toBe(RELEASE_CASTE);
    expect(signed.artifact?.digest).toMatch(/^sha256:/);
  });
});
