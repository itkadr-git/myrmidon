// myrmidon(BROWSER-CONSOLE): route tests — plain fakes, no database.
// Covers the authorization contract (401 unauthenticated, 403 agent and
// non-owner, owner passes), the registry list, the screen lifecycle over
// HTTP, the journal shape and the domain validation of the data clear.

import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../middleware/index.js";
import { browserConsoleRoutes } from "./routes.js";
import { BrowserConsoleError, type BrowserConsoleService } from "./service.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";

const owner = {
  type: "board",
  source: "session",
  userId: "user-owner",
  isInstanceAdmin: false,
  companyIds: [COMPANY_ID],
  memberships: [{ companyId: COMPANY_ID, status: "active", membershipRole: "owner" }],
};
const member = {
  type: "board",
  source: "session",
  userId: "user-member",
  isInstanceAdmin: false,
  companyIds: [COMPANY_ID],
  memberships: [{ companyId: COMPANY_ID, status: "active", membershipRole: "member" }],
};
const agentActor = { type: "agent", source: "agent_key", agentId: "11111111-1111-4111-8111-111111111111", companyId: COMPANY_ID, keyId: "key-a" };
const anonymous = { type: "none" };

function serviceMock(overrides: Partial<BrowserConsoleService> = {}): BrowserConsoleService {
  const calls = { open: 0, done: 0, clear: 0 };
  const base = {
    fleet: vi.fn(() => []),
    timers: { idleTimeoutMs: 30 * 60_000, maxDurationMs: 120 * 60_000 },
    listBrowsers: vi.fn(async () => [
      { id: "browser-a", displayName: "Live browser A", egress: { ru: "socks ru1" }, sessionActive: false, usedBy: null, sessionStartedAt: null },
    ]),
    openScreen: vi.fn(async () => {
      calls.open += 1;
      return {
        screenSessionId: "session-a",
        screenPath: "/api/myrmidon/browsers/browser-a/screen",
        deadlines: { idleDeadlineAt: 1, maxDeadlineAt: 2, autoCloseAt: 1, warnAt: 1 - 60_000 },
      };
    }),
    status: vi.fn(async () => null),
    heartbeat: vi.fn(async () => ({ deadlines: { idleDeadlineAt: 1, maxDeadlineAt: 2, autoCloseAt: 1, warnAt: 0 }, closedBy: null })),
    done: vi.fn(async () => {
      calls.done += 1;
    }),
    clearSiteData: vi.fn(async () => {
      calls.clear += 1;
    }),
    consoleToken: vi.fn(async () => ({
      screenSessionId: "session-a",
      token: "blob",
      consoleUrl: "https://guac.invalid/#/?data=blob",
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    })),
    journal: vi.fn(async () => [
      { sessionId: "session-a", browserId: "browser-a", userId: "user-owner", openedAt: 0, endedAt: 5 * 60_000, durationMs: 5 * 60_000, closedBy: "done" as const },
    ]),
    assertBrowserScreenFreeForMcp: vi.fn(async () => {}),
  };
  return { ...base, ...overrides } as unknown as BrowserConsoleService & typeof base;
}

function app(actor: unknown, service: BrowserConsoleService) {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  server.use("/api", browserConsoleRoutes({ service }));
  server.use(errorHandler);
  return server;
}

const query = `?companyId=${COMPANY_ID}`;

