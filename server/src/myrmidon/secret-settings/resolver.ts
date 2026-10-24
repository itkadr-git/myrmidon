// myrmidon(SETTINGS-UI E2.1): server-side resolver for instance secret-ref settings.
//
// Order of resolution for a registered setting:
//   1. the consumer must be in the descriptor's `consumers` (scope) -> else forbidden;
//   2. the documented emergency env override, when set and non-empty, wins;
//   3. otherwise the bound secret reference is resolved through the secrets service
//      (binding check, active status, version, provider) -> else a typed error.
// The value is only ever returned to the in-process caller. Errors, plans and listings
// carry names, ids and booleans, never values.

import type { InstanceSecretSettingDescriptor, InstanceSecretSettingRegistry } from "./registry.js";
import { forbidden, notFound, unprocessable } from "../../errors.js";

export type InstanceSecretBinding = { companyId: string; secretId: string };

export type InstanceSecretSettingStore = {
  getBinding(name: string): Promise<InstanceSecretBinding | null>;
  /** Resolve through the secrets service; must enforce binding, status and provider. */
  resolveValue(input: {
    companyId: string;
    secretId: string;
    settingName: string;
    consumerId: string;
  }): Promise<string>;
  describeSecret(
    secretId: string,
  ): Promise<{ name: string; status: string; companyId: string } | null>;
  /** Create a managed secret holding `value`; returns its id. The value is never echoed. */
  createSecret(input: {
    companyId: string;
    name: string;
    value: string;
    description: string;
  }): Promise<string>;
  findSecretByName(companyId: string, name: string): Promise<string | null>;
  /** Compensate if a new secret could not be bound. */
  deleteSecret(secretId: string): Promise<void>;
  setBinding(name: string, secretId: string): Promise<InstanceSecretBinding>;
  clearBinding(name: string): Promise<boolean>;
};

export type ResolvedInstanceSecretSetting = {
  source: "env" | "secret_ref";
  value: string;
};

export type InstanceSecretSettingStatus = {
  name: string;
  description: string;
  envOverride: string;
  envOverrideActive: boolean;
  consumers: string[];
  ref: { secretId: string; secretName: string | null; status: string | null } | null;
  effectiveSource: "env" | "secret_ref" | "unset";
};

export type InstanceSecretMigrationPlanRow = {
  name: string;
  envOverride: string;
  envPresent: boolean;
  refBound: boolean;
  action: "none" | "create_secret_and_bind" | "unset_env_when_ready";
};

export type InstanceSecretMigrationResultRow = {
  name: string;
  envOverride: string;
  outcome: "planned" | "bound" | "skipped" | "error";
  errorCode?: "migration_failed" | "migration_secret_name_conflict";
  /** Only for `bound`: the id of the secret now referenced. Never a value. */
  secretId?: string;
};

function requireDescriptor(
  registry: InstanceSecretSettingRegistry,
  name: string,
): InstanceSecretSettingDescriptor {
  const descriptor = registry.get(name);
  if (!descriptor) {
    throw notFound("Unknown instance secret setting", { code: "setting_unknown" });
  }
  return descriptor;
}

