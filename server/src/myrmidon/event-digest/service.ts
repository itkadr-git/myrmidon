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
  private preparedDigests = new Map<string, BufferedEvent[]>();

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
   * Inspect all current pending uncommitted events for an agent without clearing them.
   */
  public getPendingDigest(agentId: string): EventDigest | null {
    const prepared = this.preparedDigests.get(agentId) ?? [];
    const current = this.buffers.get(agentId) ?? [];
    const list = [...prepared, ...current];
    if (list.length === 0) return null;
    return this.buildDigest(agentId, [...list]);
  }

  /**
   * Prepares and stages pending events for delivery as part of an upcoming wake run.
   * Staged events are held in `preparedDigests` and are not committed/cleared until
   * `commitPendingDigest` is called upon successful downstream run creation. If run
   * creation fails or is skipped, `rollbackPendingDigest` safely restores them.
   */
  public prepareDigest(
    agentId: string,
    triggeringEvent?: BufferedEvent,
  ): EventDigest | null {
    const current = this.buffers.get(agentId) ?? [];
    const alreadyPrepared = this.preparedDigests.get(agentId) ?? [];
    const combined = [...alreadyPrepared, ...current];

    if (combined.length === 0 && !triggeringEvent) {
      return null;
    }

    if (current.length > 0) {
      this.preparedDigests.set(agentId, combined);
      this.buffers.delete(agentId);
    }

    const allEvents = triggeringEvent ? [...combined, triggeringEvent] : combined;
    return this.buildDigest(agentId, allEvents);
  }

  /**
   * Atomically commits delivery of staged events once run creation succeeds.
   */
  public commitPendingDigest(agentId: string): void {
    this.preparedDigests.delete(agentId);
  }

  /**
   * Restores staged events back to the active buffer if downstream run creation
   * was skipped, deferred, or encountered a failure.
   */
  public rollbackPendingDigest(agentId: string): void {
    const prepared = this.preparedDigests.get(agentId);
    if (!prepared || prepared.length === 0) {
      this.preparedDigests.delete(agentId);
      return;
    }
    const current = this.buffers.get(agentId) ?? [];
    this.buffers.set(agentId, [...prepared, ...current]);
    this.preparedDigests.delete(agentId);
  }

  /**
   * Clears and returns all accumulated events for an agent as a delivered digest.
   * Equivalent to atomic prepare + commit.
   */
  public drainDigest(agentId: string): EventDigest | null {
    const digest = this.prepareDigest(agentId);
    this.commitPendingDigest(agentId);
    return digest;
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
      const deliveredDigest = this.prepareDigest(buffered.agentId, buffered)!;

      try {
        await deps.wakeup(buffered.agentId, {
          wakeReason: buffered.type,
          priority: buffered.priority,
          triggeringEvent: buffered,
          eventDigest: deliveredDigest,
        });
        this.commitPendingDigest(buffered.agentId);

        return {
          woken: true,
          event: buffered,
          digest: deliveredDigest,
          wakeReason: buffered.type,
        };
      } catch (err) {
        this.rollbackPendingDigest(buffered.agentId);
        throw err;
      }
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
   * Clear all pending and prepared buffers (useful for testing isolation).
   */
  public reset(): void {
    this.buffers.clear();
    this.preparedDigests.clear();
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
