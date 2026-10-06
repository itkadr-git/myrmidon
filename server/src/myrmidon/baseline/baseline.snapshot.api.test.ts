// server/src/myrmidon/baseline/baseline.snapshot.api.test.ts
//
// myrmidon(1.6-BASELINE): the snapshot write/read API contract.
//
// The route half only: an express app with the real router, a board/agent/
// anonymous actor injected by a middleware, and the smallest in-memory stand-in
// for the drizzle calls the routes make. It pins down the status codes, the
// board-only gate, the company gate, the pin-clearing update and the exact row
// shape the API answers with — the shape
// `docs/myrmidon/guides/baseline-snapshots-api.md` documents.
//
// The numbers themselves are covered by baseline.myrmidon.test.ts; the live
// database half is baseline.db.myrmidon.test.ts.
//
// Neutral data only: company ids; no host names, no board ids.

import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { baselineRoutes } from "./routes.js";
import type { BaselineMetricsResponse } from "./service.js";
import type { BaselineWindow } from "./metrics.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY = "99999999-9999-4999-8999-999999999999";

const NOW = new Date("2026-10-04T10:00:00Z");
const FROM = "2026-09-19T08:28:00.000Z";
const TO = "2026-10-03T08:28:00.000Z";

const BOARD = {
  type: "board",
  source: "session",
  userId: "user-a",
  isInstanceAdmin: true,
  companyIds: [COMPANY],
};
const AGENT = { type: "agent", source: "api_key", companyId: COMPANY, agentId: "agent-a" };
const ANONYMOUS = { type: "none" };

function metrics(): BaselineMetricsResponse {
  return {
    window: { from: FROM, to: TO },
    generatedAt: NOW.toISOString(),
    source: { statusLog: "activity_log", costs: "none" },
    byProject: [],
    byRole: [],
  };
}

type SnapshotRow = {
  id: string;
  companyId: string;
  windowFrom: Date;
  windowTo: Date;
  generatedAt: Date;
  payload: unknown;
  label: string | null;
  pinned: boolean;
};

/**
 * The in-memory stand-in for the drizzle surface the snapshot routes use:
 * `insert().values().returning()`, `update().set().where()`, and
 * `select().from().where()` (awaitable, with `limit`). The pin-clearing update
 * is applied to the pinned rows and recorded, so the route contract is
 * observable without a live database.
 */
function snapshotStore(seed: Array<Partial<SnapshotRow>> = []) {
  const rows: SnapshotRow[] = seed.map((row) => ({
    id: randomUUID(),
    companyId: COMPANY,
    windowFrom: new Date(FROM),
    windowTo: new Date(TO),
    generatedAt: NOW,
    payload: {},
    label: null,
    pinned: false,
    ...row,
  }));
  const pinClears: Array<Record<string, unknown>> = [];

  const db = {
    insert: () => ({
      values: (values: Omit<SnapshotRow, "id">) => ({
        returning: async () => {
          // The columns the request does not send fall back to their schema
          // defaults — the same `label: null` / `pinned: false` the database
          // would store.
          const row: SnapshotRow = {
            id: randomUUID(),
            companyId: values.companyId,
            windowFrom: values.windowFrom,
            windowTo: values.windowTo,
            generatedAt: values.generatedAt,
            payload: values.payload,
            label: values.label ?? null,
            pinned: values.pinned ?? false,
          };
          rows.push(row);
          return [row];
        },
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          pinClears.push(values);
          for (const row of rows) {
            if (row.pinned) Object.assign(row, values);
          }
        },
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => {
          const found = rows.slice();
          return {
            then: <T>(onFulfilled: (value: SnapshotRow[]) => T) => Promise.resolve(found).then(onFulfilled),
            limit: async (count: number) => found.slice(0, count),
          };
        },
      }),
    }),
  };

  return { db, rows, pinClears };
}

type ComputeFn = (
  db: Db,
  companyId: string,
  window: BaselineWindow,
  now: Date,
) => Promise<BaselineMetricsResponse>;

function app(
  actor: unknown,
  store = snapshotStore(),
  compute = vi.fn<ComputeFn>(async () => metrics()),
) {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  server.use("/api", baselineRoutes(store.db as unknown as Db, { now: () => NOW, compute }));
  return { server, store, compute };
}

