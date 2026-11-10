// server/src/myrmidon/cto-chat/report-route.myrmidon.test.ts
//
// myrmidon(1.7-ACTIVE-CHANNEL): Route tests for the Commander report delivery
// endpoint (POST /myrmidon/cto-chat/report). The delivery service is mocked so
// the route's contract is verified in isolation: it reads the company scope,
// resolves the owner, and hands the report to the production routing service.

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@myrmidon/db";

vi.mock("./report-delivery.js", () => ({
  deliverCommanderReportForDb: vi.fn(),
}));

import { deliverCommanderReportForDb } from "./report-delivery.js";
import { myrmidonCtoChatRoutes } from "./routes.js";

const deliverCommanderReportForDbMock = vi.mocked(deliverCommanderReportForDb);

describe("POST /myrmidon/cto-chat/report", () => {
  beforeEach(() => {
    deliverCommanderReportForDbMock.mockReset();
  });

  function createApp(mockDb: Db) {
    const app = express();
    app.use(express.json());
    // Attach a board actor, the same shape the auth middleware produces.
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        source: "local_implicit",
        isInstanceAdmin: true,
        userId: "user-test-1",
        companyId: "comp-test-1",
      };
      next();
    });
    app.use(
      myrmidonCtoChatRoutes(mockDb, {
        enabled: true,
        baseUrl: "https://example.com",
        keySecret: "sec",
        model: "m",
        timeoutMs: 1000,
        maxTasks: 4,
      }),
    );
    return app;
  }

  it("returns 400 when reportText is missing or empty", async () => {
    const mockDb = {} as unknown as Db;
    const app = createApp(mockDb);

    const res = await request(app)
      .post("/myrmidon/cto-chat/report?companyId=comp-test-1")
      .send({ title: "No text" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("bad_request");
    expect(deliverCommanderReportForDbMock).not.toHaveBeenCalled();
  });

  it("routes report to web when active channel is web", async () => {
    const mockDb = {} as unknown as Db;
    const app = createApp(mockDb);

    deliverCommanderReportForDbMock.mockResolvedValueOnce({
      targetChannel: "web",
      delivered: true,
      destination: "web:notification:comp-test-1",
      channelResolved: "web",
    });

    const res = await request(app)
      .post("/myrmidon/cto-chat/report?companyId=comp-test-1")
      .send({
        ownerUserId: "user-owner-1",
        reportText: "Commander report: progress on plan",
        title: "Report",
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      targetChannel: "web",
      delivered: true,
      destination: "web:notification:comp-test-1",
      channelResolved: "web",
    });
    expect(deliverCommanderReportForDbMock).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({
        companyId: "comp-test-1",
        ownerUserId: "user-owner-1",
        reportText: "Commander report: progress on plan",
        title: "Report",
      }),
    );
  });

  it("routes report to Telegram when active channel is telegram", async () => {
    const mockDb = {} as unknown as Db;
    const app = createApp(mockDb);

    deliverCommanderReportForDbMock.mockResolvedValueOnce({
      targetChannel: "telegram",
      delivered: true,
      destination: "telegram:publication:pub-123",
      channelResolved: "telegram",
    });

    const res = await request(app)
      .post("/myrmidon/cto-chat/report?companyId=comp-test-1")
      .send({
        ownerUserId: "user-owner-1",
        reportText: "Commander report for Telegram",
      });

    expect(res.status).toBe(200);
    expect(res.body.targetChannel).toBe("telegram");
    expect(res.body.destination).toBe("telegram:publication:pub-123");
    expect(deliverCommanderReportForDbMock).toHaveBeenCalledTimes(1);
  });

  it("routes report to default behavior when active channel is null", async () => {
    const mockDb = {} as unknown as Db;
    const app = createApp(mockDb);

    deliverCommanderReportForDbMock.mockResolvedValueOnce({
      targetChannel: "default",
      delivered: true,
      destination: "default:board:comp-test-1",
      channelResolved: null,
    });

    const res = await request(app)
      .post("/myrmidon/cto-chat/report?companyId=comp-test-1")
      .send({
        ownerUserId: "user-owner-1",
        reportText: "Commander report default fallback",
      });

    expect(res.status).toBe(200);
    expect(res.body.targetChannel).toBe("default");
    expect(res.body.destination).toBe("default:board:comp-test-1");
    expect(deliverCommanderReportForDbMock).toHaveBeenCalledTimes(1);
  });

  it("uses the board actor userId when ownerUserId is omitted", async () => {
    const mockDb = {} as unknown as Db;
    const app = createApp(mockDb);

    deliverCommanderReportForDbMock.mockResolvedValueOnce({
      targetChannel: "web",
      delivered: true,
      destination: "web:notification:comp-test-1",
      channelResolved: "web",
    });

    const res = await request(app)
      .post("/myrmidon/cto-chat/report?companyId=comp-test-1")
      .send({ reportText: "Actor-scoped report" });

    expect(res.status).toBe(200);
    expect(deliverCommanderReportForDbMock).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({
        ownerUserId: "user-test-1",
      }),
    );
  });

  it("returns 500 when the delivery service throws", async () => {
    const mockDb = {} as unknown as Db;
    const app = createApp(mockDb);

    deliverCommanderReportForDbMock.mockRejectedValueOnce(new Error("store unreachable"));

    const res = await request(app)
      .post("/myrmidon/cto-chat/report?companyId=comp-test-1")
      .send({ ownerUserId: "user-owner-1", reportText: "Boom" });

    expect(res.status).toBe(500);
    expect(res.body.code).toBe("report_delivery_failed");
  });
});
