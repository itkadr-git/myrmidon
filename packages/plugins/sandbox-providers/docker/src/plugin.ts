import { definePlugin } from "@myrmidon/plugin-sdk";
import type {
  PluginEnvironmentAcquireLeaseParams,
  PluginEnvironmentDestroyLeaseParams,
  PluginEnvironmentExecuteParams,
  PluginEnvironmentExecuteResult,
  PluginEnvironmentLease,
  PluginEnvironmentProbeParams,
  PluginEnvironmentProbeResult,
  PluginEnvironmentRealizeWorkspaceParams,
  PluginEnvironmentRealizeWorkspaceResult,
  PluginEnvironmentReleaseLeaseParams,
  PluginEnvironmentResumeLeaseParams,
  PluginEnvironmentValidateConfigParams,
  PluginEnvironmentValidationResult,
  PluginHealthDiagnostics,
} from "@myrmidon/plugin-sdk";

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("Docker sandbox provider plugin ready");
  },

  async onHealth(): Promise<PluginHealthDiagnostics> {
    return { status: "ok", message: "Docker sandbox provider plugin healthy" };
  },

  async onEnvironmentValidateConfig(
    _params: PluginEnvironmentValidateConfigParams,
  ): Promise<PluginEnvironmentValidationResult> {
    return {
      ok: false,
      errors: ["docker sandbox provider is a skeleton: not implemented (OPE-12633)"],
    };
  },

  async onEnvironmentProbe(
    _params: PluginEnvironmentProbeParams,
  ): Promise<PluginEnvironmentProbeResult> {
    return {
      ok: false,
      summary: "not implemented",
    };
  },

  async onEnvironmentAcquireLease(
    _params: PluginEnvironmentAcquireLeaseParams,
  ): Promise<PluginEnvironmentLease> {
    throw new Error("docker sandbox provider: onEnvironmentAcquireLease is not implemented");
  },

  async onEnvironmentResumeLease(
    _params: PluginEnvironmentResumeLeaseParams,
  ): Promise<PluginEnvironmentLease> {
    throw new Error("docker sandbox provider: onEnvironmentResumeLease is not implemented");
  },

  async onEnvironmentReleaseLease(
    _params: PluginEnvironmentReleaseLeaseParams,
  ): Promise<void> {
    throw new Error("docker sandbox provider: onEnvironmentReleaseLease is not implemented");
  },

  async onEnvironmentDestroyLease(
    _params: PluginEnvironmentDestroyLeaseParams,
  ): Promise<void> {
    throw new Error("docker sandbox provider: onEnvironmentDestroyLease is not implemented");
  },

  async onEnvironmentRealizeWorkspace(
    _params: PluginEnvironmentRealizeWorkspaceParams,
  ): Promise<PluginEnvironmentRealizeWorkspaceResult> {
    throw new Error("docker sandbox provider: onEnvironmentRealizeWorkspace is not implemented");
  },

  async onEnvironmentExecute(
    _params: PluginEnvironmentExecuteParams,
  ): Promise<PluginEnvironmentExecuteResult> {
    throw new Error("docker sandbox provider: onEnvironmentExecute is not implemented");
  },
});

export default plugin;
