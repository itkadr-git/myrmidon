// server/src/myrmidon/monitoring/dashboard/guard.myrmidon.test.ts
// myrmidon(1.6.6 MONITORING C): dashboard route registration is part of the
// app-plugin facade contract consumed by the server entry point.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  myrmidonMonitoringDashboardRoutes,
  MONITORING_SETTINGS_GENERAL_KEY,
} from "./index.js";
import * as appPlugin from "../../app-plugin.js";
const SETTINGS_MD = fileURLToPath(new URL("../../../../../docs/myrmidon/SETTINGS.md", import.meta.url));

describe("monitoring dashboard wiring guard", () => {
  it("exports the dashboard router through the app-plugin registry", () => {
    expect(appPlugin.myrmidonMonitoringDashboardRoutes).toBe(myrmidonMonitoringDashboardRoutes);
    expect(appPlugin.myrmidonMonitoringDashboardRoutes).toBeTypeOf("function");
  });

  it("the settings surface is exported from the module index", () => {
    expect(typeof myrmidonMonitoringDashboardRoutes).toBe("function");
    expect(MONITORING_SETTINGS_GENERAL_KEY).toBe("myrmidonMonitoringDashboard");
  });

  it("the monitoring settings keys are documented in SETTINGS.md (or an open change fragment)", () => {
    // Between release cuts the entries live in a per-PR change fragment; the
    // cut folds them into SETTINGS.md and deletes the fragments. Either place
    // counts; the fragments directory may be empty or missing after a cut.
    const key = "myrmidonMonitoringDashboard";
    const changesDir = fileURLToPath(new URL("../../../../../docs/myrmidon/changes/", import.meta.url));
    const inSettings = readFileSync(SETTINGS_MD, "utf8").includes(key);
    const inFragment = existsSync(changesDir)
      && readdirSync(changesDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name.toLowerCase() !== "readme.md")
        .some((entry) => readFileSync(join(changesDir, entry.name), "utf8").includes(key));
    expect(inSettings || inFragment).toBe(true);
  });
});
