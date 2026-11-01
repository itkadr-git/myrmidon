export type EventPriority = "P0" | "P1" | "P2" | "P3" | "P4";

export interface AgentEvent {
  id?: string;
  agentId: string;
  issueId?: string | null;
  type: string;
  priority?: EventPriority;
  payload?: Record<string, unknown>;
  timestamp?: Date;
}

export interface BufferedEvent {
  id: string;
  agentId: string;
  issueId?: string | null;
  type: string;
  priority: EventPriority;
  payload?: Record<string, unknown>;
  timestamp: Date;
}

export interface EventDigest {
  agentId: string;
  issueId?: string | null;
  events: BufferedEvent[];
  eventCount: number;
  oldestEventAt: Date;
  newestEventAt: Date;
}

export interface EventDispatchResult {
  woken: boolean;
  event: BufferedEvent;
  digest: EventDigest | null;
  wakeReason?: string;
}
