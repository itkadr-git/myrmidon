import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@myrmidon/db";
import { healthRoutes } from "../routes/health.js";
import { inspectReplicationHealth } from "../services/replication-health.js";

function getSqlText(query: unknown): string {
  if (!query) return "";
  if (typeof query === "string") return query;
  if (typeof query === "object") {
    const obj = query as Record<string, unknown>;
    if (Array.isArray(obj.strings)) return obj.strings.join(" ");
    if (Array.isArray(obj.queryChunks)) {
      return obj.queryChunks
        .map((chunk) => {
          if (typeof chunk === "string") return chunk;
          if (chunk && typeof chunk === "object") {
            const val = (chunk as Record<string, unknown>).value;
            if (Array.isArray(val)) return val.join(" ");
            if (typeof val === "string") return val;
            if (val && typeof val === "object" && "queryChunks" in val) return getSqlText(val);
          }
          return "";
        })
        .join(" ");
    }
    try {
      return JSON.stringify(query);
    } catch {
      return String(query);
    }
  }
  return String(query);
}

describe("Replication Health Service", () => {
  it("inspects healthy standby with streaming receiver", async () => {
    const mockExecute = vi.fn().mockImplementation(async (query: unknown) => {
      const sqlText = getSqlText(query);
      if (sqlText.includes("pg_is_in_recovery")) {
        return [{ in_recovery: true }];
      }
      if (sqlText.includes("pg_stat_wal_receiver")) {
        return [
          {
            status: "streaming",
            receive_start_lsn: "0/3000000",
            received_lsn: "0/3000100",
            last_msg_send_time: "2026-10-31T12:00:00.000Z",
            last_msg_receipt_time: "2026-10-31T12:00:01.000Z",
            latest_end_lsn: "0/3000100",
            latest_end_time: "2026-10-31T12:00:01.000Z",
            slot_name: "standby_slot_1",
            sender_host: "primary.internal",
            sender_port: 5432,
          },
        ];
      }
      if (sqlText.includes("pg_last_xact_replay_timestamp")) {
        return [
          {
            replay_lag_seconds: 0.45,
            last_replay_timestamp: "2026-10-31T12:00:00.000Z",
            last_receive_lsn: "0/3000100",
            last_replay_lsn: "0/3000100",
            byte_lag: 0,
          },
        ];
      }
      return [];
    });

    const mockDb = { execute: mockExecute } as unknown as Db;
    const result = await inspectReplicationHealth(mockDb, {
      maxLagSeconds: 60,
      warnLagSeconds: 15,
      role: "standby",
    });

    expect(result.status).toBe("ok");
    expect(result.role).toBe("standby");
    expect(result.inRecovery).toBe(true);
    expect(result.receiver?.status).toBe("streaming");
    expect(result.receiver?.slotName).toBe("standby_slot_1");
    expect(result.lag.seconds).toBe(0.45);
    expect(result.warnings).toHaveLength(0);
  });

  it("flags warning when standby receiver is not streaming", async () => {
    const mockExecute = vi.fn().mockImplementation(async (query: unknown) => {
      const sqlText = getSqlText(query);
      if (sqlText.includes("pg_is_in_recovery")) {
        return [{ in_recovery: true }];
      }
      if (sqlText.includes("pg_stat_wal_receiver")) {
        return [{ status: "stopped", sender_host: "primary.internal", sender_port: 5432 }];
      }
      if (sqlText.includes("pg_last_xact_replay_timestamp")) {
        return [{ replay_lag_seconds: 5.0, byte_lag: 1024 }];
      }
      return [];
    });

    const mockDb = { execute: mockExecute } as unknown as Db;
    const result = await inspectReplicationHealth(mockDb);

    expect(result.status).toBe("warning");
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "standby_not_streaming" }),
    );
  });

  it("flags critical when lag exceeds maxLagSeconds threshold", async () => {
    const mockExecute = vi.fn().mockImplementation(async (query: unknown) => {
      const sqlText = getSqlText(query);
      if (sqlText.includes("pg_is_in_recovery")) {
        return [{ in_recovery: true }];
      }
      if (sqlText.includes("pg_stat_wal_receiver")) {
        return [{ status: "streaming" }];
      }
      if (sqlText.includes("pg_last_xact_replay_timestamp")) {
        return [{ replay_lag_seconds: 120.5, byte_lag: 500000 }];
      }
      return [];
    });

    const mockDb = { execute: mockExecute } as unknown as Db;
    const result = await inspectReplicationHealth(mockDb, { maxLagSeconds: 60 });

    expect(result.status).toBe("critical");
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "replication_lag_exceeded" }),
    );
  });

  it("inspects primary node with connected standbys", async () => {
    const mockExecute = vi.fn().mockImplementation(async (query: unknown) => {
      const sqlText = getSqlText(query);
      if (sqlText.includes("pg_is_in_recovery")) {
        return [{ in_recovery: false }];
      }
      if (sqlText.includes("pg_current_wal_lsn")) {
        return [{ current_wal_lsn: "0/5000100" }];
      }
      if (sqlText.includes("pg_stat_replication")) {
        return [
          {
            application_name: "walreceiver_standby1",
            client_addr: "192.0.2.2",
            state: "streaming",
            sync_state: "sync",
            sync_priority: 1,
            sent_lsn: "0/5000100",
            write_lsn: "0/5000100",
            flush_lsn: "0/5000100",
            replay_lsn: "0/5000100",
            write_lag_seconds: 0.01,
            flush_lag_seconds: 0.02,
            replay_lag_seconds: 0.05,
            byte_lag: 0,
          },
        ];
      }
      return [];
    });

    const mockDb = { execute: mockExecute } as unknown as Db;
    const result = await inspectReplicationHealth(mockDb, { role: "primary" });

    expect(result.status).toBe("ok");
    expect(result.role).toBe("primary");
    expect(result.inRecovery).toBe(false);
    expect(result.connectedStandbys).toBe(1);
    expect(result.standbys).toHaveLength(1);
    expect(result.standbys?.[0]?.applicationName).toBe("walreceiver_standby1");
    expect(result.lag.currentWalLsn).toBe("0/5000100");
    expect(result.warnings).toHaveLength(0);
  });

  it("detects role mismatch when query requests standby but node is primary", async () => {
    const mockExecute = vi.fn().mockImplementation(async (query: unknown) => {
      const sqlText = getSqlText(query);
      if (sqlText.includes("pg_is_in_recovery")) {
        return [{ in_recovery: false }];
      }
      if (sqlText.includes("pg_current_wal_lsn")) {
        return [{ current_wal_lsn: "0/1000" }];
      }
      if (sqlText.includes("pg_stat_replication")) {
        return [];
      }
      return [];
    });

    const mockDb = { execute: mockExecute } as unknown as Db;
    const result = await inspectReplicationHealth(mockDb, { role: "standby" });

    expect(result.status).toBe("warning");
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "replication_role_mismatch" }),
    );
  });
});

