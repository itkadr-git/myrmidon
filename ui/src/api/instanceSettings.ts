import type {
  InstanceExperimentalSettingsWithManaged,
  InstanceGeneralSettings,
  InstanceSettings,
  PatchInstanceSettings,
  PatchInstanceGeneralSettings,
  PatchInstanceExperimentalSettings,
} from "@paperclipai/shared";
import { api } from "./client";

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
};

/** myrmidon(PROCS-0.1): one row of the board_processes registry. */
export type BoardProcess = {
  bootId: string;
  role: string;
  pid: number;
  hostname: string;
  container: string | null;
  version: string;
  startedAt: string;
  lastSeenAt: string;
  apiPort: number;
  eventLoopLagMs: number | null;
  rssBytes: number | null;
};

export const boardProcessesApi = {
  list: () => api.get<BoardProcess[]>("/instance/processes"),
};
