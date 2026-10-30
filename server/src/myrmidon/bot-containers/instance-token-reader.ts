// myrmidon(SETTINGS-UI E2.3): server-side reader for an instance token that a bot/fleet route
// needs. Order: the emergency environment override, then the bound secret reference (the
// E2.1 resolver; the consumer must be registered for the setting). A missing, denied or
// unreadable reference gives null, which the caller already treats as "not configured".
// Only the typed error code is logged, never a value.

import type { Db } from "@myrmidon/db";
import { logger } from "../../middleware/logger.js";
import { registerSecretValues } from "../secret-masking.js";
import { defaultInstanceSecretSettingRegistry } from "../secret-settings/registry.js";
import { createInstanceSecretSettingResolver } from "../secret-settings/resolver.js";
import { createDbInstanceSecretSettingStore } from "../secret-settings/wiring.js";

export type InstanceTokenReader = () => Promise<string | null>;

type Resolver = Pick<ReturnType<typeof createInstanceSecretSettingResolver>, "resolve">;

/** The reader over a resolver that is built on first use (so a database handle is not touched earlier). */
export function createTokenReaderFromResolver(
  getResolver: () => Resolver,
  setting: string,
  consumerId: string,
): InstanceTokenReader {
  return async () => {
    try {
      const resolved = await getResolver().resolve(setting, { consumerId });
      const value = resolved.value.trim();
      return value.length > 0 ? value : null;
    } catch (err) {
      const details = (err as { details?: { code?: unknown } } | null)?.details;
      logger.warn(
        { settingName: setting, consumerId, code: typeof details?.code === "string" ? details.code : "unresolved" },
        "instance token not resolved; treated as not configured",
      );
      return null;
    }
  };
}

export function createInstanceTokenReader(
  db: Db,
  setting: string,
  consumerId: string,
  env?: NodeJS.ProcessEnv,
): InstanceTokenReader {
  let resolver: Resolver | null = null;
  return createTokenReaderFromResolver(
    () =>
      (resolver ??= createInstanceSecretSettingResolver({
        registry: defaultInstanceSecretSettingRegistry,
        store: createDbInstanceSecretSettingStore(db),
        env,
        registerForRedaction: (value) => registerSecretValues({ v: value }, ["v"]),
      })),
    setting,
    consumerId,
  );
}
