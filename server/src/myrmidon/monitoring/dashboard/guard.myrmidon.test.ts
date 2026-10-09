// server/src/myrmidon/monitoring/dashboard/guard.myrmidon.test.ts
// myrmidon(1.6.6 MONITORING C): wiring guard. The dashboard module must be
// reachable from the server entry point: one import behind the
// 1.6.6 MONITORING C marker and one /api mount of the router. This suite is
// red when the module is missing or the entry point lost its wiring — cutting
// the module removes the import, and this file then fails to resolve it.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  myrmidonMonitoringDashboardRoutes,
  MONITORING_SETTINGS_GENERAL_KEY,
} from "./index.js";

const APP_TS = fileURLToPath(new URL("../../../app.ts", import.meta.url));
const SETTINGS_MD = fileURLToPath(new URL("../../../../../docs/myrmidon/SETTINGS.md", import.meta.url));

describe("monitoring dashboard wiring guard", () => {
  it("the server entry point imports the module behind the 1.6.6 MONITORING C marker", () => {
    const source = readFileSync(APP_TS, "utf8");
    const importLines = source
      .split("\n")
      .filter((line: string) => line.includes("myrmidon/monitoring/dashboard"));
    expect(importLines.length).toBe(1);
    expect(importLines[0]).toContain("myrmidon(1.6.6 MONITORING C)");
  });

  it("the router is mounted under /api exactly once", () => {
    const source = readFileSync(APP_TS, "utf8");
    const mountLines = source
      .split("\n")
      .filter((line: string) => line.includes("api.use(myrmidonMonitoringDashboardRoutes("));
    expect(mountLines.length).toBe(1);
    expect(mountLines[0]).toContain("myrmidon(1.6.6 MONITORING C)");
  });

  it("the settings surface is exported from the module index", () => {
    expect(typeof myrmidonMonitoringDashboardRoutes).toBe("function");
    expect(MONITORING_SETTINGS_GENERAL_KEY).toBe("myrmidonMonitoringDashboard");
  });

  it("the monitoring settings keys are documented in SETTINGS.md (via the change fragment)", () => {
    // The shared SETTINGS.md is only folded at release cut; the fragment of
    // this branch carries the entries and the collect check enforces them.
    // Fragment file names use dashes for the version parts (convention:
    // myr-<ver>-<slug>.md) — scan the changes dir by marker instead of
    // hardcoding one file name.
    const changesDir = fileURLToPath(new URL("../../../../../docs/myrmidon/changes/", import.meta.url));
    const documented = readdirSync(changesDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name.toLowerCase() !== "readme.md")
      .some((entry) => readFileSync(join(changesDir, entry.name), "utf8").includes("myrmidonMonitoringDashboard"));
    expect(documented).toBe(true);
  });
});
