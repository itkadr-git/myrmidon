import { describe, expect, it } from "vitest";
import {
  adminAssistantDryRunDiagnosticsSchema,
  sanitizeDryRunDiagnostics,
  sanitizeDryRunDiagnosticsDetail,
  toSafeDryRunDiagnosticsJson,
  type AdminAssistantDryRunDiagnostics,
} from "./admin-assistant-diagnostics.js";

const baseDiagnostics: AdminAssistantDryRunDiagnostics = {
  dry_run: true,
  timestamp: "2026-11-02T00:00:00.000Z",
  probes: [
    {
      name: "agents_summary",
      status: "ok",
      durationMs: 12,
      detail: { total: 3, byStatus: { active: 2, idle: 1 } },
    },
    {
      name: "disk_usage",
      status: "ok",
      durationMs: 5,
      detail: {
        path: "/data",
        totalBytes: 1000,
        freeBytes: 500,
        usedBytes: 500,
        usedPercent: 50,
        status: "healthy",
      },
    },
  ],
  summary: { total: 2, ok: 2, degraded: 0 },
};

describe("adminAssistantDryRunDiagnosticsSchema", () => {
  it("accepts a valid payload", () => {
    expect(() =>
      adminAssistantDryRunDiagnosticsSchema.parse(baseDiagnostics),
    ).not.toThrow();
  });

  it("rejects a payload with dry_run != true", () => {
    expect(() =>
      adminAssistantDryRunDiagnosticsSchema.parse({
        ...baseDiagnostics,
        dry_run: false,
      }),
    ).toThrow();
  });

  it("rejects a probe with negative durationMs", () => {
    expect(() =>
      adminAssistantDryRunDiagnosticsSchema.parse({
        ...baseDiagnostics,
        probes: [
          { name: "x", status: "ok", durationMs: -1 },
        ],
      }),
    ).toThrow();
  });

  it("rejects an unknown probe status", () => {
    expect(() =>
      adminAssistantDryRunDiagnosticsSchema.parse({
        ...baseDiagnostics,
        probes: [
          { name: "x", status: "unknown", durationMs: 1 },
        ],
      }),
    ).toThrow();
  });
});

describe("sanitizeDryRunDiagnosticsDetail", () => {
  it("preserves safe diagnostic fields", () => {
    const detail = {
      total: 42,
      path: "/var/data",
      byStatus: { active: 1, idle: 0 },
    };
    expect(sanitizeDryRunDiagnosticsDetail(detail)).toEqual(detail);
  });

  it("redacts secret-keyed fields", () => {
    const detail = {
      api_key: "dummy-value",
      password: "dummy-password",
      secret: "dummy-secret",
      token: "dummy-token",
      credential: "dummy-credential",
      authHeader: "dummy-auth-header",
      privateKey: "dummy-private-key",
      sessionId: "dummy-session-id",
      cookie: "dummy-cookie",
    };
    const result = sanitizeDryRunDiagnosticsDetail(detail) as Record<string, unknown>;
    for (const key of Object.keys(detail)) {
      expect(result[key]).toBe("[REDACTED]");
    }
  });

  it("redacts nested secret-keyed fields inside arrays", () => {
    const detail = {
      connections: [
        { name: "primary", db_password: "dummy-db-password", host: "db.internal" },
        { name: "replica", token: "dummy-token", host: "db2.internal" },
      ],
    };
    const result = sanitizeDryRunDiagnosticsDetail(detail) as {
      connections: Array<Record<string, unknown>>;
    };
    expect(result.connections[0].db_password).toBe("[REDACTED]");
    expect(result.connections[0].host).toBe("db.internal");
    expect(result.connections[1].token).toBe("[REDACTED]");
    expect(result.connections[1].host).toBe("db2.internal");
  });

  it("does not mutate the input object", () => {
    const detail = { api_key: "dummy-api-key", total: 5 };
    const snapshot = JSON.parse(JSON.stringify(detail));
    sanitizeDryRunDiagnosticsDetail(detail);
    expect(detail).toEqual(snapshot);
  });
});

describe("sanitizeDryRunDiagnostics", () => {
  it("preserves safe fields and redacts secret fields in probe details", () => {
    const diagnostics: AdminAssistantDryRunDiagnostics = {
      ...baseDiagnostics,
      probes: [
        {
          name: "leaky_probe",
          status: "ok",
          durationMs: 3,
          detail: {
            note: "ok",
            api_key: "dummy-api-key",
            nested: { password: "dummy-password", count: 7 },
          },
        },
      ],
    };
    const result = sanitizeDryRunDiagnostics(diagnostics);
    const probe = result.probes[0];
    expect(probe.detail?.note).toBe("ok");
    expect(probe.detail?.api_key).toBe("[REDACTED]");
    expect(
      (probe.detail?.nested as Record<string, unknown>).password,
    ).toBe("[REDACTED]");
    expect(
      (probe.detail?.nested as Record<string, unknown>).count,
    ).toBe(7);
    // summary and timestamp are untouched
    expect(result.summary).toEqual(diagnostics.summary);
    expect(result.timestamp).toBe(diagnostics.timestamp);
    expect(result.dry_run).toBe(true);
  });

  it("handles probes without a detail field", () => {
    const diagnostics: AdminAssistantDryRunDiagnostics = {
      ...baseDiagnostics,
      probes: [
        { name: "no_detail", status: "degraded", durationMs: 1, error: "boom" },
      ],
    };
    const result = sanitizeDryRunDiagnostics(diagnostics);
    expect(result.probes[0].detail).toBeUndefined();
    expect(result.probes[0].error).toBe("boom");
  });
});

describe("toSafeDryRunDiagnosticsJson", () => {
  it("returns a payload that is safe to serialize", () => {
    const diagnostics: AdminAssistantDryRunDiagnostics = {
      ...baseDiagnostics,
      probes: [
        {
          name: "leaky_probe",
          status: "ok",
          durationMs: 3,
          detail: { note: "ok", api_key: "dummy-api-key" },
        },
      ],
    };
    const safe = toSafeDryRunDiagnosticsJson(diagnostics);
    const json = JSON.stringify(safe);
    expect(json).not.toContain("dummy-api-key");
    expect(json).toContain("[REDACTED]");
    expect(json).toContain("ok");
  });
});
