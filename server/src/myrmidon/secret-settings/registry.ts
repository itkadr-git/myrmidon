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

export const CLOUD_OAUTH_CONSUMER = "cloud-connector.oauth";

/** Cloud connector providers whose OAuth client secret may be a ref (E2.5, OPE-9038). */
export const CLOUD_OAUTH_PROVIDERS = [
  { id: "onedrive", envSuffix: "ONEDRIVE", label: "OneDrive" },
  { id: "google-drive", envSuffix: "GOOGLE_DRIVE", label: "Google Drive" },
  { id: "yandex-disk", envSuffix: "YANDEX_DISK", label: "Yandex Disk" },
] as const;

export function cloudOauthClientSecretSettingName(providerId: string): string {
  return `cloud-oauth.${providerId}.client-secret`;
}

export type InstanceSecretSettingDescriptor = {
  readonly name: string;
  readonly envOverride: string;
  readonly description: string;
  readonly consumers: readonly string[];
};

const NAME_RE = /^[a-z][a-z0-9_.-]{1,80}$/;
const ENV_RE = /^[A-Z][A-Z0-9_]{1,120}$/;

export class InstanceSecretSettingRegistry {
  private readonly byName = new Map<string, InstanceSecretSettingDescriptor>();

  constructor(entries: readonly InstanceSecretSettingDescriptor[]) {
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
    return this.byName.get(name) ?? null;
  }

  list(): InstanceSecretSettingDescriptor[] {
    return [...this.byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
}

/** Consumer parts append their entries here. Empty until the first consumer lands. */
export const INSTANCE_SECRET_SETTINGS: readonly InstanceSecretSettingDescriptor[] = [
  // E2.5 (OPE-9038): OAuth client secret of each cloud connector provider.
  ...CLOUD_OAUTH_PROVIDERS.map((provider) => ({
    name: cloudOauthClientSecretSettingName(provider.id),
    envOverride: `MYRMIDON_CLOUD_${provider.envSuffix}_CLIENT_SECRET`,
    description: `${provider.label} OAuth client secret of the cloud connector`,
    consumers: [CLOUD_OAUTH_CONSUMER],
  })),
];

export const defaultInstanceSecretSettingRegistry = new InstanceSecretSettingRegistry(
  INSTANCE_SECRET_SETTINGS,
);
