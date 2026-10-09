import { describe, expect, it } from "vitest";
import {
  SYSTEM_SETTING_KEYS,
} from "@paperclipai/shared/myrmidon-system-settings";
import { liveBehaviorSetting, applyLiveBehaviorSettings } from "../behavior-settings/live.js";
import {
  liveDeploySettings,
  liveTracingHealthSettings,
  liveZabbixSettings,
} from "./live.js";

describe("system-settings live readers", () => {
  it("registers the system keys in the part A registry", () => {
    expect(SYSTEM_SETTING_KEYS).toContain("system.deploy.enabled");
    expect(SYSTEM_SETTING_KEYS).toContain("system.tracing.windowSec");
    expect(SYSTEM_SETTING_KEYS).toContain("system.zabbix.hostGroups");
    expect(SYSTEM_SETTING_KEYS).toHaveLength(13);
  });

  it("falls back to the default when nothing is stored and no env is set", () => {
    applyLiveBehaviorSettings({ settings: {}, sources: {} });
    expect(liveBehaviorSetting("system.deploy.enabled")).toBe(false);
    expect(liveDeploySettings({} as NodeJS.ProcessEnv).enabled).toBe(false);
    expect(liveDeploySettings({} as NodeJS.ProcessEnv).verifyTimeoutSec).toBe(30);
  });

  it("env overrides the stored value", () => {
    applyLiveBehaviorSettings({
      settings: { "system.deploy.enabled": false },
      sources: { "system.deploy.enabled": "ui" },
    });
    const env = { MYRMIDON_DEPLOY_ENABLED: "1" } as NodeJS.ProcessEnv;
    expect(liveDeploySettings(env).enabled).toBe(true);
  });

  it("stored value wins when no env override", () => {
    applyLiveBehaviorSettings({
      settings: { "system.deploy.enabled": true },
      sources: { "system.deploy.enabled": "ui" },
    });
    expect(liveDeploySettings({} as NodeJS.ProcessEnv).enabled).toBe(true);
  });

  it("parses tracing windows from the registry", () => {
    applyLiveBehaviorSettings({
      settings: {
        "system.tracing.windowSec": 600,
        "system.tracing.healthTtlSec": 120,
        "system.tracing.signalIntervalSec": 180,
      },
      sources: {
        "system.tracing.windowSec": "ui",
        "system.tracing.healthTtlSec": "ui",
        "system.tracing.signalIntervalSec": "ui",
      },
    });
    const settings = liveTracingHealthSettings({} as NodeJS.ProcessEnv);
    expect(settings.windowSec).toBe(600);
    expect(settings.healthTtlSec).toBe(120);
    expect(settings.signalIntervalSec).toBe(180);
  });

  it("parses zabbix host groups from a comma-separated env string", () => {
    applyLiveBehaviorSettings({ settings: {}, sources: {} });
    const env = { MYRMIDON_ZABBIX_HOST_GROUPS: "linux, docker , prod" } as NodeJS.ProcessEnv;
    expect(liveZabbixSettings(env).hostGroups).toEqual(["linux", "docker", "prod"]);
  });

  it("parses zabbix host groups from a stored array", () => {
    applyLiveBehaviorSettings({
      settings: { "system.zabbix.hostGroups": ["a", "b"] },
      sources: { "system.zabbix.hostGroups": "ui" },
    });
    expect(liveZabbixSettings({} as NodeJS.ProcessEnv).hostGroups).toEqual(["a", "b"]);
  });
});
