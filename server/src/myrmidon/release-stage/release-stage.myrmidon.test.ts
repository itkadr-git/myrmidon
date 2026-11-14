// server/src/myrmidon/release-stage/release-stage.myrmidon.test.ts
//
// myrmidon(1.8 RELEASE-STAGE): the REST API suite — authority (positive and
// negative permissions through the autonomy matrix), the publication gate
// (publish refuses while a step is incomplete or the artifact is unsigned),
// and the signed, verifiable publication reference with authorship.
//
// Plain fakes for the service dependencies: no database, no network — the
// same shape as the castes API suite (castes-api.myrmidon.test.ts).

import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { defaultAutonomyMatrix, type AutonomyMatrix } from "@myrmidon/shared";
import { errorHandler } from "../../middleware/index.js";
import { releaseStageRoutes } from "./routes.js";
import { createInMemoryReleaseStageStore, createReleaseStageService } from "./service.js";

const COMPANY_ID = "22222222-2222-8222-8222-222222222222";
const OTHER_COMPANY = "33333333-3333-8333-8333-333333333333";
const RELEASE_ID = "rel-1.8.0";

const boardMember = {
  type: "board",
  source: "session",
  userId: "user-a",
  isInstanceAdmin: false,
  companyIds: [COMPANY_ID],
};
const outsider = {
  type: "board",
  source: "session",
  userId: "user-b",
  isInstanceAdmin: false,
  companyIds: [OTHER_COMPANY],
};

/** Agent actors: the caste key comes from the fake agent directory. */
const releaseAgent = { type: "agent", source: "agent_key", agentId: "agent-rel", companyId: COMPANY_ID, keyId: "key-rel" };
const engineerAgent = { type: "agent", source: "agent_key", agentId: "agent-eng", companyId: COMPANY_ID, keyId: "key-eng" };

/** The fake agent directory: caste keys (`agents.role`) by agent id. */
const AGENT_CASTES: Record<string, string> = {
  "agent-rel": "release_manager",
  "agent-eng": "engineer",
};

/** The autonomy matrix under test: the release-manager caste holds the release deploy class, nobody else. */
function releaseMatrix(): AutonomyMatrix {
  return {
    version: 1,
    rules: [
      { role: "release_manager", actionClass: "deploy", verdict: "allowed" },
      { role: "engineer", actionClass: "deploy", verdict: "forbidden" },
    ],
    defaults: { ...defaultAutonomyMatrix().defaults },
  };
}

type Activity = { companyId: string; actorType: string; actorId: string; action: string; entityId: string; details: Record<string, unknown> };

function app(actor: unknown, matrix: AutonomyMatrix = releaseMatrix()) {
  const store = createInMemoryReleaseStageStore();
  const service = createReleaseStageService({
    store,
    matrixOf: async () => matrix,
    now: () => new Date("2026-11-13T12:00:00.000Z"),
  });
  const activity: Activity[] = [];
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    // x-test-actor switches the acting agent inside one app instance; without
    // it the app acts as its fixture actor (board user or the fixture agent).
    const override = typeof req.headers["x-test-actor"] === "string" ? req.headers["x-test-actor"] : null;
    const base = actor as { agentId?: string; companyId?: string } | undefined;
    const actorOverride =
      override
        ? {
            type: "agent",
            source: "agent_key",
            agentId: override,
            companyId: base?.companyId ?? COMPANY_ID,
            keyId: `key-${override}`,
          }
        : actor;
    (req as unknown as { actor: unknown }).actor = actorOverride;
    next();
  });
  server.use(
    "/api",
    releaseStageRoutes({
      service,
      casteKeyOf: async (agentId) => AGENT_CASTES[agentId] ?? null,
      logActivity: async (input) => {
        activity.push({
          companyId: input.companyId,
          actorType: input.actorType,
          actorId: input.actorId,
          action: input.action,
          entityId: input.entityId,
          details: input.details,
        });
      },
    }),
  );
  server.use(errorHandler);
  // The caste lookup is database-backed in production; the test doubles it by
  // seeding a matching matrixOf through the service factory above and by
  // pre-defining the stage so caste resolution is the only variable.
  return { server, activity, store };
}

async function defineStage(server: express.Express, gates: { key: string; completed: boolean }[]) {
  await request(server)
    .put(`/api/myrmidon/release-stages/${RELEASE_ID}/gates?companyId=${COMPANY_ID}`)
    .send({ gates });
}

