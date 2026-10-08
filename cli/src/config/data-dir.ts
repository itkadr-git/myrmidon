import path from "node:path";
import {
  expandHomePrefix,
  resolveDefaultConfigPath,
  resolveDefaultContextPath,
  resolvePaperclipInstanceId,
} from "./home.js";
import { readProductEnv, writeProductEnv } from "@paperclipai/shared/env-alias"; // myrmidon(REBRAND-C)

export interface DataDirOptionLike {
  dataDir?: string;
  config?: string;
  context?: string;
  instance?: string;
}

export interface DataDirCommandSupport {
  hasConfigOption?: boolean;
  hasContextOption?: boolean;
}

export function applyDataDirOverride(
  options: DataDirOptionLike,
  support: DataDirCommandSupport = {},
): string | null {
  const rawDataDir = options.dataDir?.trim();
  if (!rawDataDir) return null;

  const resolvedDataDir = path.resolve(expandHomePrefix(rawDataDir));
  writeProductEnv(process.env, "HOME", resolvedDataDir); // myrmidon(REBRAND-C)

  if (support.hasConfigOption) {
    const hasConfigOverride = Boolean(options.config?.trim()) || Boolean(readProductEnv("CONFIG")?.trim());
    if (!hasConfigOverride) {
      const instanceId = resolvePaperclipInstanceId(options.instance);
      writeProductEnv(process.env, "INSTANCE_ID", instanceId); // myrmidon(REBRAND-C)
      writeProductEnv(process.env, "CONFIG", resolveDefaultConfigPath(instanceId)); // myrmidon(REBRAND-C)
    }
  }

  if (support.hasContextOption) {
    const hasContextOverride = Boolean(options.context?.trim()) || Boolean(readProductEnv("CONTEXT")?.trim());
    if (!hasContextOverride) {
      writeProductEnv(process.env, "CONTEXT", resolveDefaultContextPath()); // myrmidon(REBRAND-C)
    }
  }

  return resolvedDataDir;
}