describe("myrmidon(1.6-BASELINE) snapshot route", () => {
  it("creates a snapshot for a board actor and answers the stored row", async () => {
    const { server, compute } = app(BOARD);

    const response = await request(server)
      .post(`/api/myrmidon/companies/${COMPANY}/baseline/snapshots`)
      .send({ from: FROM, to: TO, label: "Q3 2026 Baseline", pinned: true });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      companyId: COMPANY,
      windowFrom: FROM,
      windowTo: TO,
      label: "Q3 2026 Baseline",
      pinned: true,
    });
    expect(response.body.id).toEqual(expect.any(String));
    // The payload is the frozen metrics answer, stored whole.
    expect(response.body.payload).toEqual(metrics());
    expect(compute).toHaveBeenCalledTimes(1);
    const window = compute.mock.calls[0]![2];
    expect(window.from).toEqual(new Date(FROM));
    expect(window.to).toEqual(new Date(TO));
  });

  it("leaves label and pinned optional", async () => {
    const { server } = app(BOARD);

    const response = await request(server)
      .post(`/api/myrmidon/companies/${COMPANY}/baseline/snapshots`)
      .send({ from: FROM, to: TO });

    expect(response.status).toBe(201);
    expect(response.body.label).toBeNull();
    expect(response.body.pinned).toBe(false);
  });

  it("clears the previously pinned snapshot when the new one is pinned", async () => {
    const store = snapshotStore([{ pinned: true, label: "old baseline" }]);
    const { server } = app(BOARD, store);

    const response = await request(server)
      .post(`/api/myrmidon/companies/${COMPANY}/baseline/snapshots`)
      .send({ from: FROM, to: TO, pinned: true });

    expect(response.status).toBe(201);
    expect(store.pinClears).toEqual([{ pinned: false }]);
    expect(store.rows.filter((row) => row.pinned)).toHaveLength(1);
    expect(store.rows.find((row) => row.label === "old baseline")!.pinned).toBe(false);
  });

  it("does not touch the pinned row when the new snapshot is not pinned", async () => {
    const store = snapshotStore([{ pinned: true, label: "old baseline" }]);
    const { server } = app(BOARD, store);

    const response = await request(server)
      .post(`/api/myrmidon/companies/${COMPANY}/baseline/snapshots`)
      .send({ from: FROM, to: TO, pinned: false });

    expect(response.status).toBe(201);
    expect(store.pinClears).toEqual([]);
    expect(store.rows.filter((row) => row.pinned)).toHaveLength(1);
  });

  it("requires both window bounds", async () => {
    const { server, compute } = app(BOARD);

    const missing = await request(server)
      .post(`/api/myrmidon/companies/${COMPANY}/baseline/snapshots`)
      .send({ from: FROM });
    expect(missing.status).toBe(400);

    const empty = await request(server)
      .post(`/api/myrmidon/companies/${COMPANY}/baseline/snapshots`)
      .send({});
    expect(empty.status).toBe(400);

    expect(compute).not.toHaveBeenCalled();
  });

  it("refuses an agent token and an anonymous caller", async () => {
    const agent = await request(app(AGENT).server)
      .post(`/api/myrmidon/companies/${COMPANY}/baseline/snapshots`)
      .send({ from: FROM, to: TO });
    expect(agent.status).toBe(403);

    const anonymous = await request(app(ANONYMOUS).server)
      .post(`/api/myrmidon/companies/${COMPANY}/baseline/snapshots`)
      .send({ from: FROM, to: TO });
    expect(anonymous.status).toBe(403);
  });

  it("refuses a board member of another company", async () => {
    const response = await request(app({ ...BOARD, companyIds: [OTHER_COMPANY] }).server)
      .post(`/api/myrmidon/companies/${COMPANY}/baseline/snapshots`)
      .send({ from: FROM, to: TO });

    expect(response.status).toBe(403);
  });

  it("lists the company snapshots for an agent token", async () => {
    const store = snapshotStore([{ label: "a" }, { label: "b" }]);
    const response = await request(app(AGENT, store).server).get(
      `/api/myrmidon/companies/${COMPANY}/baseline/snapshots`,
    );

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(2);
    expect(response.body.map((row: SnapshotRow) => row.label)).toEqual(["a", "b"]);
    expect(response.body[0]).toMatchObject({ companyId: COMPANY, windowFrom: FROM, windowTo: TO });
  });

  it("returns one snapshot by id and 404 when the company has none", async () => {
    const store = snapshotStore([{ label: "a" }]);
    const id = store.rows[0]!.id;

    const found = await request(app(BOARD, store).server).get(
      `/api/myrmidon/companies/${COMPANY}/baseline/snapshots/${id}`,
    );
    expect(found.status).toBe(200);
    expect(found.body).toMatchObject({ id, label: "a" });

    const empty = await request(app(BOARD).server).get(
      `/api/myrmidon/companies/${COMPANY}/baseline/snapshots/${randomUUID()}`,
    );
    expect(empty.status).toBe(404);
  });

  it("refuses another company on the read routes", async () => {
    const store = snapshotStore([{ label: "a" }]);
    const id = store.rows[0]!.id;
    const outsider = { ...BOARD, companyIds: [OTHER_COMPANY] };

    const list = await request(app(outsider, store).server).get(
      `/api/myrmidon/companies/${COMPANY}/baseline/snapshots`,
    );
    expect(list.status).toBe(403);

    const byId = await request(app(outsider, store).server).get(
      `/api/myrmidon/companies/${COMPANY}/baseline/snapshots/${id}`,
    );
    expect(byId.status).toBe(403);
  });
});