// myrmidon(1.6.5 PROCS-0.1): the process registry — identity, staleness and the
// read the «Процессы» panel uses. Pins:
//   * the role comes from PAPERCLIP_PROCESS_ROLE, and anything unknown is the
//     single process (`all`), so mode=single keeps today's behaviour exactly;
//   * only a role that owns background timers reaps stale rows;
//   * a row is stale strictly past the window, never before it;
//   * the API answers a board member with the rows plus the self flag, refuses
//     an agent token, and never leaks the metrics of a stale row as live.

import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { errorHandler } from "../../middleware/index.js";
import {
  BOARD_PROCESS_PULSE_MS,
  BOARD_PROCESS_ROLES,
  BOARD_PROCESS_STALE_MS,
  boardProcessAgeSeconds,
  boardProcessBootId,
  boardProcessStatus,
  isBoardProcessStale,
  resolveBoardProcessContainer,
  resolveBoardProcessIdentity,
  resolveBoardProcessRole,
  roleOwnsBackgroundWork,
} from "./domain.js";
import { myrmidonBoardProcessRegistryRoutes } from "./routes.js";
import type { BoardProcessRow, BoardProcessStore } from "./store.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const AT = new Date("2026-10-08T12:00:00.000Z");

const member = {
  type: "board",
  source: "session",
  userId: "user-a",
  isInstanceAdmin: false,
  companyIds: [COMPANY_ID],
};
const agentActor = {
  type: "agent",
  source: "agent_key",
  agentId: "11111111-1111-4111-8111-111111111111",
  companyId: COMPANY_ID,
  keyId: "key-a",
};

function row(overrides: Partial<BoardProcessRow> = {}): BoardProcessRow {
  return {
    bootId: "boot-self",
    role: "all",
    pid: 4242,
    hostname: "board-1",
    container: "ctr-a",
    version: "1.6.6",
    startedAt: new Date("2026-10-08T11:00:00.000Z"),
    lastSeenAt: new Date("2026-10-08T11:59:55.000Z"),
    apiPort: 3100,
    eventLoopLagMs: 12.5,
    rssBytes: 512_000_000,
    ...overrides,
  };
}

function harness(rows: BoardProcessRow[]) {
  const store: BoardProcessStore = {
    heartbeat: async () => {},
    listProcesses: async () => rows,
    deleteStale: async () => 0,
  };
  const withActor = (actor: unknown) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = actor;
      next();
    });
    app.use(
      "/api",
      myrmidonBoardProcessRegistryRoutes({} as Db, { store, bootId: "boot-self", now: () => AT }),
    );
    app.use(errorHandler);
    return app;
  };
  return { withActor };
}

const URL = "/api/myrmidon/board-processes";

describe("board process registry: identity", () => {
  it("takes the role from PAPERCLIP_PROCESS_ROLE and falls back to the single process", () => {
    expect(BOARD_PROCESS_ROLES).toEqual(["all", "worker", "api"]);
    expect(resolveBoardProcessRole("worker")).toBe("worker");
    expect(resolveBoardProcessRole("API")).toBe("api");
    expect(resolveBoardProcessRole(" api ")).toBe("api");
    expect(resolveBoardProcessRole("")).toBe("all");
    expect(resolveBoardProcessRole(undefined)).toBe("all");
    expect(resolveBoardProcessRole("nonsense")).toBe("all");
  });

  it("lets only a role that owns timers reap, so an api child never deletes a row", () => {
    expect(roleOwnsBackgroundWork("all")).toBe(true);
    expect(roleOwnsBackgroundWork("worker")).toBe(true);
    expect(roleOwnsBackgroundWork("api")).toBe(false);
  });

  it("reads the container from the runtime, with the explicit override winning", () => {
    expect(resolveBoardProcessContainer({ HOSTNAME: "ctr-1" } as NodeJS.ProcessEnv)).toBe("ctr-1");
    expect(
      resolveBoardProcessContainer({
        HOSTNAME: "ctr-1",
        MYRMIDON_PROCESS_CONTAINER: "board-primary",
      } as NodeJS.ProcessEnv),
    ).toBe("board-primary");
    expect(resolveBoardProcessContainer({} as NodeJS.ProcessEnv)).toBe(null);
    expect(resolveBoardProcessContainer({ HOSTNAME: "  " } as NodeJS.ProcessEnv)).toBe(null);
  });

  it("resolves this process once: a uuid boot id, this pid and this role", () => {
    const identity = resolveBoardProcessIdentity({ version: "1.6.6" });
    expect(identity.bootId).toBe(boardProcessBootId);
    expect(identity.bootId).toMatch(/^[0-9a-f-]{36}$/);
    expect(identity.role).toBe(resolveBoardProcessRole());
    expect(identity.pid).toBe(process.pid);
    expect(identity.version).toBe("1.6.6");
    expect(identity.apiPort).toBe(null);
    expect(identity.startedAt).toBeInstanceOf(Date);
  });

  it("takes every field from the options when they are given", () => {
    const identity = resolveBoardProcessIdentity({
      version: "1.6.6",
      role: "worker",
      bootId: "boot-b",
      pid: 7,
      hostname: "board-2",
      container: "ctr-b",
      startedAt: new Date("2026-10-08T10:00:00.000Z"),
      apiPort: 3101,
    });
    expect(identity).toEqual({
      bootId: "boot-b",
      role: "worker",
      pid: 7,
      hostname: "board-2",
      container: "ctr-b",
      version: "1.6.6",
      startedAt: new Date("2026-10-08T10:00:00.000Z"),
      apiPort: 3101,
    });
  });
});

