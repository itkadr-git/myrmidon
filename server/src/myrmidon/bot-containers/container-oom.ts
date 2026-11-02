// myrmidon(OPE-9934, OPE-9253): Docker & cgroup OOM evidence.
// Exit 137 alone is NOT OOM. Both PID 1 death and child-process OOM (cgroup memory.events
// oom_kill while PID 1 remains alive) are captured.

export type ContainerOomSource = "docker.inspect" | "docker.events" | "cgroup.memory_events";

export interface ContainerOomObservation {
  containerId: string;
  occurredAt: string;
  memoryLimitBytes: number | null;
  source: ContainerOomSource;
  botKey?: string;
  cgroupOomKills?: number | null;
}

export interface DriverOomEvent {
  containerId: string;
  botKey: string;
  name?: string;
  time: number;
  timeNano: number;
  source: ContainerOomSource;
  cgroupOomKills?: number | null;
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
    source: "docker.inspect",
  };
}

export function dockerEventOomObservation(
  event: DriverOomEvent,
  memoryLimitBytes?: number | null,
): ContainerOomObservation {
  const timeMs = event.timeNano > 0 ? Math.floor(event.timeNano / 1e6) : event.time * 1000;
  return {
    containerId: event.containerId,
    occurredAt: new Date(timeMs).toISOString(),
    memoryLimitBytes: typeof memoryLimitBytes === "number" && memoryLimitBytes > 0 ? memoryLimitBytes : null,
    source: event.source || "docker.events",
    botKey: event.botKey,
    cgroupOomKills: event.cgroupOomKills ?? null,
  };
}