describe("myrmidon(BROWSER-CONSOLE) routes: authorization", () => {
  it("unauthenticated requests get 401 on every route", async () => {
    const service = serviceMock();
    const server = app(anonymous, service);
    await request(server).get("/api/myrmidon/browsers").expect(401);
    await request(server).get("/api/myrmidon/browsers/journal").expect(401);
    await request(server).post(`/api/myrmidon/browsers/browser-a/screen/open${query}`).send({}).expect(401);
    await request(server).post(`/api/myrmidon/browsers/browser-a/screen/heartbeat${query}`).send({}).expect(401);
    await request(server).post(`/api/myrmidon/browsers/browser-a/screen/done${query}`).send({}).expect(401);
    await request(server).delete(`/api/myrmidon/browsers/browser-a/data${query}`).send({ domain: "example.com" }).expect(401);
  });

  it("agents read the registry but never the screen, the data clear or the journal", async () => {
    const service = serviceMock();
    const server = app(agentActor, service);
    await request(server).get("/api/myrmidon/browsers").expect(200);
    await request(server).get("/api/myrmidon/browsers/journal").expect(403);
    await request(server).post(`/api/myrmidon/browsers/browser-a/screen/open${query}`).send({}).expect(403);
    await request(server).delete(`/api/myrmidon/browsers/browser-a/data${query}`).send({ domain: "example.com" }).expect(403);
    expect(service.openScreen).not.toHaveBeenCalled();
  });

  it("a member (not owner) reads the registry but is refused the owner surface", async () => {
    const service = serviceMock();
    const server = app(member, service);
    await request(server).get("/api/myrmidon/browsers").expect(200);
    await request(server).get("/api/myrmidon/browsers/journal").expect(403);
    await request(server).post(`/api/myrmidon/browsers/browser-a/screen/open${query}`).send({}).expect(403);
    await request(server).delete(`/api/myrmidon/browsers/browser-a/data${query}`).send({ domain: "example.com" }).expect(403);
  });

  it("the owner passes: open answers the deadline fields, done and journal work", async () => {
    const service = serviceMock();
    const server = app(owner, service);
    const list = await request(server).get("/api/myrmidon/browsers").expect(200);
    expect(list.body.browsers[0]).toMatchObject({ id: "browser-a", displayName: "Live browser A", egress: { ru: "socks ru1" } });

    const opened = await request(server).post(`/api/myrmidon/browsers/browser-a/screen/open${query}`).send({}).expect(200);
    expect(opened.body).toMatchObject({
      screenSessionId: "session-a",
      screenPath: "/api/myrmidon/browsers/browser-a/screen",
      idleDeadlineAt: new Date(1).toISOString(),
      warnAt: new Date(1 - 60_000).toISOString(),
    });

    await request(server).post(`/api/myrmidon/browsers/browser-a/screen/heartbeat${query}`).send({ activity: true }).expect(200);
    await request(server).post(`/api/myrmidon/browsers/browser-a/screen/done${query}`).send({}).expect(200);
    expect(service.done).toHaveBeenCalledWith("browser-a", "user-owner");

    const journal = await request(server).get(`/api/myrmidon/browsers/journal${query}`).expect(200);
    expect(journal.body.entries[0]).toMatchObject({
      browserId: "browser-a",
      userId: "user-owner",
      durationMs: 5 * 60_000,
      closedBy: "done",
    });
    expect(journal.body.entries[0].startedAt).toBeTypeOf("string");
    expect(journal.body.entries[0].endedAt).toBeTypeOf("string");
  });

  it("the data clear validates the domain: bare domains pass, URLs and junk do not", async () => {
    const service = serviceMock();
    const server = app(owner, service);
    await request(server).delete(`/api/myrmidon/browsers/browser-a/data${query}`).send({ domain: "example.com" }).expect(200);
    await request(server).delete(`/api/myrmidon/browsers/browser-a/data${query}`).send({ domain: "https://example.com" }).expect(400);
    await request(server).delete(`/api/myrmidon/browsers/browser-a/data${query}`).send({ domain: "example.com/path" }).expect(400);
    await request(server).delete(`/api/myrmidon/browsers/browser-a/data${query}`).send({ domain: "" }).expect(400);
    await request(server).delete(`/api/myrmidon/browsers/browser-a/data${query}`).send({ domain: "localhost" }).expect(400);
    expect(service.clearSiteData).toHaveBeenCalledTimes(1);
    expect(service.clearSiteData).toHaveBeenCalledWith("browser-a", "example.com");
  });

  it("heartbeat requires a boolean activity field", async () => {
    const service = serviceMock();
    const server = app(owner, service);
    await request(server).post(`/api/myrmidon/browsers/browser-a/screen/heartbeat${query}`).send({ activity: "yes" }).expect(400);
    await request(server).post(`/api/myrmidon/browsers/browser-a/screen/heartbeat${query}`).send({}).expect(200);
  });
});

describe("myrmidon(BROWSER-CONSOLE) routes: part-B console token", () => {
  const tokenPath = `/api/myrmidon/browsers/browser-a/screen/console-token${query}`;

  it("anonymous, agent and member are refused; the owner gets the issued URL", async () => {
    const service = serviceMock();
    await request(app(anonymous, service)).post(tokenPath).send({}).expect(401);
    await request(app(agentActor, service)).post(tokenPath).send({}).expect(403);
    await request(app(member, service)).post(tokenPath).send({}).expect(403);
    const issued = await request(app(owner, service)).post(tokenPath).send({}).expect(200);
    expect(issued.body).toMatchObject({ screenSessionId: "session-a", token: "blob", consoleUrl: "https://guac.invalid/#/?data=blob" });
    expect(issued.body.expiresAt).toBeTypeOf("string");
    expect(service.consoleToken).toHaveBeenCalledWith({ browserId: "browser-a", userId: "user-owner", companyId: COMPANY_ID });
  });

  it("no open session: 409 with the stable code in details", async () => {
    const service = serviceMock({
      consoleToken: vi.fn(async () => {
        throw new BrowserConsoleError(409, "Open the screen before requesting a console token", "screen_session_required");
      }) as unknown as BrowserConsoleService["consoleToken"],
    });
    const res = await request(app(owner, service)).post(tokenPath).send({}).expect(409);
    expect(res.body).toMatchObject({ code: "screen_session_required" });
  });

  it("unconfigured console: 503 console_not_configured", async () => {
    const service = serviceMock({
      consoleToken: vi.fn(async () => {
        throw new BrowserConsoleError(503, "The instance has no VNC target configured", "console_not_configured");
      }) as unknown as BrowserConsoleService["consoleToken"],
    });
    const res = await request(app(owner, service)).post(tokenPath).send({}).expect(503);
    expect(res.body).toMatchObject({ code: "console_not_configured" });
  });
});
