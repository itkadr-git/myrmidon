import { api } from "@/api/client";

export interface IdleStopSettings {
  enabled: boolean;
  afterSec: number;
  healthTimeoutMs: number;
}

export const idleStopQueryKey = ["myrmidon", "idle-stop"] as const;

export const idleStopApi = {
  get: () => api.get<{ settings: IdleStopSettings }>("/myrmidon/idle-stop"),
  update: (patch: Partial<IdleStopSettings>) =>
    api.patch<{ settings: IdleStopSettings }>("/myrmidon/idle-stop", patch),
};