describe("GET /health/replication route", () => {
  function createApp(db?: Db, deploymentMode: "local_trusted" | "authenticated" = "local_trusted") {
    const app = express();
    app.use(
      "/health",
      healthRoutes(db, {
        deploymentMode,
        deploymentExposure: "private",
        authReady: true,
        companyDeletionEnabled: true,
      }),
    );
    return app;
  }

  it("returns 200 with full replication details in local_trusted mode", async () => {
    const mockDb = {
      execute: vi.fn().mockImplementation(async (query: unknown) => {
        const sqlText = getSqlText(query);
        if (sqlText.includes("pg_is_in_recovery")) {
          return [{ in_recovery: false }];
        }
        if (sqlText.includes("pg_current_wal_lsn")) {
          return [{ current_wal_lsn: "0/5000000" }];
        }
        if (sqlText.includes("pg_stat_replication")) {
          return [
            {
              application_name: "standby_node",
              client_addr: "192.0.2.20",
              state: "streaming",
              sync_state: "async",
              sync_priority: 0,
              replay_lag_seconds: 0.1,
              byte_lag: 0,
            },
          ];
        }
        return [];
      }),
    } as unknown as Db;

    const app = createApp(mockDb, "local_trusted");
    const res = await request(app).get("/health/replication?maxLagSeconds=10");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.role).toBe("primary");
    expect(res.body.connectedStandbys).toBe(1);
    expect(res.body.standbys[0].clientAddr).toBe("192.0.2.20");
  });

  it("redacts sensitive addresses for unauthenticated callers in authenticated mode", async () => {
    const mockDb = {
      execute: vi.fn().mockImplementation(async (query: unknown) => {
        const sqlText = getSqlText(query);
        if (sqlText.includes("pg_is_in_recovery")) {
          return [{ in_recovery: false }];
        }
        if (sqlText.includes("pg_current_wal_lsn")) {
          return [{ current_wal_lsn: "0/5000000" }];
        }
        if (sqlText.includes("pg_stat_replication")) {
          return [
            {
              application_name: "standby_node",
              client_addr: "192.0.2.20",
              state: "streaming",
              sync_state: "async",
              sync_priority: 0,
              replay_lag_seconds: 0.1,
              byte_lag: 0,
            },
          ];
        }
        return [];
      }),
    } as unknown as Db;

    const app = createApp(mockDb, "authenticated");
    const res = await request(app).get("/health/replication");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.connectedStandbys).toBe(1);
    // Standby info should have clientAddr redacted / absent
    expect(res.body.standbys[0].clientAddr).toBeUndefined();
  });

  it("returns 400 when invalid query parameters are supplied", async () => {
    const mockDb = { execute: vi.fn() } as unknown as Db;
    const app = createApp(mockDb);

    const res = await request(app).get("/health/replication?maxLagSeconds=-10");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_query_parameters");
    expect(res.body.details).toBeDefined();
  });

  it("returns 503 when db is not configured", async () => {
    const app = createApp(undefined);
    const res = await request(app).get("/health/replication");

    expect(res.status).toBe(503);
    expect(res.body.error).toBe("database_unavailable");
  });

  it("returns 503 when database query throws", async () => {
    const mockDb = {
      execute: vi.fn().mockRejectedValue(new Error("Connection terminated")),
    } as unknown as Db;
    const app = createApp(mockDb);

    const res = await request(app).get("/health/replication");
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("database_probe_failed");
  });
});
