// myrmidon(1.7 AUTO-UPDATE-SETTINGS, OPE-10186): tests for /api/system/check-updates routes
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { systemUpdatesRoutes } from "./system-updates.js";

function createTestApp(actor: any = { type: "board", source: "local_implicit", isInstanceAdmin: true }, deps?: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", systemUpdatesRoutes(deps));
  // Error handler middleware to format errors standardly
  app.use((err: any, _req: any, res: any, _next: any) => {
    const status = err.status || err.statusCode || 400;
    res.status(status).json({
      error: err.message || "Bad Request",
      code: err.code,
      details: err.details,
    });
  });
  return app;
}

describe("systemUpdatesRoutes (/api/system/check-updates)", () => {
  const mockBuildInfo = () => ({
    version: "1.6.6",
    commit: "0123456",
    imageDigest: "sha256:current",
  });

  it("handles GET /api/system/check-updates with default channel", async () => {
    const mockFetch = async () => ({
      tag_name: "myr-v1.7.0",
      html_url: "https://github.com/itkadr-git/myrmidon/releases/tag/myr-v1.7.0",
      body: "New release 1.7.0",
      published_at: "2026-10-31T00:00:00Z",
    });

    const app = createTestApp(
      { type: "board", source: "local_implicit", isInstanceAdmin: true },
      { buildInfo: mockBuildInfo, fetchJson: mockFetch },
    );

    const res = await request(app).get("/api/system/check-updates");
    expect(res.status).toBe(200);
    expect(res.body.currentVersion).toBe("1.6.6");
    expect(res.body.latestVersion).toBe("1.7.0");
    expect(res.body.updateAvailable).toBe(true);
    expect(res.body.channel).toBe("stable");
    expect(res.body.releaseTag).toBe("myr-v1.7.0");
  });

  it("handles GET query params (?channel=rc&force=true)", async () => {
    const mockFetch = async () => [
      {
        tag_name: "myr-v1.7.0-rc.1",
        html_url: "https://github.com/itkadr-git/myrmidon/releases/tag/myr-v1.7.0-rc.1",
        body: "Release candidate 1",
        published_at: "2026-10-30T12:00:00Z",
      },
    ];

    const app = createTestApp(
      { type: "board", source: "local_implicit", isInstanceAdmin: true },
      { buildInfo: mockBuildInfo, fetchJson: mockFetch },
    );

    const res = await request(app).get("/api/system/check-updates?channel=rc&force=true");
    expect(res.status).toBe(200);
    expect(res.body.channel).toBe("rc");
    expect(res.body.latestVersion).toBe("1.7.0-rc.1");
    expect(res.body.updateAvailable).toBe(true);
  });

  it("handles POST /api/system/check-updates with valid body", async () => {
    const mockFetch = async () => ({
      tag_name: "myr-v1.6.6",
      html_url: "https://github.com/itkadr-git/myrmidon/releases/tag/myr-v1.6.6",
      body: "Current release",
      published_at: "2026-10-01T00:00:00Z",
    });

    const app = createTestApp(
      { type: "board", source: "local_implicit", isInstanceAdmin: true },
      { buildInfo: mockBuildInfo, fetchJson: mockFetch },
    );

    const res = await request(app)
      .post("/api/system/check-updates")
      .send({ channel: "stable", force: true });

    expect(res.status).toBe(200);
    expect(res.body.currentVersion).toBe("1.6.6");
    expect(res.body.latestVersion).toBe("1.6.6");
    expect(res.body.updateAvailable).toBe(false);
  });

  it("handles POST /api/system/check-updates with canary channel and commit hash", async () => {
    const mockFetch = async () => ({
      sha: "9999999",
      html_url: "https://github.com/itkadr-git/myrmidon/commit/9999999",
      commit: {
        message: "feat: new commit on main",
        author: { date: "2026-10-31T05:00:00Z" },
      },
    });

    const app = createTestApp(
      { type: "board", source: "local_implicit", isInstanceAdmin: true },
      { buildInfo: mockBuildInfo, fetchJson: mockFetch },
    );

    const res = await request(app)
      .post("/api/system/check-updates")
      .send({ channel: "canary", force: true });

    expect(res.status).toBe(200);
    expect(res.body.channel).toBe("canary");
    expect(res.body.latestCommit).toBe("9999999");
    expect(res.body.updateAvailable).toBe(true);
  });

  it("rejects invalid input with 400 error format", async () => {
    const app = createTestApp();

    const res = await request(app)
      .post("/api/system/check-updates")
      .send({ channel: "nonexistent-channel" });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  it("rejects unknown fields with strict validation", async () => {
    const app = createTestApp();

    const res = await request(app)
      .post("/api/system/check-updates")
      .send({ unexpectedField: "value" });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  it("rejects unauthenticated caller with 403", async () => {
    const app = createTestApp({ type: "anonymous" });

    const res = await request(app).get("/api/system/check-updates");
    expect(res.status).toBe(403);
  });

  it("works with aliases /api/myrmidon/system/check-updates and /api/instance-settings/check-updates", async () => {
    const mockFetch = async () => ({
      tag_name: "myr-v1.7.0",
    });
    const app = createTestApp(
      { type: "board", source: "local_implicit", isInstanceAdmin: true },
      { buildInfo: mockBuildInfo, fetchJson: mockFetch },
    );

    const res1 = await request(app).get("/api/myrmidon/system/check-updates");
    expect(res1.status).toBe(200);

    const res2 = await request(app).post("/api/instance-settings/check-updates").send({});
    expect(res2.status).toBe(200);
  });
});
