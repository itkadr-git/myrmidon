// Live vendor-name gate setting (myrmidon 1.7 REBRAND-F) service.
//
// Contract: `instance_settings.general.vendorNameCheck` is the source of truth
// once an operator saves it; the environment
// (`MYRMIDON_VENDOR_NAME_CHECK_MODE` / `MYRMIDON_VENDOR_NAME_CHECK_BASELINE`)
// stays the forced override for an instance that never did (see
// packages/shared/src/myrmidon-vendor-name.ts for the precedence and the value
// rules). The mode is read at request time, so a settings-page change reaches
// the next read without a restart — and it reaches the gate the next time CI or
// a developer runs it, because the gate reads the environment, not the database.
//
// The read-write-audit sequence runs through one queue (the same serialization
// RUNTIME-LIMITS and BUDGET-CONFIG-B use) so two overlapping requests cannot
// commit their rows in one order and audit them in the other.

import type { Db } from "@paperclipai/db";
import {
  mergeVendorNameCheckSettings,
  normalizeVendorNameCheckSettings,
  resolveVendorNameCheckSettings,
  type ResolvedVendorNameCheckSettings,
  type VendorNameCheckPatch,
  type VendorNameCheckSettings,
} from "@paperclipai/shared";
import { instanceSettingsService, logActivity } from "../../services/index.js";
import { scanVendorName, type VendorNameScanResult } from "./scan.js";

export interface VendorNameCheckView extends ResolvedVendorNameCheckSettings {
  /** The gate's own answer about this build, or why it cannot answer. */
  scan: VendorNameScanResult;
}

/** Who changed the setting, for the activity log. */
export interface VendorNameCheckActor {
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  agentId: string | null;
  runId: string | null;
  agentApiKeyId: string | null;
}

export type VendorNameCheckAuditEntry = VendorNameCheckActor & {
  companyId: string;
  action: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown>;
};

/** Everything the service needs, so tests can run it without a database. */
export interface VendorNameCheckServiceDeps {
  getGeneral(): Promise<{ vendorNameCheck?: unknown }>;
  updateGeneral(patch: {
    vendorNameCheck: Partial<{ mode: VendorNameCheckSettings["mode"]; baseline: number }>;
  }): Promise<unknown>;
  listCompanyIds(): Promise<string[]>;
  logActivity(entry: VendorNameCheckAuditEntry): Promise<unknown>;
  scan(): Promise<VendorNameScanResult>;
  env?: Record<string, string | undefined>;
}

export interface VendorNameCheckService {
  /** The setting in force, where each value came from, and the gate's answer. */
  read(): Promise<VendorNameCheckView>;
  /** Persist and audit a change; returns the setting now in force. */
  update(patch: VendorNameCheckPatch, actor: VendorNameCheckActor): Promise<VendorNameCheckView>;
}

/** `instance.vendor_name_check.updated` — the audit action of a settings change. */
export const VENDOR_NAME_CHECK_ACTION = "instance.vendor_name_check.updated";

let vendorNameCheckTransitionQueue: Promise<void> = Promise.resolve();

function withVendorNameCheckTransition<T>(run: () => Promise<T>): Promise<T> {
  const turn = vendorNameCheckTransitionQueue.then(run);
  // Normalize to a settled void promise for the next caller in line, so a
  // rejected transition cannot wedge every later one behind it.
  vendorNameCheckTransitionQueue = turn.then(
    () => undefined,
    () => undefined,
  );
  return turn;
}

/** The stored value, or null when the row carries nothing usable. */
async function readStored(
  deps: VendorNameCheckServiceDeps,
): Promise<VendorNameCheckSettings | null> {
  try {
    const general = await deps.getGeneral();
    return normalizeVendorNameCheckSettings(general?.vendorNameCheck);
  } catch {
    return null;
  }
}

export function vendorNameCheckService(
  db: Db,
  overrides: Partial<VendorNameCheckServiceDeps> = {},
): VendorNameCheckService {
  const settings = instanceSettingsService(db);
  const deps: VendorNameCheckServiceDeps = {
    getGeneral: () => settings.getGeneral(),
    updateGeneral: (patch) => settings.updateGeneral({ vendorNameCheck: patch.vendorNameCheck }),
    listCompanyIds: () => settings.listCompanyIds(),
    logActivity: (entry) => logActivity(db, entry),
    scan: () => scanVendorName(),
    ...overrides,
  };
  const env = deps.env ?? process.env;

  const view = async (stored: VendorNameCheckSettings | null): Promise<VendorNameCheckView> => ({
    ...resolveVendorNameCheckSettings({ stored, env }),
    scan: await deps.scan(),
  });

  return {
    read: async (): Promise<VendorNameCheckView> => view(await readStored(deps)),

    update: async (patch, actor) =>
      withVendorNameCheckTransition(async () => {
        // The patch is merged onto the STORED value, never onto the resolved
        // one: writing the resolved object back would bake an active
        // environment override into the database as an operator's own choice.
        const stored = mergeVendorNameCheckSettings(await readStored(deps), patch);
        await deps.updateGeneral({ vendorNameCheck: stored });
        const companyIds = await deps.listCompanyIds();
        await Promise.all(
          companyIds.map((companyId) =>
            deps.logActivity({
              companyId,
              actorType: actor.actorType,
              actorId: actor.actorId,
              agentId: actor.agentId,
              runId: actor.runId,
              agentApiKeyId: actor.agentApiKeyId,
              action: VENDOR_NAME_CHECK_ACTION,
              entityType: "instance_settings",
              entityId: "vendorNameCheck",
              details: { mode: stored.mode, baseline: stored.baseline },
            }),
          ),
        );
        return view(stored);
      }),
  };
}