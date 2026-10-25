// myrmidon(SETTINGS-UI E2.8): ACPX/runner Codex auth JSON as an instance secret ref.
//
// The server builds the runner process environment per run (services/heartbeat.ts,
// `runnerEnvironment`). This resolves the value server-side (scope -> emergency env
// override -> bound ref) and returns it for that environment under the name the runner
// reads (`PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET`, packages/paperclip-runner
// drivers/acpx/codex-credentials.ts). Process env only: no file, no log of the value.
//
// The runner treats API key, inline JSON and managed credential file as mutually
// exclusive sources, so the instance value is added only when none of them is present.

import type { InstanceSecretSettingDescriptor } from "./registry.js";
import type { InstanceSecretSettingResolver } from "./resolver.js";

export const RUNNER_ACPX_CODEX_AUTH_ENV = "PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET";
export const RUNNER_ACPX_CODEX_AUTH_SETTING = "runner.acpx_codex_auth_json";
export const RUNNER_ENVIRONMENT_CONSUMER = "runner-environment";

export const RUNNER_ACPX_CODEX_AUTH_REGISTRY_ENTRY: InstanceSecretSettingDescriptor = {
  name: RUNNER_ACPX_CODEX_AUTH_SETTING,
  envOverride: RUNNER_ACPX_CODEX_AUTH_ENV,
  description: "Managed Codex auth JSON handed to the ACPX runner process environment (MYRMIDON_ alias of the same name).",
  consumers: [RUNNER_ENVIRONMENT_CONSUMER],
};

export async function resolveRunnerAcpxCodexAuthEnv(
  resolver: Pick<InstanceSecretSettingResolver, "resolve">,
  input: { existing: Record<string, string | undefined>; managedCredentialFile: boolean },
  log?: { warn(obj: Record<string, unknown>, msg: string): void },
): Promise<Record<string, string>> {
  const e = input.existing;
  if (
    input.managedCredentialFile
    || e[RUNNER_ACPX_CODEX_AUTH_ENV]
    || e.CODEX_API_KEY
    || e.OPENAI_API_KEY
  ) {
    return {};
  }
  try {
    const { value } = await resolver.resolve(RUNNER_ACPX_CODEX_AUTH_SETTING, {
      consumerId: RUNNER_ENVIRONMENT_CONSUMER,
    });
    return value.length > 0 ? { [RUNNER_ACPX_CODEX_AUTH_ENV]: value } : {};
  } catch (err) {
    const code = (err as { details?: { code?: string } }).details?.code ?? "resolve_failed";
    if (code !== "setting_ref_missing") {
      log?.warn({ settingName: RUNNER_ACPX_CODEX_AUTH_SETTING, code }, "runner credential ref could not be resolved");
    }
    return {};
  }
}
