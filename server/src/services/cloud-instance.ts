import { readProductEnvFrom } from "@myrmidon/shared/env-alias"; // myrmidon(REBRAND-C)

export type CloudInstanceEnv = Record<string, string | undefined>;

export type CloudStackContext = {
  stackId: string | null;
  stackSlug: string | null;
  accountGroupId: string | null;
  primaryHost: string | null;
  cloudOrigin: string | null;
};

function normalizeOptionalEnvValue(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

/**
 * The canonical Paperclip Cloud instance predicate.
 *
 * The managed-config flag and tenant-server credential indicate a Cloud-managed
 * instance. Either non-empty new-name or compatibility name keeps the restrictive floor.
 */
export function isCloudManagedInstance(
  env: CloudInstanceEnv = process.env,
): boolean {
  return (
    normalizeOptionalEnvValue(readProductEnvFrom(env, "CLOUD_TENANT_SERVER_TOKEN")) !== null ||
    readProductEnvFrom(env, "MANAGED_CONFIG") !== undefined
  );
}

/**
 * Public stack metadata injected by the Paperclip Cloud provisioner.
 *
 * A managed signal can exist briefly before every metadata value is available,
 * so absent or blank values are represented as null rather than making health
 * checks fail. Self-hosted instances never expose a stack context.
 */
export function getCloudStackContext(
  env: CloudInstanceEnv = process.env,
): CloudStackContext | null {
  if (!isCloudManagedInstance(env)) return null;

  return {
    stackId: normalizeOptionalEnvValue(readProductEnvFrom(env, "CLOUD_STACK_ID")),
    stackSlug: normalizeOptionalEnvValue(readProductEnvFrom(env, "STACK_SLUG")),
    accountGroupId: normalizeOptionalEnvValue(readProductEnvFrom(env, "CLOUD_ACCOUNT_GROUP_ID")),
    primaryHost: normalizeOptionalEnvValue(readProductEnvFrom(env, "PRIMARY_HOST")),
    cloudOrigin: normalizeOptionalEnvValue(readProductEnvFrom(env, "CLOUD_API_ORIGIN")),
  };
}