const GOOD_GATES = [
  { key: "ci-green", completed: true },
  { key: "review-approved", completed: true },
];

describe("myrmidon(1.8 RELEASE-STAGE) routes: access", () => {
  it("denies another company on every route (403)", async () => {
    const { server } = app(outsider);
    await request(server).get(`/api/myrmidon/release-stages?companyId=${COMPANY_ID}`).expect(403);
    await request(server)
      .put(`/api/myrmidon/release-stages/${RELEASE_ID}/gates?companyId=${COMPANY_ID}`)
      .send({ gates: GOOD_GATES })
      .expect(403);
    await request(server)
      .post(`/api/myrmidon/release-stages/${RELEASE_ID}/publish?companyId=${COMPANY_ID}`)
      .send({ publicationUrl: "https://releases.example.com/1.8.0" })
      .expect(403);
  });

  it("gate definition is board-only: an agent is refused (403)", async () => {
    const { server } = app(releaseAgent);
    await request(server)
      .put(`/api/myrmidon/release-stages/${RELEASE_ID}/gates?companyId=${COMPANY_ID}`)
      .send({ gates: GOOD_GATES })
      .expect(403);
  });
});

describe("myrmidon(1.8 RELEASE-STAGE) routes: positive permissions", () => {
  it("the board defines gates; the release-manager caste agent signs and publishes, with authorship on the record", async () => {
    const { server, activity } = app(boardMember);
    await defineStage(server, GOOD_GATES);

    // The releaser agent signs: the signature records the agent and its caste.
    const signRes = await request(server)
      .post(`/api/myrmidon/release-stages/${RELEASE_ID}/sign?companyId=${COMPANY_ID}`)
      .set("x-test-actor", "agent-rel")
      .send({
        artifactId: "myrmidon-1.8.0",
        tag: "v2026.1114.1",
        version: "1.8.0-rc.1",
        composition: ["OPE-13005", "OPE-13008"],
        digest: "sha256:abc123",
        verificationUrl: "https://releases.example.com/1.8.0/verify",
      })
      .expect(200);
    expect(signRes.body.stage.artifact.tag).toBe("v2026.1114.1");
    expect(signRes.body.stage.artifact.version).toBe("1.8.0-rc.1");
    expect(signRes.body.stage.artifact.composition).toEqual(["OPE-13005", "OPE-13008"]);
    expect(signRes.body.stage.artifact.signedAt).toBe("2026-11-13T12:00:00.000Z");
    expect(signRes.body.stage.artifact.signedBy).toEqual({
      type: "agent",
      id: "agent-rel",
      casteKey: "release_manager",
    });

    // The same releaser caste publishes: the publication reference carries the
    // verifiable URL and the authorship of both the signer and the publisher.
    const publishRes = await request(server)
      .post(`/api/myrmidon/release-stages/${RELEASE_ID}/publish?companyId=${COMPANY_ID}`)
      .set("x-test-actor", "agent-rel")
      .send({ publicationUrl: "https://releases.example.com/1.8.0" })
      .expect(200);
    expect(publishRes.body.stage.published).toBe(true);
    expect(publishRes.body.stage.publicationUrl).toBe("https://releases.example.com/1.8.0");
    expect(publishRes.body.stage.publishedBy).toEqual({
      type: "agent",
      id: "agent-rel",
      casteKey: "release_manager",
    });
    expect(publishRes.body.stage.signaturePresent).toBe(true);
    // Auditable: gates, signature and publication each wrote an activity row,
    // the signing/publication rows carrying the release-manager authorship.
    const repeatedPublish = await request(server)
      .post(`/api/myrmidon/release-stages/${RELEASE_ID}/publish?companyId=${COMPANY_ID}`)
      .set("x-test-actor", "agent-rel")
      .send({ publicationUrl: "https://releases.example.com/1.8.0" })
      .expect(200);
    expect(repeatedPublish.body.stage.publishedAt).toBe(publishRes.body.stage.publishedAt);
    expect(activity.map((row) => row.action)).toEqual([
      "release_stage_gates_defined",
      "release_artifact_signed",
      "release_published",
    ]);
    expect(activity[1]?.details.signedBy).toEqual({ type: "agent", id: "agent-rel", casteKey: "release_manager" });
    expect(activity[2]?.details.publishedBy).toEqual({ type: "agent", id: "agent-rel", casteKey: "release_manager" });
  });

  it("the board actor can also sign and publish (the releaser of last resort)", async () => {
    const { server } = app(boardMember);
    await defineStage(server, GOOD_GATES);
    const signRes = await request(server)
      .post(`/api/myrmidon/release-stages/${RELEASE_ID}/sign?companyId=${COMPANY_ID}`)
      .send({
        artifactId: "myrmidon-1.8.0",
        tag: "v2026.1114.1",
        version: "1.8.0-rc.1",
        composition: ["OPE-13005", "OPE-13008"],
        digest: "sha256:abc123",
        verificationUrl: "https://releases.example.com/1.8.0/verify",
      })
      .expect(200);
    expect(signRes.body.stage.artifact.signedBy.type).toBe("board");
    const publishRes = await request(server)
      .post(`/api/myrmidon/release-stages/${RELEASE_ID}/publish?companyId=${COMPANY_ID}`)
      .send({ publicationUrl: "https://releases.example.com/1.8.0" })
      .expect(200);
    expect(publishRes.body.stage.published).toBe(true);
    expect(publishRes.body.stage.publishedBy.type).toBe("board");
  });
});

