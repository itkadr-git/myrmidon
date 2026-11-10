import { describe, expect, it } from "vitest";
import manifest from "./manifest.js";
import plugin from "./plugin.js";

describe("Docker sandbox provider plugin", () => {
  it("declares the expected plugin manifest and environment driver", () => {
    expect(manifest.id).toBe("paperclip.docker-sandbox-provider");
    expect(manifest.capabilities).toContain("environment.drivers.register");
    expect(manifest.environmentDrivers).toHaveLength(1);

    const driver = manifest.environmentDrivers?.[0];
    expect(driver).toBeDefined();
    expect(driver?.driverKey).toBe("docker");
    expect(driver?.kind).toBe("sandbox_provider");
    expect(driver?.displayName).toBe("Docker (own server via dockergate)");
    expect(driver?.configSchema).toEqual({
      type: "object",
      properties: {},
    });
  });

  it("declares onHealth and all required environment lifecycle hooks", async () => {
    expect(plugin.definition.onHealth).toBeTypeOf("function");
    const health = await plugin.definition.onHealth?.();
    expect(health).toEqual({
      status: "ok",
      message: "Docker sandbox provider plugin healthy",
    });

    expect(plugin.definition.setup).toBeTypeOf("function");
    expect(plugin.definition.onEnvironmentValidateConfig).toBeTypeOf("function");
    expect(plugin.definition.onEnvironmentProbe).toBeTypeOf("function");
    expect(plugin.definition.onEnvironmentAcquireLease).toBeTypeOf("function");
    expect(plugin.definition.onEnvironmentResumeLease).toBeTypeOf("function");
    expect(plugin.definition.onEnvironmentReleaseLease).toBeTypeOf("function");
    expect(plugin.definition.onEnvironmentDestroyLease).toBeTypeOf("function");
    expect(plugin.definition.onEnvironmentRealizeWorkspace).toBeTypeOf("function");
    expect(plugin.definition.onEnvironmentExecute).toBeTypeOf("function");
  });

  it("returns ok: false on onEnvironmentValidateConfig with skeleton message", async () => {
    const result = await plugin.definition.onEnvironmentValidateConfig?.({
      driverKey: "docker",
      config: {},
    });

    expect(result).toEqual({
      ok: false,
      errors: ["docker sandbox provider is a skeleton: not implemented (OPE-12633)"],
    });
  });

  it("returns ok: false on onEnvironmentProbe", async () => {
    const result = await plugin.definition.onEnvironmentProbe?.({
      driverKey: "docker",
      companyId: "company-1",
      environmentId: "env-1",
      config: {},
    });

    expect(result).toEqual({
      ok: false,
      summary: "not implemented",
    });
  });

  it("rejects onEnvironmentAcquireLease with not implemented error", async () => {
    await expect(
      plugin.definition.onEnvironmentAcquireLease?.({
        driverKey: "docker",
        companyId: "company-1",
        environmentId: "env-1",
        runId: "run-1",
        config: {},
      }),
    ).rejects.toThrow("docker sandbox provider: onEnvironmentAcquireLease is not implemented");
  });

  it("rejects onEnvironmentResumeLease with not implemented error", async () => {
    await expect(
      plugin.definition.onEnvironmentResumeLease?.({
        driverKey: "docker",
        companyId: "company-1",
        environmentId: "env-1",
        providerLeaseId: "lease-1",
        config: {},
      }),
    ).rejects.toThrow("docker sandbox provider: onEnvironmentResumeLease is not implemented");
  });

  it("rejects onEnvironmentReleaseLease with not implemented error", async () => {
    await expect(
      plugin.definition.onEnvironmentReleaseLease?.({
        driverKey: "docker",
        companyId: "company-1",
        environmentId: "env-1",
        providerLeaseId: "lease-1",
        config: {},
      }),
    ).rejects.toThrow("docker sandbox provider: onEnvironmentReleaseLease is not implemented");
  });

  it("rejects onEnvironmentDestroyLease with not implemented error", async () => {
    await expect(
      plugin.definition.onEnvironmentDestroyLease?.({
        driverKey: "docker",
        companyId: "company-1",
        environmentId: "env-1",
        providerLeaseId: "lease-1",
        config: {},
      }),
    ).rejects.toThrow("docker sandbox provider: onEnvironmentDestroyLease is not implemented");
  });

  it("rejects onEnvironmentRealizeWorkspace with not implemented error", async () => {
    await expect(
      plugin.definition.onEnvironmentRealizeWorkspace?.({
        driverKey: "docker",
        companyId: "company-1",
        environmentId: "env-1",
        config: {},
        lease: {
          providerLeaseId: "lease-1",
        },
        workspace: {},
      }),
    ).rejects.toThrow("docker sandbox provider: onEnvironmentRealizeWorkspace is not implemented");
  });

  it("rejects onEnvironmentExecute with not implemented error", async () => {
    await expect(
      plugin.definition.onEnvironmentExecute?.({
        driverKey: "docker",
        companyId: "company-1",
        environmentId: "env-1",
        config: {},
        lease: {
          providerLeaseId: "lease-1",
        },
        command: "ls",
      }),
    ).rejects.toThrow("docker sandbox provider: onEnvironmentExecute is not implemented");
  });
});
