import type { DeploymentMode, DeploymentExposure } from "@paperclipai/shared";
import { readProductEnv } from "@paperclipai/shared/env-alias"; // myrmidon(REBRAND-C)

/** Same server-host boundary as local stdio runtimes. */
export function supportsLocalAiLogin(options: {
  deploymentMode?: DeploymentMode;
  deploymentExposure?: DeploymentExposure;
  trustedLocalStdioRuntimeHost?: string | null;
}) {
  return options.deploymentMode !== "authenticated" || options.deploymentExposure !== "public" || Boolean(
    options.trustedLocalStdioRuntimeHost ?? readProductEnv("TRUSTED_MCP_RUNTIME_HOST") ?? readProductEnv("TOOL_RUNTIME_TRUSTED_HOST"),
  );
}
