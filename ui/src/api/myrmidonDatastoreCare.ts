// ui/src/api/myrmidonDatastoreCare.ts
//
// myrmidon(OPE-12613): API client for the datastore-care retention settings —
// the UI half of the DB-CARE panel on Settings → System. The server core
// (`server/src/myrmidon/datastore-care/retention/routes.ts`) serves
// `GET /api/myrmidon/datastore-care` (any board member: the resolved retention
// values with their sources plus the last compaction pass state) and
// `PATCH /api/myrmidon/datastore-care` (instance-admin only; partial per
// field — absent keeps, null clears to env/default, a value stores it; the
// answer echoes the accepted patch). The patch type comes from
// @myrmidon/shared so the UI cannot drift from the core.

import type { DatastoreCareRetentionPatch } from "@myrmidon/shared";
import type { DatastoreCareRetentionLastRun } from "@myrmidon/shared";
import { api } from "./client";

/** The GET answer: resolved retention values with sources + the last pass.
 * The source of `externalMachineBackup` is derived client-side by the panel
 * (see Ui2DatastoreRetentionSettings) — the endpoint carries no env override
 * for this knob, only the resolved value. */
export interface DatastoreCareRetentionView {
  retention: {
    heartbeatRunContextDays: number;
    source: "settings" | "env" | "default";
    contextCompactMaxBatches: number;
    contextCompactMaxBatchesSource: "settings" | "env" | "default";
    externalMachineBackup: boolean;
  };
  lastRun: DatastoreCareRetentionLastRun;
}

export const datastoreCareQueryKey = ["myrmidon", "datastore-care"] as const;

export const datastoreCareApi = {
  get: () => api.get<DatastoreCareRetentionView>("/myrmidon/datastore-care"),
  update: (patch: DatastoreCareRetentionPatch) =>
    api.patch<DatastoreCareRetentionPatch>("/myrmidon/datastore-care", patch),
};
