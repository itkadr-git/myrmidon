// myrmidon(SETTINGS-UI E2.2): process-level access to the instance secret-ref resolver for
// server-side consumers that have no database handle of their own (for example the Codex
// model discovery). app.ts installs the resolver once at startup. A consumer asks for a
// registered setting by name and its own consumer id; the resolver still enforces the
// consumer scope, the emergency env override and the stored reference.
//
// The helper never throws and never returns a reason that carries a value: a missing,
// denied, inactive or unreadable reference gives `null`, so the caller falls back to its
// previous behavior. Only the typed error code is logged.

import { logger } from "../../middleware/logger.js";
import type { InstanceSecretSettingResolver } from "./resolver.js";

let installed: InstanceSecretSettingResolver | null = null;

export function setInstanceSecretSettingResolver(resolver: InstanceSecretSettingResolver | null) {
  installed = resolver;
}

export async function resolveInstanceSecretOrNull(
  name: string,
  consumerId: string,
): Promise<string | null> {
  if (!installed) return null;
  try {
    const resolved = await installed.resolve(name, { consumerId });
    const value = resolved.value.trim();
    return value.length > 0 ? value : null;
  } catch (err) {
    const code =
      typeof err === "object" && err !== null && "details" in err
        ? ((err as { details?: { code?: unknown } }).details?.code ?? null)
        : null;
    logger.warn(
      { settingName: name, consumerId, code: typeof code === "string" ? code : "unresolved" },
      "instance secret setting not resolved; using the consumer fallback",
    );
    return null;
  }
}
