// server/src/__tests__/release-flaky-work.integration.test.ts
//
// myrmidon(1.8 RELEASE-STAGE): Integration tests for flaky CI work REST routes (OPE-13066).

import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../middleware/index.js";
import {
  ReleaseFlakyWorkService,
  myrmidonReleaseFlakyWorkRoutes,
} from "../myrmidon/release-flaky-work/index.js";

function createTestApp(actor = { type: "board", source: "local_implicit", isInstanceAdmin: true }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  const service = new ReleaseFlakyWorkService();
  const api = express.Router();
  api.use(myrmidonReleaseFlakyWorkRoutes(undefined, service));
  app.use("/api", api);
  app.use(errorHandler);
  return { app, service };
}

describe("release-flaky-work integration (OPE-13066)", () => {
  const releaseId = "rel-v1.8.0-rc1";

  it("returns initial clean gate state when no flaky jobs exist", async () => {
    const { app } = createTestApp();
    const res = await request(app).get(`/api/myrmidon/release-stages/${releaseId}/flaky-work`);

    expect(res.status).toBe(200);
    expect(res.body.releaseId).toBe(releaseId);
    expect(res.body.canResume).toBe(true);
    expect(res.body.gateStatus).toBe("passed");
    expect(res.body.jobs).toEqual([]);
    expect(res.body.waivers).toEqual([]);
  });

  it("blocks release gate when a failed flaky job is reported", async () => {
    const { app } = createTestApp();

    const reportRes = await request(app)
      .post(`/api/myrmidon/release-stages/${releaseId}/flaky-work/jobs`)
      .send({
        jobName: "unit-tests-linux",
        headSha: "abc1234",
        attempt: 1,
        failureDetail: "Timeout in async queue test",
      });

    expect(reportRes.status).toBe(201);
    expect(reportRes.body.canResume).toBe(false);
    expect(reportRes.body.gateStatus).toBe("blocked");
    expect(reportRes.body.blockingReason).toContain("unit-tests-linux");
    expect(reportRes.body.jobs).toHaveLength(1);
    expect(reportRes.body.jobs[0].status).toBe("failed");
  });

  it("rejects resumption while flaky job is unresolved", async () => {
    const { app } = createTestApp();

    await request(app)
      .post(`/api/myrmidon/release-stages/${releaseId}/flaky-work/jobs`)
      .send({
        jobName: "e2e-suite",
        headSha: "abc1234",
        attempt: 1,
      });

    const resumeRes = await request(app)
      .post(`/api/myrmidon/release-stages/${releaseId}/flaky-work/resume`)
      .send({});

    expect(resumeRes.status).toBe(409);
    expect(resumeRes.body.error).toContain("blocked");
  });

  it("validates evidence: rejects waiver when headSha or attempt mismatches target job", async () => {
    const { app } = createTestApp();

    await request(app)
      .post(`/api/myrmidon/release-stages/${releaseId}/flaky-work/jobs`)
      .send({
        jobName: "docker-build",
        headSha: "abc1234",
        attempt: 1,
      });

    // Mismatched headSha
    const mismatchShaRes = await request(app)
      .post(`/api/myrmidon/release-stages/${releaseId}/flaky-work/waiver`)
      .send({
        job: "docker-build",
        reason: "Known transient DNS issue in base runner",
        evidence: {
          headSha: "wrong-sha",
          job: "docker-build",
          attempt: 1,
        },
      });

    expect(mismatchShaRes.status).toBe(400);
    expect(mismatchShaRes.body.error).toContain("headSha");

    // Mismatched attempt
    const mismatchAttemptRes = await request(app)
      .post(`/api/myrmidon/release-stages/${releaseId}/flaky-work/waiver`)
      .send({
        job: "docker-build",
        reason: "Known transient DNS issue in base runner",
        evidence: {
          headSha: "abc1234",
          job: "docker-build",
          attempt: 99,
        },
      });

    expect(mismatchAttemptRes.status).toBe(400);
    expect(mismatchAttemptRes.body.error).toContain("attempt");
  });

  it("accepts valid evidence-backed waiver and resumes gate", async () => {
    const { app } = createTestApp();

    await request(app)
      .post(`/api/myrmidon/release-stages/${releaseId}/flaky-work/jobs`)
      .send({
        jobName: "flaky-integration-test",
        headSha: "fedcba0",
        attempt: 2,
      });

    const waiverRes = await request(app)
      .post(`/api/myrmidon/release-stages/${releaseId}/flaky-work/waiver`)
      .send({
        job: "flaky-integration-test",
        reason: "Known race condition in test harness, independent of release code",
        evidence: {
          headSha: "fedcba0",
          job: "flaky-integration-test",
          attempt: 2,
          url: "https://github.com/itkadr-git/myrmidon/actions/runs/1000",
        },
      });

    expect(waiverRes.status).toBe(201);
    expect(waiverRes.body.canResume).toBe(true);
    expect(waiverRes.body.jobs[0].status).toBe("waived");
    expect(waiverRes.body.waivers).toHaveLength(1);

    const resumeRes = await request(app)
      .post(`/api/myrmidon/release-stages/${releaseId}/flaky-work/resume`)
      .send({});

    expect(resumeRes.status).toBe(200);
    expect(resumeRes.body.gateStatus).toBe("resumed");
    expect(resumeRes.body.resumedAt).toBeTruthy();
  });

  it("allows gate resumption after a successful retry of failed job", async () => {
    const { app } = createTestApp();

    const reportRes = await request(app)
      .post(`/api/myrmidon/release-stages/${releaseId}/flaky-work/jobs`)
      .send({
        jobName: "deploy-dryrun",
        headSha: "sha9999",
        attempt: 1,
      });

    const jobId = reportRes.body.jobs[0].id;
    expect(reportRes.body.canResume).toBe(false);

    // Retrying with green result
    const retryRes = await request(app)
      .post(`/api/myrmidon/release-stages/${releaseId}/flaky-work/retry`)
      .send({
        jobId,
        outcome: "success",
      });

    expect(retryRes.status).toBe(200);
    expect(retryRes.body.canResume).toBe(true);
    expect(retryRes.body.jobs[0].status).toBe("success");
    expect(retryRes.body.jobs[0].attempt).toBe(2);

    // Gate can now be resumed cleanly
    const resumeRes = await request(app)
      .post(`/api/myrmidon/release-stages/${releaseId}/flaky-work/resume`)
      .send({});

    expect(resumeRes.status).toBe(200);
    expect(resumeRes.body.gateStatus).toBe("resumed");
  });
});
