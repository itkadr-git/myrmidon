// myrmidon(SETTINGS-UI E2.1): registry of instance settings whose value may come from
// a scoped secret reference instead of a process environment variable.
//
// A consumer part (cloud connector OAuth, tool OAuth, bot containers, ...) adds one entry
// per secret name it reads. An entry names:
//   - `name`        the stable setting id (also the binding target id),
//   - `envOverride` the documented emergency environment variable. When it is set and
//                   non-empty it wins over the stored reference (break-glass priority),
//   - `consumers`   the server-side consumer ids allowed to resolve the value (scope).
//
// Bootstrap names (the credentials the secrets provider itself needs: AWS_ACCESS_KEY_ID,
// AWS_SECRET_ACCESS_KEY, MYRMIDON_SECRETS_MASTER_KEY, ...) must NOT be registered: a secret
// store cannot hold the key that opens it. They stay environment-only; the disposition table
// is in docs/myrmidon/e2-secret-coverage-1.6.6.md.

import { SANDBOX_PROVIDER_REGISTRY_ENTRIES } from "./sandbox-providers.js";
import { RUNNER_ACPX_CODEX_AUTH_REGISTRY_ENTRY } from "./runner-environment.js";
export const TOOL_OAUTH_CONSUMER = "tool-access.oauth";
export const TOOL_OAUTH_CLIENT_SECRET_SETTING = "tool-oauth.client-secret";

/** Provider slug as used in the setting name; same folding as the legacy env name. */
export function toolOauthProviderSlug(provider: string): string {
  return provider.replace(/[^a-z0-9]+/gi, "_").toLowerCase();
}

export function toolOauthProviderSecretSettingName(provider: string): string | null {
  const slug = toolOauthProviderSlug(provider);
  return slug ? `tool-oauth.${slug}.client-secret` : null;
}

function toolOauthProviderEnvName(slug: string): string {
  return `PAPERCLIP_TOOL_OAUTH_${slug.toUpperCase()}_CLIENT_SECRET`;
}
import { BOT_FLEET_SECRET_SETTINGS } from "./bot-fleet-settings.js"; // myrmidon(SETTINGS-UI E2.3)

export type InstanceSecretSettingDescriptor = {
  readonly name: string;
  readonly envOverride: string;
  readonly description: string;
  readonly consumers: readonly string[];
};

/**
 * A family of settings whose member names are built at runtime (for example one tool OAuth
 * client secret per provider). A member is addressed as `<prefix><key><suffix>`; its
 * emergency env variable is derived by `envFor`. Members are not enumerated in `list()`.
 */
export type InstanceSecretSettingFamily = {
  readonly prefix: string;
  readonly suffix: string;
  readonly keyPattern: RegExp;
  readonly envFor: (key: string) => string;
  readonly description: string;
  readonly consumers: readonly string[];
};

const NAME_RE = /^[a-z][a-z0-9_.-]{1,80}$/;
const ENV_RE = /^[A-Z][A-Z0-9_]{1,120}$/;

export class InstanceSecretSettingRegistry {
  private readonly byName = new Map<string, InstanceSecretSettingDescriptor>();
  private readonly families: InstanceSecretSettingFamily[];

  constructor(
    entries: readonly InstanceSecretSettingDescriptor[],
    families: readonly InstanceSecretSettingFamily[] = [],
  ) {
    this.families = families.map((family) => {
      if (family.consumers.length === 0) {
        throw new Error(`Instance secret setting family ${family.prefix} needs a consumer`);
      }
      return Object.freeze({ ...family, consumers: [...family.consumers] });
    });
    for (const entry of entries) {
      if (!NAME_RE.test(entry.name)) {
        throw new Error(`Invalid instance secret setting name: ${entry.name}`);
      }
      if (!ENV_RE.test(entry.envOverride)) {
        throw new Error(`Invalid env override name for ${entry.name}`);
      }
      if (entry.consumers.length === 0) {
        throw new Error(`Instance secret setting ${entry.name} needs at least one consumer`);
      }
      if (this.byName.has(entry.name)) {
        throw new Error(`Duplicate instance secret setting: ${entry.name}`);
      }
      this.byName.set(entry.name, Object.freeze({ ...entry, consumers: [...entry.consumers] }));
    }
  }

  get(name: string): InstanceSecretSettingDescriptor | null {
    const exact = this.byName.get(name);
    if (exact) return exact;
    for (const family of this.families) {
      if (!name.startsWith(family.prefix) || !name.endsWith(family.suffix)) continue;
      if (name.length <= family.prefix.length + family.suffix.length) continue;
      const key = name.slice(family.prefix.length, name.length - family.suffix.length);
      if (!family.keyPattern.test(key)) continue;
      const envOverride = family.envFor(key);
      if (!ENV_RE.test(envOverride) || !NAME_RE.test(name)) continue;
      return Object.freeze({
        name,
        envOverride,
        description: family.description,
        consumers: [...family.consumers],
      });
    }
    return null;
  }

  list(): InstanceSecretSettingDescriptor[] {
    return [...this.byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
}

/** Consumer parts append their entries here. Empty until the first consumer lands. */
export const INSTANCE_SECRET_SETTINGS: readonly InstanceSecretSettingDescriptor[] = [
  ...SANDBOX_PROVIDER_REGISTRY_ENTRIES, // E2.8 (OPE-9041)
  RUNNER_ACPX_CODEX_AUTH_REGISTRY_ENTRY, // E2.8 (OPE-9041)
  ...BOT_FLEET_SECRET_SETTINGS, // myrmidon(SETTINGS-UI E2.3)
  // E2.4 (OPE-9037): instance-wide fallback OAuth client secret for tool connections.
  {
    name: TOOL_OAUTH_CLIENT_SECRET_SETTING,
    envOverride: "MYRMIDON_TOOL_OAUTH_CLIENT_SECRET",
    description: "Fallback OAuth client secret for tool providers without their own",
    consumers: [TOOL_OAUTH_CONSUMER],
  },
];

/** Consumer parts append their dynamic families here. */
export const INSTANCE_SECRET_SETTING_FAMILIES: readonly InstanceSecretSettingFamily[] = [
  // E2.4 (OPE-9037): one OAuth client secret per tool provider.
  {
    prefix: "tool-oauth.",
    suffix: ".client-secret",
    keyPattern: /^[a-z0-9_]+$/,
    envFor: toolOauthProviderEnvName,
    description: "OAuth client secret of one tool provider",
    consumers: [TOOL_OAUTH_CONSUMER],
  },
];

export const defaultInstanceSecretSettingRegistry = new InstanceSecretSettingRegistry(
  INSTANCE_SECRET_SETTINGS,
  INSTANCE_SECRET_SETTING_FAMILIES,
);