describe("myrmidon(1.8 RELEASE-STAGE) routes: negative permissions", () => {
  it("an agent whose caste the matrix forbids cannot sign or publish (403 release_action_forbidden)", async () => {
    const { server } = app(engineerAgent);
    await request(server)
      .post(`/api/myrmidon/release-stages/${RELEASE_ID}/sign?companyId=${COMPANY_ID}`)
      .send({
        artifactId: "myrmidon-1.8.0",
        tag: "v2026.1114.1",
        version: "1.8.0-rc.1",
        composition: ["OPE-13005", "OPE-13008"],
        digest: "sha256:abc123",
        verificationUrl: "https://releases.example.com/1.8.0/verify",
      })
      .expect(403);
    await request(server)
      .post(`/api/myrmidon/release-stages/${RELEASE_ID}/publish?companyId=${COMPANY_ID}`)
      .send({ publicationUrl: "https://releases.example.com/1.8.0" })
      .expect(403);
  });

  it("a caste with no matrix row has no release authority either (403)", async () => {
    const unknownCasteAgent = { type: "agent", source: "agent_key", agentId: "agent-new", companyId: COMPANY_ID, keyId: "key-new" };
    const { server } = app(unknownCasteAgent);
    // The route resolves the live caste key from the agent directory; this
    // fake agent has none, and a casteless agent holds no authority.
    await request(server)
      .post(`/api/myrmidon/release-stages/${RELEASE_ID}/publish?companyId=${COMPANY_ID}`)
      .send({ publicationUrl: "https://releases.example.com/1.8.0" })
      .expect(403);
  });

  it("a caste allowed by an unrelated matrix cell (the `other` default) still holds no release authority (403)", async () => {
    // The default matrix leaves `deploy` at approval_required; the safe
    // defaults also allow many unrelated classes. Neither grants release
    // authority: only an explicit allowed release_manager deploy row does.
    const permissive = { ...defaultAutonomyMatrix() };
    const { server } = app(engineerAgent, permissive);
    const res = await request(server)
      .post(`/api/myrmidon/release-stages/${RELEASE_ID}/sign?companyId=${COMPANY_ID}`)
      .send({
        artifactId: "myrmidon-1.8.0",
        tag: "v2026.1114.1",
        version: "1.8.0-rc.1",
        composition: ["OPE-13005", "OPE-13008"],
        digest: "sha256:abc123",
        verificationUrl: "https://releases.example.com/1.8.0/verify",
      })
      .expect(403);
    expect(res.body.code).toBe("release_action_forbidden");
    await request(server)
      .post(`/api/myrmidon/release-stages/${RELEASE_ID}/publish?companyId=${COMPANY_ID}`)
      .send({ publicationUrl: "https://releases.example.com/1.8.0" })
      .expect(403);
  });

  it("the release-manager caste holds only the release actions, not every deploy-flavored seam (authority is per seam)", async () => {
    // The release authority decision is seam-scoped: holding sign/publish here
    // says nothing about other action classes; conversely a matrix that allows
    // the release_manager merge class must not auto-grant release authority
    // for a class the releaser never ruled on. The resolver reads only the
    // release action class (`deploy`), so an unrelated allowed row cannot
    // leak into it — pinned by resolving a matrix with only a merge row.
    const mergeOnly: AutonomyMatrix = {
      version: 1,
      rules: [{ role: "release_manager", actionClass: "merge", verdict: "allowed" }],
      defaults: { ...defaultAutonomyMatrix().defaults },
    };
    const { server } = app(releaseAgent, mergeOnly);
    const res = await request(server)
      .post(`/api/myrmidon/release-stages/${RELEASE_ID}/sign?companyId=${COMPANY_ID}`)
      .send({
        artifactId: "myrmidon-1.8.0",
        tag: "v2026.1114.1",
        version: "1.8.0-rc.1",
        composition: ["OPE-13005", "OPE-13008"],
        digest: "sha256:abc123",
        verificationUrl: "https://releases.example.com/1.8.0/verify",
      })
      .expect(403);
    expect(res.body.code).toBe("release_action_forbidden");
  });
});