function readEnv(env: NodeJS.ProcessEnv, key: string): string | null {
  const raw = env[key];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function createInstanceSecretSettingResolver(deps: {
  registry: InstanceSecretSettingRegistry;
  store: InstanceSecretSettingStore;
  env?: NodeJS.ProcessEnv;
  registerForRedaction?: (value: string) => void;
}) {
  const { registry, store } = deps;
  const getEnv = () => deps.env ?? process.env;

  async function resolve(
    name: string,
    context: { consumerId: string },
  ): Promise<ResolvedInstanceSecretSetting> {
    const descriptor = requireDescriptor(registry, name);
    if (!descriptor.consumers.includes(context.consumerId)) {
      throw forbidden("Consumer is not allowed to resolve this setting", {
        code: "setting_consumer_denied",
        settingName: name,
      });
    }

    const envValue = readEnv(getEnv(), descriptor.envOverride);
    if (envValue !== null) {
      deps.registerForRedaction?.(envValue);
      return { source: "env", value: envValue };
    }

    const binding = await store.getBinding(name);
    if (!binding) {
      throw unprocessable("Instance secret setting has no secret reference", {
        code: "setting_ref_missing",
        settingName: name,
      });
    }
    const value = await store.resolveValue({
      companyId: binding.companyId,
      secretId: binding.secretId,
      settingName: name,
      consumerId: context.consumerId,
    });
    deps.registerForRedaction?.(value);
    return { source: "secret_ref", value };
  }

  async function status(name: string): Promise<InstanceSecretSettingStatus> {
    const descriptor = requireDescriptor(registry, name);
    const envOverrideActive = readEnv(getEnv(), descriptor.envOverride) !== null;
    const binding = await store.getBinding(name);
    const secret = binding ? await store.describeSecret(binding.secretId) : null;
    return {
      name: descriptor.name,
      description: descriptor.description,
      envOverride: descriptor.envOverride,
      envOverrideActive,
      consumers: [...descriptor.consumers],
      ref: binding
        ? {
            secretId: binding.secretId,
            secretName: secret?.name ?? null,
            status: secret?.status ?? null,
          }
        : null,
      effectiveSource: envOverrideActive ? "env" : binding ? "secret_ref" : "unset",
    };
  }

  async function list(): Promise<InstanceSecretSettingStatus[]> {
    const rows: InstanceSecretSettingStatus[] = [];
    for (const descriptor of registry.list()) rows.push(await status(descriptor.name));
    return rows;
  }

  async function setRef(name: string, secretId: string): Promise<InstanceSecretSettingStatus> {
    requireDescriptor(registry, name);
    const secret = await store.describeSecret(secretId);
    if (!secret || secret.status === "deleted") {
      throw unprocessable("Referenced secret was not found", { code: "secret_missing" });
    }
    if (secret.status !== "active") {
      throw unprocessable("Referenced secret is not active", { code: "secret_inactive" });
    }
    await store.setBinding(name, secretId);
    return status(name);
  }

  async function clearRef(name: string): Promise<InstanceSecretSettingStatus> {
    requireDescriptor(registry, name);
    await store.clearBinding(name);
    return status(name);
  }

  /** Dry-run: what migrating env-held values into refs would require. Reads no values. */
  async function migrationPlan(): Promise<InstanceSecretMigrationPlanRow[]> {
    const rows: InstanceSecretMigrationPlanRow[] = [];
    for (const descriptor of registry.list()) {
      const envPresent = readEnv(getEnv(), descriptor.envOverride) !== null;
      const refBound = (await store.getBinding(descriptor.name)) !== null;
      let action: InstanceSecretMigrationPlanRow["action"] = "none";
      if (envPresent && !refBound) action = "create_secret_and_bind";
      else if (envPresent && refBound) action = "unset_env_when_ready";
      rows.push({
        name: descriptor.name,
        envOverride: descriptor.envOverride,
        envPresent,
        refBound,
        action,
      });
    }
    return rows;
  }

  /**
   * Move env-held values into secrets and bind them. Dry-run unless `apply` is
   * exactly true. Only settings that have a value in env and no ref are touched;
   * the env variable itself is left in place (the operator unsets it afterwards).
   * The value is read here, handed to the store and dropped: it is not returned,
   * logged or put into an error.
   */
  async function migrate(options: {
    apply?: boolean;
    companyId?: string | null;
    onBound?: (name: string, secretId: string) => Promise<void>;
  }): Promise<{ dryRun: boolean; rows: InstanceSecretMigrationResultRow[] }> {
    const apply = options.apply === true;
    if (apply && !options.companyId) {
      throw unprocessable("companyId is required to apply the migration", { code: "migration_company_required" });
    }
    const rows: InstanceSecretMigrationResultRow[] = [];
    for (const descriptor of registry.list()) {
      let createdSecretId: string | null = null;
      try {
        const value = readEnv(getEnv(), descriptor.envOverride);
        const bound = (await store.getBinding(descriptor.name)) !== null;
        const row: InstanceSecretMigrationResultRow = {
          name: descriptor.name,
          envOverride: descriptor.envOverride,
          outcome: value !== null && !bound ? "planned" : "skipped",
        };
        if (apply && value !== null && !bound) {
          const companyId = options.companyId as string;
          const secretName = `instance-setting.${descriptor.name}`;
          let secretId = await store.findSecretByName(companyId, secretName);
          if (!secretId) {
            createdSecretId = await store.createSecret({
              companyId,
              name: secretName,
              value,
              description: `Migrated from ${descriptor.envOverride}`,
            });
            secretId = createdSecretId;
          }
          const existing = await store.describeSecret(secretId);
          if (!existing || existing.companyId !== companyId || existing.name !== secretName) {
            throw unprocessable("A secret with the migration name already exists", {
              code: "migration_secret_name_conflict",
              settingName: descriptor.name,
            });
          }
          await store.setBinding(descriptor.name, secretId);
          await options.onBound?.(descriptor.name, secretId);
          deps.registerForRedaction?.(value);
          row.outcome = "bound";
          row.secretId = secretId;
          createdSecretId = null;
        }
        rows.push(row);
      } catch (err) {
        if (createdSecretId) {
          try {
            await store.deleteSecret(createdSecretId);
          } catch {
            // Keep the row failure and attempt cleanup without exposing the underlying error.
          }
        }
        const details = err && typeof err === "object" && "details" in err
          ? (err as { details?: { code?: string } }).details
          : undefined;
        rows.push({
          name: descriptor.name,
          envOverride: descriptor.envOverride,
          outcome: "error",
          errorCode: details?.code === "migration_secret_name_conflict"
            ? "migration_secret_name_conflict"
            : "migration_failed",
        });
      }
    }
    return { dryRun: !apply, rows };
  }

  return { resolve, status, list, setRef, clearRef, migrationPlan, migrate };
}

export type InstanceSecretSettingResolver = ReturnType<typeof createInstanceSecretSettingResolver>;
