// server/src/myrmidon/data-retention/service.ts
//
// myrmidon(1.6.5-DB-RETENTION): the read/write face of the retention sweep
// for the routes.
//
// `read()` composes the DataRetentionView the frozen inter-part contract
// fixes: the three retention values with their per-key source
// ("settings" | "default") plus the persisted sweep state. `update()` merges
// a validated patch into the stored object (the sweep's `lastRun` survives),
// writes one activity line per company like every instance settings change,
// and returns the fresh view. The sweep re-reads the settings at the top of
// every pass, so the change applies on the next pass without a restart.

import {
  DATA_RETENTION_SETTINGS_KEY,
  DATA_RETENTION_UPDATED_ACTION,
  dataRetentionSources,
  emptyDataRetentionLastRun,
  normalizeDataRetentionLastRun,
  normalizeDataRetentionSettings,
  type DataRetentionSettingsPatch,
  type DataRetentionView,
} from "@paperclipai/shared";
import type { LogActivityInput } from "../../services/activity-log.js";
import {
  readDataRetentionSettings,
  writeDataRetentionSettings,
  type DataRetentionSettingsService,
} from "./settings.js";

export interface DataRetentionActor {
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  agentId: string | null;
  runId: string | null;
  agentApiKeyId: string | null;
}

export interface DataRetentionServiceDeps {
  settings: DataRetentionSettingsService;
  listCompanyIds(): Promise<string[]>;
  logActivity(entry: LogActivityInput): Promise<unknown>;
}

export interface DataRetentionService {
  read(): Promise<DataRetentionView>;
  update(
    patch: DataRetentionSettingsPatch,
    actor: DataRetentionActor,
  ): Promise<DataRetentionView>;
}

export function dataRetentionService(deps: DataRetentionServiceDeps): DataRetentionService {
  async function read(): Promise<DataRetentionView> {
    const general = (await deps.settings.getGeneral()) as unknown as Record<string, unknown>;
    const stored = general[DATA_RETENTION_SETTINGS_KEY];
    const lastRunRaw =
      typeof stored === "object" && stored !== null
        ? (stored as Record<string, unknown>).lastRun
        : undefined;
    return {
      settings: normalizeDataRetentionSettings(stored),
      sources: dataRetentionSources(stored),
      status:
        lastRunRaw === undefined
          ? emptyDataRetentionLastRun()
          : normalizeDataRetentionLastRun(lastRunRaw),
    };
  }

  async function update(
    patch: DataRetentionSettingsPatch,
    actor: DataRetentionActor,
  ): Promise<DataRetentionView> {
    const before = await readDataRetentionSettings(deps.settings);
    const next = await writeDataRetentionSettings(deps.settings, patch);
    const companyIds = await deps.listCompanyIds();
    for (const companyId of companyIds) {
      await deps.logActivity({
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: DATA_RETENTION_UPDATED_ACTION,
        entityType: "instance_settings",
        entityId: DATA_RETENTION_SETTINGS_KEY,
        details: { before, after: next },
      });
    }
    return read();
  }

  return { read, update };
}

export type { DataRetentionView };