describe("myrmidon(1.8 RELEASE-STAGE) routes: publication gates", () => {
  it("refuses release notes with missing tag, version, or composition", async () => {
    const { server } = app(boardMember);
    await defineStage(server, GOOD_GATES);
    const response = await request(server)
      .post(`/api/myrmidon/release-stages/${RELEASE_ID}/sign?companyId=${COMPANY_ID}`)
      .send({
        artifactId: "myrmidon-1.8.0",
        digest: "sha256:abc123",
        verificationUrl: "https://releases.example.com/1.8.0/verify",
      })
      .expect(400);
    expect(response.body.details ?? response.body.issues ?? response.body.message).toBeDefined();
    const stage = await request(server).get(`/api/myrmidon/release-stages/${RELEASE_ID}?companyId=${COMPANY_ID}`).expect(200);
    expect(stage.body.stage.artifact).toBeNull();
  });

  it("publish refuses while any gate is incomplete (409 release_gates_incomplete), even for the board", async () => {
    const { server } = app(boardMember);
    await defineStage(server, [
      { key: "ci-green", completed: true },
      { key: "review-approved", completed: false },
    ]);
    const res = await request(server)
      .post(`/api/myrmidon/release-stages/${RELEASE_ID}/publish?companyId=${COMPANY_ID}`)
      .send({ publicationUrl: "https://releases.example.com/1.8.0" })
      .expect(409);
    expect(res.body.code).toBe("release_gates_incomplete");
    expect(res.body.incomplete).toEqual(["review-approved"]);
  });

  it("publish refuses an unsigned artifact (400 release_signature_required) even with complete gates", async () => {
    const { server } = app(boardMember);
    await defineStage(server, GOOD_GATES);
    const res = await request(server)
      .post(`/api/myrmidon/release-stages/${RELEASE_ID}/publish?companyId=${COMPANY_ID}`)
      .send({ publicationUrl: "https://releases.example.com/1.8.0" })
      .expect(400);
    expect(res.body.code).toBe("release_signature_required");
  });

  it("gates are immutable after publication (409) and unknown stages 404", async () => {
    const { server } = app(boardMember);
    await defineStage(server, GOOD_GATES);
    await request(server)
      .post(`/api/myrmidon/release-stages/${RELEASE_ID}/sign?companyId=${COMPANY_ID}`)
      .send({
        artifactId: "myrmidon-1.8.0",
        tag: "v2026.1114.1",
        version: "1.8.0-rc.1",
        composition: ["OPE-13005", "OPE-13008"],
        digest: "sha256:abc123",
        verificationUrl: "https://releases.example.com/1.8.0/verify",
      })
      .expect(200);
    await request(server)
      .post(`/api/myrmidon/release-stages/${RELEASE_ID}/publish?companyId=${COMPANY_ID}`)
      .send({ publicationUrl: "https://releases.example.com/1.8.0" })
      .expect(200);
    await request(server)
      .put(`/api/myrmidon/release-stages/${RELEASE_ID}/gates?companyId=${COMPANY_ID}`)
      .send({ gates: GOOD_GATES })
      .expect(409);

    const missing = await request(server)
      .get(`/api/myrmidon/release-stages/rel-other?companyId=${COMPANY_ID}`)
      .expect(404);
    expect(missing.body.code).toBe("release_stage_not_found");
  });
});
