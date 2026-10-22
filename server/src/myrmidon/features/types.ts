// myrmidon(FEATURES): the contract between the feature registry and the modules.
//
// A module implements a `FeatureDefinition`: how to read its effective config
// and how to report its health. Everything a definition reads from the outside
// world comes through `FeaturePorts`, so a definition is a pure function of
// (settings, environment, ports) and tests run it with plain objects.

import type {
  FeatureConfigEntry,
  FeatureHealth,
  FeatureHealthStatus,
  FeatureSettingsLink,
  FeatureToggle,
} from "@paperclipai/shared";
import type { OutcomeSummary } from "./recorder.js";

export type { FeatureConfigEntry, FeatureHealth, FeatureHealthStatus };

/** The effective config of a feature: the switch (when it has one), the entries, the inline toggle. */
export interface FeatureConfig {
  /** True when the feature's own setting turns it on, false when off, null when it has no switch. */
  enabled: boolean | null;
  entries: FeatureConfigEntry[];
  toggle?: FeatureToggle;
  /**
   * Set when the config itself is wrong (a path that cannot be right, a half-set
   * pair of variables). The health step turns it into `misconfigured`.
   */
  problems?: string[];
}

export interface RunAdmissionState {
  gate: {
    state: "off" | "unknown" | "open" | "closed";
    availableMb: number | null;
    thresholdMb: number | null;
    reason: string | null;
    heldSince: Date | null;
  };
}

export interface HostDiskState {
  at: string;
  usedPercent: number | null;
  thresholdPercent: number | null;
  overThreshold: boolean;
  error: string | null;
}

export interface WorkspaceHygieneState {
  at: string;
  scanned: number;
  measured: number;
  failed: number;
  overQuota: number;
}

/** Reads the feature modules need; the real ones query the database and the process state. */
export interface FeaturePorts {
  /** `activity_log` lines of the given actions across companies. */
  activity: {
    count(actions: string[], since: Date, detailEquals?: { key: string; value: string }): Promise<number>;
    latest(actions: string[], detailEquals?: { key: string; value: string }): Promise<Date | null>;
  };
  companies: { ids(): Promise<string[]> };
  agents: { roles(): Promise<string[]> };
  runs: {
    queuedCount(): Promise<number>;
    lastStartedAt(): Promise<Date | null>;
  };
  chatStatus: {
    /** Delivery rows of the editable DM status message since `since`. */
    stats(since: Date): Promise<{
      delivered: number;
      failed: number;
      lastDeliveredAt: Date | null;
      lastError: { at: Date | null; message: string } | null;
    }>;
  };
  costs: {
    stats(since: Date): Promise<{
      collected: number;
      lastCollectedAt: Date | null;
      /** Gateway-billed run rows still unpriced after more than an hour. */
      unpricedStale: number;
    }>;
  };
  budget: {
    stats(since: Date): Promise<{ activePolicies: number; openIncidents: number; incidentsSince: number }>;
  };
  lsp: { modeCounts(general: Record<string, unknown>): Promise<{ total: number; limited: number; full: number; off: number }> };
  runtime: {
    runAdmission(): RunAdmissionState;
    hostDisk(): HostDiskState | null;
    workspaceHygiene(): WorkspaceHygieneState | null;
  };
}

export interface FeatureContext {
  env: Record<string, string | undefined>;
  /** `instance_settings.general`, raw. */
  general: Record<string, unknown>;
  now: Date;
  /** Start of the 24-hour window. */
  since: Date;
  ports: FeaturePorts;
  /** In-process outcomes recorded by the module's own sweep, over the same window. */
  outcomes(key: string): OutcomeSummary;
}

export interface FeatureActor {
  actorType: "user" | "agent" | "system" | "plugin";
  actorId: string;
  agentId: string | null;
  runId: string | null;
  agentApiKeyId: string | null;
}

export interface FeatureDefinition {
  /** Stable key; the API and the attention dedup key use it. */
  key: string;
  name: string;
  description: string;
  /** Repository path of the guide. */
  docs: string;
  settings?: FeatureSettingsLink;
  readConfig(ctx: FeatureContext): FeatureConfig | Promise<FeatureConfig>;
  health(ctx: FeatureContext, config: FeatureConfig): FeatureHealth | Promise<FeatureHealth>;
  /** Flip the feature's own switch; present only for simple on/off features. */
  setEnabled?(
    ctx: FeatureContext & { db: import("@paperclipai/db").Db },
    enabled: boolean,
    actor: FeatureActor,
  ): Promise<void>;
}