describe("board process registry: staleness", () => {
  it("keeps the documented cadence: 10 s pulse, 2 min window", () => {
    expect(BOARD_PROCESS_PULSE_MS).toBe(10_000);
    expect(BOARD_PROCESS_STALE_MS).toBe(120_000);
  });

  it("is stale strictly past the window, so the last pulse of a live process never counts as gone", () => {
    const exactly = new Date(AT.getTime() - BOARD_PROCESS_STALE_MS);
    expect(isBoardProcessStale(exactly, AT)).toBe(false);
    expect(boardProcessStatus(exactly, AT)).toBe("live");
    const past = new Date(AT.getTime() - BOARD_PROCESS_STALE_MS - 1);
    expect(isBoardProcessStale(past, AT)).toBe(true);
    expect(boardProcessStatus(past, AT)).toBe("stale");
    expect(isBoardProcessStale(new Date(AT.getTime()), AT)).toBe(false);
  });

  it("honours a narrower window when one is passed", () => {
    const oneMinuteAgo = new Date(AT.getTime() - 60_000);
    expect(isBoardProcessStale(oneMinuteAgo, AT, 30_000)).toBe(true);
    expect(isBoardProcessStale(oneMinuteAgo, AT)).toBe(false);
  });

  it("reports the age in whole seconds and never negative", () => {
    expect(boardProcessAgeSeconds(new Date(AT.getTime() - 5_400), AT)).toBe(5);
    expect(boardProcessAgeSeconds(new Date(AT.getTime() - 1_999), AT)).toBe(1);
    expect(boardProcessAgeSeconds(new Date(AT.getTime() + 5_000), AT)).toBe(0);
  });
});

describe("board process registry routes", () => {
  it("answers a board member with every row, the cadence and the self flag", async () => {
    const h = harness([
      row(),
      row({
        bootId: "boot-old",
        role: "api",
        lastSeenAt: new Date(AT.getTime() - 300_000),
        eventLoopLagMs: 1,
      }),
    ]);
    const res = await request(h.withActor(member)).get(URL).expect(200);
    expect(res.body.selfBootId).toBe("boot-self");
    expect(res.body.pulseSeconds).toBe(10);
    expect(res.body.staleAfterSeconds).toBe(120);
    expect(res.body.processes).toHaveLength(2);

    const [self, gone] = res.body.processes;
    expect(self).toEqual({
      bootId: "boot-self",
      role: "all",
      pid: 4242,
      hostname: "board-1",
      container: "ctr-a",
      version: "1.6.6",
      startedAt: "2026-10-08T11:00:00.000Z",
      lastSeenAt: "2026-10-08T11:59:55.000Z",
      uptimeSeconds: 3600,
      ageSeconds: 5,
      apiPort: 3100,
      eventLoopLagMs: 12.5,
      rssBytes: 512_000_000,
      status: "live",
      self: true,
    });
    expect(gone.status).toBe("stale");
    expect(gone.self).toBe(false);
    expect(gone.ageSeconds).toBe(300);
  });

  it("refuses an agent token", async () => {
    const h = harness([row()]);
    await request(h.withActor(agentActor)).get(URL).expect(403);
  });
});
