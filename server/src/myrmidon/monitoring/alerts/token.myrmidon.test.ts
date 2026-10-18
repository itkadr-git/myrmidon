// myrmidon(1.6.6-ALERTS): the token reference resolution and the sweep
// settings — the env:/file: pattern and the retention window. No network, no
// real files (the file reader is injected).
import { describe, expect, it } from "vitest";
import { readAlertSweepSettings, startAlertsSweep } from "./sweep.js";
import { readAlertsSettings, resolveAlertTokenRef } from "./token.js";

describe("myrmidon(1.6.6-ALERTS) token reference", () => {
  it("reads the settings from the environment", () => {
    const settings = readAlertsSettings({
      MYRMIDON_ALERTS_WEBHOOK_TOKEN_REF: "env:ALERT_TOKEN",
      MYRMIDON_ALERTS_COMPANY_ID: "company-a",
    });
    expect(settings.tokenRef).toBe("env:ALERT_TOKEN");
    expect(settings.companyId).toBe("company-a");
    expect(readAlertsSettings({}).tokenRef).toBeNull();
  });

  it("resolves env:<NAME> and file:<PATH> references", () => {
    expect(resolveAlertTokenRef("env:ALERT_TOKEN", { env: { ALERT_TOKEN: "secret-1" } })).toBe("secret-1");
    expect(resolveAlertTokenRef("file:/run/secrets/token", { readFile: () => "secret-2\n" })).toBe("secret-2");
  });

  it("returns null for a missing reference and refuses a malformed one", () => {
    expect(resolveAlertTokenRef(null)).toBeNull();
    expect(() => resolveAlertTokenRef("literal-token")).toThrow(/env:<NAME> or file:<PATH>/);
    expect(() => resolveAlertTokenRef("env:MISSING", { env: {} })).toThrow(/empty value/);
  });
});

describe("myrmidon(1.6.6-ALERTS) sweep settings", () => {
  it("reads the interval and retention with clamps and defaults", () => {
    expect(readAlertSweepSettings({})).toEqual({
      intervalMs: 3600_000,
      retentionMs: 14 * 24 * 3600 * 1000,
    });
    expect(readAlertSweepSettings({ MYRMIDON_ALERTS_SWEEP_INTERVAL_SEC: "60" }).intervalMs).toBe(60_000);
    expect(readAlertSweepSettings({ MYRMIDON_ALERTS_SWEEP_INTERVAL_SEC: "999999999" }).intervalMs).toBe(86_400_000);
    expect(readAlertSweepSettings({ MYRMIDON_ALERTS_RETENTION_DAYS: "1" }).retentionMs).toBe(24 * 3600 * 1000);
    expect(readAlertSweepSettings({ MYRMIDON_ALERTS_SWEEP_INTERVAL_SEC: "abc" }).intervalMs).toBe(3600_000);
  });

  it("starts as a no-op without a database touch when the interval is 0", () => {
    let touched = false;
    const db = new Proxy({} as unknown as Parameters<typeof startAlertsSweep>[0], {
      get() {
        touched = true;
        return undefined;
      },
    });
    const stop = startAlertsSweep(db, { env: { MYRMIDON_ALERTS_SWEEP_INTERVAL_SEC: "0" } });
    expect(typeof stop).toBe("function");
    stop();
    expect(touched).toBe(false);
  });
});
