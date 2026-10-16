import { SECRET_PROVIDERS, type SecretProvider } from "@paperclipai/shared";
import { readProductEnv } from "@paperclipai/shared/env-alias"; // myrmidon(REBRAND-C)

export function getConfiguredSecretProvider(): SecretProvider {
  const configuredProvider = readProductEnv("SECRETS_PROVIDER");
  return configuredProvider && SECRET_PROVIDERS.includes(configuredProvider as SecretProvider)
    ? configuredProvider as SecretProvider
    : "local_encrypted";
}
