// myrmidon(SETTINGS-UI E2.4): server-side lookup of a tool provider's OAuth client secret.
//
// Order (first hit wins, the emergency env variables keep their break-glass priority):
//   1. PAPERCLIP_TOOL_OAUTH_<PROVIDER>_CLIENT_SECRET         (emergency env, per provider)
//   2. MYRMIDON_TOOL_OAUTH_CLIENT_SECRET / PAPERCLIP_ alias  (emergency env, instance-wide)
//   3. secret ref bound to `tool-oauth.<provider>.client-secret`
//   4. secret ref bound to `tool-oauth.client-secret`
// A missing ref is not an error here (a provider may be a public client): the caller gets
// null. A bound but unusable ref (deleted, inactive, wrong provider) fails typed, so a broken
// ref never silently degrades into an unauthenticated client. The value is never logged.

import { readProductEnvFrom } from "@myrmidon/shared/env-alias";
import {
  TOOL_OAUTH_CLIENT_SECRET_SETTING,
  TOOL_OAUTH_CONSUMER,
  toolOauthProviderSecretSettingName,
  toolOauthProviderSlug,
} from "./registry.js";
import type { InstanceSecretSettingResolver } from "./resolver.js";

function nonEmpty(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function toolOauthProviderClientSecretEnvName(provider: string) {
  return `PAPERCLIP_TOOL_OAUTH_${toolOauthProviderSlug(provider).toUpperCase()}_CLIENT_SECRET`;
}

export function createToolOauthClientSecretLookup(deps: {
  resolver: Pick<InstanceSecretSettingResolver, "resolve">;
  env?: () => NodeJS.ProcessEnv;
}) {
  const getEnv = deps.env ?? (() => process.env);

  async function resolveRef(name: string): Promise<string | null> {
    try {
      const out = await deps.resolver.resolve(name, { consumerId: TOOL_OAUTH_CONSUMER });
      return out.value;
    } catch (err) {
      const code = (err as { details?: { code?: string } }).details?.code;
      if (code === "setting_ref_missing") return null;
      throw err;
    }
  }

  return async function lookup(provider: string): Promise<string | null> {
    const env = getEnv();
    const providerEnv = nonEmpty(env[toolOauthProviderClientSecretEnvName(provider)]);
    if (providerEnv) return providerEnv;
    const instanceEnv = nonEmpty(readProductEnvFrom(env, "TOOL_OAUTH_CLIENT_SECRET"));
    if (instanceEnv) return instanceEnv;
    const providerSetting = toolOauthProviderSecretSettingName(provider);
    if (providerSetting) {
      const fromProviderRef = await resolveRef(providerSetting);
      if (fromProviderRef) return fromProviderRef;
    }
    return resolveRef(TOOL_OAUTH_CLIENT_SECRET_SETTING);
  };
}
