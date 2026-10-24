// myrmidon(SETTINGS-UI E2.1): database-backed store for the instance secret-ref resolver.
// A ref is a row of `company_secret_bindings` (target `system`, id `instance-setting:<name>`,
// path `ref`), so resolution reuses the secrets service: binding check, status, version,
// provider, and the secret access event. No new table, no plaintext column.

import { and, eq } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import { companySecretBindings, toolApplications, toolConnections } from "@myrmidon/db";
import { secretService } from "../../services/secrets.js";
import { registerSecretValues } from "../secret-masking.js";
import {
  createInstanceSecretSettingResolver,
  type InstanceSecretSettingStore,
} from "./resolver.js";
import {
  defaultInstanceSecretSettingRegistry,
  type InstanceSecretSettingRegistry,
  toolOauthProviderSecretSettingName,
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
  const resolver = createInstanceSecretSettingResolver({
    registry,
    env,
    store: createDbInstanceSecretSettingStore(db),
    registerForRedaction: (value) => registerSecretValues({ v: value }, ["v"]),
  });
  return {
    ...resolver,
    async list() {
      const connections = await db
        .select({
          config: toolConnections.config,
          name: toolConnections.name,
          applicationName: toolApplications.name,
          applicationKey: toolApplications.applicationKey,
        })
        .from(toolConnections)
        .innerJoin(toolApplications, eq(toolApplications.id, toolConnections.applicationId))
        .where(and(eq(toolConnections.authKind, "oauth"), eq(toolConnections.connectionPurpose, "tool")));
      const names = new Set<string>();
      for (const connection of connections) {
        const config = connection.config as Record<string, unknown>;
        const oauth = config.oauth && typeof config.oauth === "object" && !Array.isArray(config.oauth)
          ? config.oauth as Record<string, unknown>
          : {};
        const provider = typeof oauth.provider === "string" && oauth.provider.trim()
          ? oauth.provider.trim()
          : typeof config.sourceTemplateKey === "string" && config.sourceTemplateKey.trim()
            ? config.sourceTemplateKey.trim()
            : connection.applicationKey || connection.applicationName || connection.name;
        const name = toolOauthProviderSecretSettingName(provider);
        if (name) names.add(name);
      }
      return resolver.list([...names]);
    },
  };
}
