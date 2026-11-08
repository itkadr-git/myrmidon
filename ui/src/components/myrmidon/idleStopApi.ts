import { api } from "@/api/client";

export interface IdleStopSettings {
  enabled: boolean;
  afterSec: number;
  healthTimeoutMs: number;
}

export type IdleStopMode = "on_demand" | "always_on";

export interface IdleStopBot {
  agentId: string;
  name: string;
  mode: IdleStopMode;
  /** Container state; null when the runtime could not be asked. */
  state: string | null;
  idleStopped: boolean;
  lastStoppedAt: string | null;
  lastStartedAt: string | null;
}

export const idleStopBotsQueryKey = ["myrmidon", "idle-stop", "bots"] as const;
export const idleStopQueryKey = ["myrmidon", "idle-stop"] as const;

export const idleStopApi = {
  get: () => api.get<{ settings: IdleStopSettings }>("/myrmidon/idle-stop"),
  update: (patch: Partial<IdleStopSettings>) =>
    api.patch<{ settings: IdleStopSettings }>("/myrmidon/idle-stop", patch),
  bots: () => api.get<{ bots: IdleStopBot[] }>("/myrmidon/idle-stop/bots"),
  setBotMode: (agentIds: string[], mode: IdleStopMode) =>
    api.patch<{ updated: number; skipped: string[]; mode: IdleStopMode }>("/myrmidon/idle-stop/bots", { agentIds, mode }),
};
