// myrmidon(SETTINGS-UI E2.5): server-side lookup of a cloud connector provider's OAuth client
// secret. The emergency env variable MYRMIDON_CLOUD_<PROVIDER>_CLIENT_SECRET wins (read by the
// resolver); otherwise the ref bound to `cloud-oauth.<provider>.client-secret` is resolved
// through the secrets service. No ref means "no client secret" (public/PKCE-only client); a
// bound but unusable ref fails typed and never degrades silently. Called only from the
// connect/refresh flows, which run after the owner/company checks of the connector routes.

import { CLOUD_OAUTH_CONSUMER, cloudOauthClientSecretSettingName } from "./registry.js";
import type { InstanceSecretSettingResolver } from "./resolver.js";

export type CloudOauthClientSecretLookup = (providerId: string) => Promise<string | null>;

export function createCloudOauthClientSecretLookup(deps: {
  resolver: Pick<InstanceSecretSettingResolver, "resolve">;
}): CloudOauthClientSecretLookup {
  return async (providerId) => {
    try {
      const out = await deps.resolver.resolve(cloudOauthClientSecretSettingName(providerId), {
        consumerId: CLOUD_OAUTH_CONSUMER,
      });
      return out.value;
    } catch (err) {
      const code = (err as { details?: { code?: string } }).details?.code;
      // Unknown provider or nothing bound: there is no client secret to add.
      if (code === "setting_ref_missing" || code === "setting_unknown") return null;
      throw err;
    }
  };
}
