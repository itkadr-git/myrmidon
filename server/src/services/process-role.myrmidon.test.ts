// server/src/services/process-role.myrmidon.test.ts
//
// myrmidon(PROCS-1.1): the process role switch point is only useful if the three
// roles are *enumerated* somewhere. These tests pin the matrix (background work,
// run execution, migrations, listeners) and the env override, including the
// invalid-value fallback that keeps a typo from starting a role-less process.

import { describe, expect, it } from "vitest";

import {
  PROCESS_ROLE_API_HOST,
  PROCESS_ROLE_API_PORT,
  PROCESS_ROLE_ENV,
  PROCESS_ROLE_VALUES,
  PROCESS_ROLE_WORKER_HOST,
  PROCESS_ROLE_WORKER_PORT,
  processBackgroundWorkPlan,
  processRole,
  processRoleProfileFor,
  resolveProcessRole,
} from "./process-role.js";

describe("resolveProcessRole", () => {
  it("defaults to all when the env variable is unset or blank", () => {
    expect(resolveProcessRole(undefined)).toEqual({
      role: "all",
      source: "default",
      rawValue: null,
      invalidValue: false,
    });
    expect(resolveProcessRole("   ")).toEqual({
      role: "all",
      source: "default",
      rawValue: null,
      invalidValue: false,
    });
  });

  it("accepts each documented value, case-insensitively and trimmed", () => {
    for (const role of PROCESS_ROLE_VALUES) {
      expect(resolveProcessRole(role)).toEqual({
        role,
        source: "env",
        rawValue: role,
        invalidValue: false,
      });
    }
    expect(resolveProcessRole(" API ").role).toBe("api");
    expect(resolveProcessRole("Worker").role).toBe("worker");
  });

  it("falls back to all and flags an unknown value instead of inventing a role", () => {
    const resolved = resolveProcessRole("scheduler");
    expect(resolved.role).toBe("all");
    expect(resolved.invalidValue).toBe(true);
    expect(resolved.rawValue).toBe("scheduler");
    expect(resolved.source).toBe("default");
  });

  it("reads the role from an explicit environment", () => {
    expect(processRole({ [PROCESS_ROLE_ENV]: "api" }).role).toBe("api");
    expect(processRole({ [PROCESS_ROLE_ENV]: "api" }).source).toBe("env");
    expect(processRole({}).role).toBe("all");
    expect(processRole({}).source).toBe("default");
  });
});

describe("process role matrix", () => {
  it("keeps all as the unchanged deployment", () => {
    const profile = processRoleProfileFor("all");
    expect(profile.runsBackground).toBe(true);
    expect(profile.executesRuns).toBe(true);
    expect(profile.migrations).toBe("apply");
    expect(profile.listen).toEqual({ host: null, port: null, reusePort: false });
    expect(profile.loopbackListen).toBeNull();
  });

  it("gives worker every background duty plus the internal loopback listener", () => {
    const profile = processRoleProfileFor("worker");
    expect(profile.runsBackground).toBe(true);
    expect(profile.executesRuns).toBe(true);
    expect(profile.migrations).toBe("apply");
    expect(profile.listen).toEqual({ host: null, port: null, reusePort: false });
    expect(profile.loopbackListen).toEqual({
      host: PROCESS_ROLE_WORKER_HOST,
      port: PROCESS_ROLE_WORKER_PORT,
    });
  });

  it("gives api the shared public listener and no background or run duties", () => {
    const profile = processRoleProfileFor("api");
    expect(profile.runsBackground).toBe(false);
    expect(profile.executesRuns).toBe(false);
    expect(profile.migrations).toBe("await");
    expect(profile.listen).toEqual({
      host: PROCESS_ROLE_API_HOST,
      port: PROCESS_ROLE_API_PORT,
      reusePort: true,
    });
    expect(profile.loopbackListen).toBeNull();
  });
});

describe("processBackgroundWorkPlan", () => {
  it("enumerates no background work for api", () => {
    const plan = processBackgroundWorkPlan(processRoleProfileFor("api"));
    expect(Object.values(plan).filter(Boolean)).toEqual([]);
    expect(plan).toEqual({
      heartbeatScheduler: false,
      executionControlSweeps: false,
      startupRecovery: false,
      environmentSweeps: false,
      appTimers: false,
      pluginWorkers: false,
      backups: false,
      loopbackApi: false,
    });
  });

  it("enumerates every unit for all, without a loopback api", () => {
    expect(processBackgroundWorkPlan(processRoleProfileFor("all"))).toEqual({
      heartbeatScheduler: true,
      executionControlSweeps: true,
      startupRecovery: true,
      environmentSweeps: true,
      appTimers: true,
      pluginWorkers: true,
      backups: true,
      loopbackApi: false,
    });
  });

  it("enumerates only the loopback api as the worker's extra unit", () => {
    const worker = processBackgroundWorkPlan(processRoleProfileFor("worker"));
    const all = processBackgroundWorkPlan(processRoleProfileFor("all"));
    expect(worker).toEqual({ ...all, loopbackApi: true });
  });
});