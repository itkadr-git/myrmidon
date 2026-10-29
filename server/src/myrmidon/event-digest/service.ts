import { randomUUID } from "node:crypto";
import type {
  AgentEvent,
  BufferedEvent,
  EventDigest,
  EventDispatchResult,
} from "./types.js";
import {
  classifyEventPriority,
  isDigestAccumulatedPriority,
  isImmediateWakePriority,
} from "./policy.js";

export class EventDigestService {
  private buffers = new Map<string, BufferedEvent[]>();

  /**
   * Records an event for an agent.
   * If the event priority is P3 or P4, it is appended to the pending digest buffer.
   */
  public recordEvent(event: AgentEvent): BufferedEvent {
    const priority = event.priority ?? classifyEventPriority(event.type);
    const buffered: BufferedEvent = {
      id: event.id ?? randomUUID(),
      agentId: event.agentId,
      issueId: event.issueId ?? null,
      type: event.type,
      priority,
      payload: event.payload ?? {},
      timestamp: event.timestamp ?? new Date(),
    };

    if (isDigestAccumulatedPriority(priority)) {
      const existing = this.buffers.get(event.agentId) ?? [];
      existing.push(buffered);
      this.buffers.set(event.agentId, existing);
    }

    return buffered;
  }

  /**
   * Inspect the current pending digest for an agent without clearing it.
   */
  public getPendingDigest(agentId: string): EventDigest | null {
    const list = this.buffers.get(agentId);
    if (!list || list.length === 0) return null;
    return this.buildDigest(agentId, [...list]);
  }

  /**
   * Clears and returns all accumulated events for an agent as a delivered digest.
   */
  public drainDigest(agentId: string): EventDigest | null {
    const list = this.buffers.get(agentId);
    if (!list || list.length === 0) return null;
    this.buffers.delete(agentId);
    return this.buildDigest(agentId, list);
  }

  /**
   * Dispatches an event according to its priority:
   * - P3/P4: records to pending digest without waking the agent.
   * - P0/P1: wakes the agent immediately, attaching the drained accumulated digest.
   * - P2: actionable event — wakes the agent and delivers accumulated digest.
   */
  public async handleAgentEvent(
    event: AgentEvent,
    deps: {
      wakeup: (
        agentId: string,
        context: Record<string, unknown>,
      ) => Promise<unknown>;
    },
  ): Promise<EventDispatchResult> {
    const buffered = this.recordEvent(event);

    if (isDigestAccumulatedPriority(buffered.priority)) {
      return {
        woken: false,
        event: buffered,
        digest: this.getPendingDigest(buffered.agentId),
      };
    }

    if (isImmediateWakePriority(buffered.priority) || buffered.priority === "P2") {
      const drained = this.drainDigest(buffered.agentId);
      // If there were no prior low-priority events, provide a digest of this triggering event,
      // or if there were accumulated events, append or deliver them.
      const deliveredDigest: EventDigest = drained
        ? {
            agentId: buffered.agentId,
            issueId: buffered.issueId ?? drained.issueId ?? null,
            events: [...drained.events, buffered],
            eventCount: drained.eventCount + 1,
            oldestEventAt: drained.oldestEventAt < buffered.timestamp ? drained.oldestEventAt : buffered.timestamp,
            newestEventAt: buffered.timestamp,
          }
        : {
            agentId: buffered.agentId,
            issueId: buffered.issueId ?? null,
            events: [buffered],
            eventCount: 1,
            oldestEventAt: buffered.timestamp,
            newestEventAt: buffered.timestamp,
          };

      await deps.wakeup(buffered.agentId, {
        wakeReason: buffered.type,
        priority: buffered.priority,
        triggeringEvent: buffered,
        eventDigest: deliveredDigest,
      });

      return {
        woken: true,
        event: buffered,
        digest: deliveredDigest,
        wakeReason: buffered.type,
      };
    }

    // Default fallback: do not wake
    return {
      woken: false,
      event: buffered,
      digest: this.getPendingDigest(buffered.agentId),
    };
  }

  private buildDigest(agentId: string, events: BufferedEvent[]): EventDigest {
    const sorted = [...events].sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
    );
    const oldestEventAt = sorted[0].timestamp;
    const newestEventAt = sorted[sorted.length - 1].timestamp;

    return {
      agentId,
      issueId: sorted[sorted.length - 1]?.issueId ?? null,
      events: sorted,
      eventCount: sorted.length,
      oldestEventAt,
      newestEventAt,
    };
  }

  /**
   * Clear all pending buffers (useful for testing isolation).
   */
  public reset(): void {
    this.buffers.clear();
  }
}

let defaultService: EventDigestService | null = null;

export function getSharedEventDigestService(): EventDigestService {
  if (!defaultService) {
    defaultService = new EventDigestService();
  }
  return defaultService;
}

/**
 * Dispatches an event through the shared event digest service and an underlying
 * heartbeat wakeup provider.
 */
export async function dispatchAgentEvent(
  event: AgentEvent,
  heartbeat: {
    wakeup: (
      agentId: string,
      opts?: Record<string, unknown>,
    ) => Promise<unknown>;
  },
): Promise<EventDispatchResult> {
  const service = getSharedEventDigestService();
  return service.handleAgentEvent(event, {
    wakeup: async (agentId, context) => {
      return heartbeat.wakeup(agentId, {
        reason: context.wakeReason as string,
        contextSnapshot: context,
      });
    },
  });
}
