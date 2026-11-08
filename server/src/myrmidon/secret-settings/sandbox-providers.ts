// myrmidon(SETTINGS-UI E2.8): instance-level credentials of the first-party sandbox
// provider plugins (Daytona, E2B, exe.dev, Novita).
//
// The plugin worker runs with a scrubbed environment. The host resolves the credential
// server-side (scope -> emergency env override -> bound secret ref) and hands it to the
// worker through the process environment variable the plugin already documents as its
// fallback. Nothing is written to disk and the value is registered for log masking.

import type { InstanceSecretSettingDescriptor } from "./registry.js";
import type { InstanceSecretSettingResolver } from "./resolver.js";

export type SandboxProviderSecretSetting = {
  readonly driverKey: string;
  readonly envVar: string;
  readonly settingName: string;
  readonly consumerId: string;
};

function entry(driverKey: string, envVar: string): SandboxProviderSecretSetting {
  return {
    driverKey,
    envVar,
    settingName: `sandbox.${driverKey}.api_key`,
    consumerId: `plugin-worker:${driverKey}`,
  };
}

export const SANDBOX_PROVIDER_SECRET_SETTINGS: readonly SandboxProviderSecretSetting[] = [
  entry("daytona", "DAYTONA_API_KEY"),
  entry("e2b", "E2B_API_KEY"),
  entry("exe-dev", "EXE_API_KEY"),
  entry("novita", "NOVITA_API_KEY"),
];

export const SANDBOX_PROVIDER_REGISTRY_ENTRIES: readonly InstanceSecretSettingDescriptor[] =
  SANDBOX_PROVIDER_SECRET_SETTINGS.map((s) => ({
    name: s.settingName,
    envOverride: s.envVar,
    description: `Instance-wide ${s.driverKey} sandbox provider API key (used when an environment omits its own key).`,
    consumers: [s.consumerId],
  }));

export type SandboxSecretLogger = {
  warn(obj: Record<string, unknown>, msg: string): void;
};

/**
 * Resolve the instance credential for one env var of a trusted sandbox provider worker.
 * Returns null when nothing is configured or resolution fails; the failure is logged by
 * code only (never the value) and the plugin then reports its own "API key required".
 */
export async function resolveSandboxProviderSecret(
  resolver: Pick<InstanceSecretSettingResolver, "resolve">,
  envVar: string,
  log?: SandboxSecretLogger,
): Promise<string | null> {
  const setting = SANDBOX_PROVIDER_SECRET_SETTINGS.find((s) => s.envVar === envVar);
  if (!setting) return null;
  try {
    const resolved = await resolver.resolve(setting.settingName, { consumerId: setting.consumerId });
    return resolved.value.trim().length > 0 ? resolved.value : null;
  } catch (err) {
    const code = (err as { details?: { code?: string } }).details?.code ?? "resolve_failed";
    if (code !== "setting_ref_missing") {
      log?.warn({ settingName: setting.settingName, code }, "sandbox provider secret ref could not be resolved");
    }
    return null;
  }
}
