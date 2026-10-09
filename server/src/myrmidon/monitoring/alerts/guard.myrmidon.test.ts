// myrmidon(1.6.6-ALERTS): the module-mount guard — red without the module.
// Imports the entry point the vendor app.ts line mounts; a clean checkout
// without the alerts module fails to resolve this import.
import { describe, expect, it } from "vitest";
import * as alerts from "./index.js";

describe("myrmidon(1.6.6-ALERTS) module presence", () => {
  it("exports the router factory and the sweep for the vendor integration points", () => {
    expect(typeof alerts.myrmidonMonitoringAlertsRoutes).toBe("function");
    expect(typeof alerts.startAlertsSweep).toBe("function");
    expect(typeof alerts.stopAlertsSweep).toBe("function");
  });

  it("exports the env names documented in SETTINGS.md", () => {
    expect(alerts.ALERT_WEBHOOK_TOKEN_REF_ENV).toBe("MYRMIDON_ALERTS_WEBHOOK_TOKEN_REF");
    expect(alerts.ALERTS_COMPANY_ID_ENV).toBe("MYRMIDON_ALERTS_COMPANY_ID");
    expect(alerts.ALERTS_SWEEP_INTERVAL_SEC_ENV).toBe("MYRMIDON_ALERTS_SWEEP_INTERVAL_SEC");
    expect(alerts.ALERTS_RETENTION_DAYS_ENV).toBe("MYRMIDON_ALERTS_RETENTION_DAYS");
  });

  it("exports the metrics and the default runbook for the selfcheck and part A", () => {
    expect(alerts.ALERTS_METRIC_NAME).toBe("myrmidon_alerts_processed_total");
    expect(typeof alerts.createAlertsMetrics).toBe("function");
    expect(typeof alerts.outcomeToMetric).toBe("function");
    expect(Array.isArray(alerts.DEFAULT_ALERT_RUNBOOK)).toBe(true);
    expect(alerts.DEFAULT_ALERT_RUNBOOK.length).toBeGreaterThan(0);
  });
});

// Routes and domain behavior are pinned in routes.myrmidon.test.ts and
// domain.myrmidon.test.ts; this file is only the guard.
