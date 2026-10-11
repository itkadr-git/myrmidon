// myrmidon(1.6.6 PROCS-1.7 part A): GET /api/myrmidon/processes/leases — the read the
// lease block of the «Процессы» panel polls. Pins:
//   * a single-process board (no lease rows) answers an empty list with its
//     own boot id, so the panel shows the single-process state;
//   * a held lease is joined to its holder's registry row and flagged isSelf
//     only for the process that answers;
//   * the deadline decides `expired`, a lease with no deadline never expires;
//   * a lease whose holder row is gone keeps holder null (no exception);
//   * epoch and timestamps reach the wire as the UI contract expects;
//   * an agent token is refused.

import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { errorHandler } from "../../middleware/index.js";
import type { BoardLeaseRow, BoardLeaseStore } from "./leases.js";
import { serializeBoardLeases } from "./leases.js";
import { myrmidonBoardProcessRegistryRoutes } from "./routes.js";
import type { BoardProcessRow, BoardProcessStore } from "./store.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const AT = new Date("2026-10-08T21:00:30.000Z");
const URL = "/api/myrmidon/processes/leases";

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

function proc(overrides: Partial<BoardProcessRow> = {}): BoardProcessRow {
  return {
    bootId: "boot-self",
    role: "worker",
    pid: 4242,
    hostname: "board-1",
    container: "ctr-a",
    version: "1.6.5",
    startedAt: new Date("2026-10-08T20:00:00.000Z"),
    lastSeenAt: new Date("2026-10-08T21:00:28.000Z"),
    apiPort: null,
    eventLoopLagMs: 3,
    rssBytes: 1,
    ...overrides,
  };
}

function lease(overrides: Partial<BoardLeaseRow> = {}): BoardLeaseRow {
  return {
    name: "scheduler",
    holderBootId: "boot-self",
    epoch: 12,
    acquiredAt: new Date("2026-10-08T21:00:00.000Z"),
    expiresAt: new Date("2026-10-08T21:01:00.000Z"),
    ...overrides,
  };
}

function appFor(actor: unknown, leases: BoardLeaseRow[], processes: BoardProcessRow[]) {
  const store: BoardProcessStore = {
    heartbeat: async () => {},
    listProcesses: async () => processes,
    deleteStale: async () => 0,
  };
  const leaseStore: BoardLeaseStore = { listLeases: async () => leases };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  app.use(
    "/api",
    myrmidonBoardProcessRegistryRoutes({} as Db, {
      store,
      leaseStore,
      bootId: "boot-self",
      now: () => AT,
    }),
  );
  app.use(errorHandler);
  return app;
}

describe("board leases route", () => {
  it("answers an empty list with its own boot id on a single-process board", async () => {
    const res = await request(appFor(member, [], [proc()])).get(URL).expect(200);
    expect(res.body).toEqual({
      leases: [],
      selfBootId: "boot-self",
      serverTime: "2026-10-08T21:00:30.000Z",
    });
  });

  it("joins a held lease to its holder and marks only the answering process as self", async () => {
    const res = await request(
      appFor(
        member,
        [lease(), lease({ name: "backup", holderBootId: "boot-other", epoch: 3 })],
        [proc(), proc({ bootId: "boot-other", role: "api", pid: 4243, container: null })],
      ),
    )
      .get(URL)
      .expect(200);
    const [scheduler, backup] = res.body.leases;
    expect(scheduler).toEqual({
      name: "scheduler",
      holderBootId: "boot-self",
      epoch: 12,
      acquiredAt: "2026-10-08T21:00:00.000Z",
      expiresAt: "2026-10-08T21:01:00.000Z",
      expired: false,
      isSelf: true,
      holder: {
        bootId: "boot-self",
        role: "worker",
        pid: 4242,
        hostname: "board-1",
        container: "ctr-a",
        version: "1.6.5",
        lastSeenAt: "2026-10-08T21:00:28.000Z",
      },
    });
    expect(backup.isSelf).toBe(false);
    expect(backup.holder.bootId).toBe("boot-other");
    expect(backup.holder.container).toBe(null);
  });

  it("refuses an agent token", async () => {
    await request(appFor(agentActor, [lease()], [proc()])).get(URL).expect(403);
  });
});

describe("serializeBoardLeases", () => {
  const base = { processes: [proc()], bootId: "boot-self", at: AT };

  it("flags a lease expired strictly at or past its deadline, never before", () => {
    const view = serializeBoardLeases({
      ...base,
      leases: [
        lease({ name: "a", expiresAt: new Date(AT.getTime() + 1) }),
        lease({ name: "b", expiresAt: new Date(AT.getTime()) }),
        lease({ name: "c", expiresAt: new Date(AT.getTime() - 1) }),
      ],
    });
    expect(view.leases.map((l) => l.expired)).toEqual([false, true, true]);
  });

  it("keeps an unheld lease (no holder, no deadline) as not expired and not self", () => {
    const [view] = serializeBoardLeases({
      ...base,
      leases: [lease({ holderBootId: null, epoch: 0, acquiredAt: null, expiresAt: null })],
    }).leases;
    expect(view).toMatchObject({
      holderBootId: null,
      epoch: 0,
      acquiredAt: null,
      expiresAt: null,
      expired: false,
      isSelf: false,
      holder: null,
    });
  });

  it("keeps holder null when the holder's registry row has been reaped", () => {
    const [view] = serializeBoardLeases({
      ...base,
      leases: [lease({ holderBootId: "boot-gone" })],
    }).leases;
    expect(view.holderBootId).toBe("boot-gone");
    expect(view.holder).toBeNull();
    expect(view.isSelf).toBe(false);
  });
});
