import type {
  InstanceExperimentalSettings,
  InstanceExperimentalSettingsWithManaged,
  InstanceGeneralSettings,
  InstanceSettings,
  PatchInstanceSettings,
  PatchInstanceGeneralSettings,
  PatchInstanceExperimentalSettings,
  StartTaskDrainRequest,
} from "@myrmidon/shared";

export type {
  InstanceExperimentalSettings,
  InstanceExperimentalSettingsWithManaged,
  InstanceGeneralSettings,
  InstanceSettings,
  PatchInstanceSettings,
  PatchInstanceGeneralSettings,
  PatchInstanceExperimentalSettings,
};
import { api } from "./client";

export interface TaskDrainStatus {
  draining: boolean;
  startedAt: string | null;
  expiresAt: string | null;
  activeRuns: number;
  pendingWakes: number;
  quiescent: boolean;
}

export interface TaskDrainStartResult {
  startedAt: string;
  expiresAt: string | null;
}

export interface TaskDrainStopResult {
  wasActive: boolean;
}

export const taskDrainQueryKey = ["instance", "task-drain"] as const;

export const instanceSettingsApi = {
  get: () =>
    api.get<InstanceSettings>("/instance/settings"),
  update: (patch: PatchInstanceSettings) =>
    api.patch<InstanceSettings>("/instance/settings", patch),
  getGeneral: () =>
    api.get<InstanceGeneralSettings>("/instance/settings/general"),
  updateGeneral: (patch: PatchInstanceGeneralSettings) =>
    api.patch<InstanceGeneralSettings>("/instance/settings/general", patch),
  getExperimental: () =>
    api.get<InstanceExperimentalSettingsWithManaged>("/instance/settings/experimental"),
  updateExperimental: (patch: PatchInstanceExperimentalSettings) =>
    api.patch<InstanceExperimentalSettingsWithManaged>("/instance/settings/experimental", patch),
  getTaskDrain: () =>
    api.get<TaskDrainStatus>("/instance/task-drain"),
  startTaskDrain: (body: StartTaskDrainRequest = {}) =>
    api.post<TaskDrainStartResult>("/instance/task-drain", body),
  stopTaskDrain: () =>
    api.delete<TaskDrainStopResult>("/instance/task-drain"),
};
