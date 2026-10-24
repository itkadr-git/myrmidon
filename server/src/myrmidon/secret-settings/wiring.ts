// myrmidon(SETTINGS-UI E2.1): database-backed store for the instance secret-ref resolver.
// A ref is a row of `company_secret_bindings` (target `system`, id `instance-setting:<name>`,
// path `ref`), so resolution reuses the secrets service: binding check, status, version,
// provider, and the secret access event. No new table, no plaintext column.

import { and, eq } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import { companySecretBindings, companySecrets } from "@myrmidon/db";
import { secretService } from "../../services/secrets.js";
import { registerSecretValues } from "../secret-masking.js";
import {
  createInstanceSecretSettingResolver,
  type InstanceSecretSettingStore,
} from "./resolver.js";
import {
  defaultInstanceSecretSettingRegistry,
  type InstanceSecretSettingRegistry,
} from "./registry.js";

export const INSTANCE_SECRET_SETTING_TARGET_TYPE = "system" as const;
export const INSTANCE_SECRET_SETTING_CONFIG_PATH = "ref";

export function instanceSecretSettingTargetId(name: string) {
  return `instance-setting:${name}`;
}

export function createDbInstanceSecretSettingStore(db: Db): InstanceSecretSettingStore {
  const secrets = secretService(db);
  return {
    async getBinding(name) {
      const row = await db
        .select({
          companyId: companySecretBindings.companyId,
          secretId: companySecretBindings.secretId,
        })
        .from(companySecretBindings)
        .where(
          and(
            eq(companySecretBindings.targetType, INSTANCE_SECRET_SETTING_TARGET_TYPE),
            eq(companySecretBindings.targetId, instanceSecretSettingTargetId(name)),
            eq(companySecretBindings.configPath, INSTANCE_SECRET_SETTING_CONFIG_PATH),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);
      return row;
    },
    async resolveValue(input) {
      return secrets.resolveSecretValue(input.companyId, input.secretId, "latest", {
        consumerType: INSTANCE_SECRET_SETTING_TARGET_TYPE,
        consumerId: instanceSecretSettingTargetId(input.settingName),
        configPath: INSTANCE_SECRET_SETTING_CONFIG_PATH,
        actorType: "system",
        actorId: input.consumerId,
      });
    },
    async describeSecret(secretId) {
      const row = await secrets.getById(secretId);
      return row ? { name: row.name, status: row.status, companyId: row.companyId } : null;
    },
    async createSecret(input) {
    const created = await secrets.create(input.companyId, {
      name: input.name,
      provider: "local_encrypted",
      value: input.value,
      description: input.description,
    });
      return created.id;
    },
    async findSecretByName(companyId, name) {
      const row = await db
        .select({ id: companySecrets.id })
        .from(companySecrets)
        .where(and(eq(companySecrets.companyId, companyId), eq(companySecrets.name, name)))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      return row?.id ?? null;
    },
    async deleteSecret(secretId) {
      await secrets.remove(secretId);
    },
    async setBinding(name, secretId) {
      const [ref] = await secrets.replaceSecretRefsForInstanceTarget(
        {
          targetType: INSTANCE_SECRET_SETTING_TARGET_TYPE,
          targetId: instanceSecretSettingTargetId(name),
        },
        [{ secretId, configPath: INSTANCE_SECRET_SETTING_CONFIG_PATH, label: name }],
      );
      return { companyId: ref.companyId, secretId: ref.secretId };
    },
    async clearBinding(name) {
      await secrets.replaceSecretRefsForInstanceTarget(
        {
          targetType: INSTANCE_SECRET_SETTING_TARGET_TYPE,
          targetId: instanceSecretSettingTargetId(name),
        },
        [],
      );
      return true;
    },
  };
}

export function createInstanceSecretSettingService(
  db: Db,
  registry: InstanceSecretSettingRegistry = defaultInstanceSecretSettingRegistry,
  env?: NodeJS.ProcessEnv,
) {
  return createInstanceSecretSettingResolver({
    registry,
    env,
    store: createDbInstanceSecretSettingStore(db),
    registerForRedaction: (value) => registerSecretValues({ v: value }, ["v"]),
  });
}
