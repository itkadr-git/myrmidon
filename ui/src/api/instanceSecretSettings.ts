// myrmidon(SETTINGS-UI E2.1): client for /api/instance/secret-settings. Instance
// admin only. Bodies and answers carry names, ids and flags - never secret values.
import { api } from "./client";

export interface InstanceSecretSettingStatus {
  name: string;
  description: string;
  envOverride: string;
  envOverrideActive: boolean;
  consumers: string[];
  ref: { secretId: string; secretName: string | null; status: string | null } | null;
  effectiveSource: "env" | "secret_ref" | "unset";
}

export interface InstanceSecretMigrationRow {
  name: string;
  envOverride: string;
  outcome: "planned" | "bound" | "skipped";
  secretId?: string;
}

export const instanceSecretSettingsApi = {
  list: () => api.get<{ settings: InstanceSecretSettingStatus[] }>("/instance/secret-settings"),
  setRef: (name: string, secretId: string) =>
    api.put<InstanceSecretSettingStatus>(`/instance/secret-settings/${encodeURIComponent(name)}/ref`, { secretId }),
  clearRef: (name: string) =>
    api.delete<InstanceSecretSettingStatus>(`/instance/secret-settings/${encodeURIComponent(name)}/ref`),
  // Dry run: the server applies nothing unless the body says apply: true, which the UI never sends.
  migrationPlan: () =>
    api.post<{ dryRun: boolean; rows: InstanceSecretMigrationRow[] }>("/instance/secret-settings/migrate", {}),
};

export const instanceSecretSettingsQueryKey = ["instance", "secret-settings"] as const;
