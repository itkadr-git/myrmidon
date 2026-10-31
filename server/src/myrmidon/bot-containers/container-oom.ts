// myrmidon(OPE-9253): read-only Docker OOM evidence. Exit 137 alone is NOT OOM.
export interface ContainerOomObservation {
  containerId: string;
  occurredAt: string;
  memoryLimitBytes: number | null;
}

export function containerOomObservation(info: {
  Id?: string;
  State?: { OOMKilled?: boolean; FinishedAt?: string };
  HostConfig?: { Memory?: number };
}): ContainerOomObservation | null {
  const timestamp = info.State?.FinishedAt;
  if (info.State?.OOMKilled !== true || !info.Id || !timestamp) return null;
  const time = Date.parse(timestamp);
  // Docker's year-0001 sentinel is not evidence of a completed OOM.
  if (!Number.isFinite(time) || time <= 0) return null;
  const memory = info.HostConfig?.Memory;
  return {
    containerId: info.Id,
    occurredAt: new Date(time).toISOString(),
    memoryLimitBytes: typeof memory === "number" && Number.isSafeInteger(memory) && memory > 0 ? memory : null,
  };
}
