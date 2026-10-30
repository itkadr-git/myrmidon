// myrmidon(SETTINGS-UI E2.6): process-wide access for application consumers.
//
// Consumers that read an optional credential at call time (not at import time) resolve it
// through here: emergency env override first, then the bound secret ref. The resolver is
// installed once from app.ts; without it (unit tests, CLI) only the env override applies.
// Missing ref reads as null so an optional integration stays off; denied, inactive or
// provider errors are logged by code only (never the value) and also read as null, so a
// revoked reference fails closed instead of falling back to a stale value.

import { logger } from "../../middleware/logger.js";
import { HttpError } from "../../errors.js";
import { defaultInstanceSecretSettingRegistry } from "./registry.js";
import type { InstanceSecretSettingResolver } from "./resolver.js";

let installed: InstanceSecretSettingResolver | null = null;

export function installInstanceSecretResolver(resolver: InstanceSecretSettingResolver | null) {
  installed = resolver;
}

export async function resolveOptionalInstanceSecret(
  name: string,
  consumerId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const descriptor = defaultInstanceSecretSettingRegistry.get(name);
  if (!descriptor) return null;
  const envValue = env[descriptor.envOverride]?.trim();
  if (envValue) return envValue;
  if (!installed) return null;
  try {
    return (await installed.resolve(name, { consumerId })).value;
  } catch (err) {
    const code =
      err instanceof HttpError && err.details && typeof err.details === "object"
        ? ((err.details as { code?: unknown }).code ?? "error")
        : "error";
    if (code !== "setting_ref_missing") {
      logger.warn({ settingName: name, consumerId, code }, "instance secret setting could not be resolved");
    }
    return null;
  }
}
