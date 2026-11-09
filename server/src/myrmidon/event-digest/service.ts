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

// myrmidon(OPE-9657 fix, 01.11): the buffer and the delivered digest are bounded. Without a cap a busy
// agent accumulated 3 812 events (every coalesced P2 wake was rolled back into the buffer), the wake
// prompt grew to 4-8 M characters and the bot's hermes process was OOM-killed at 2 GB.
export const MAX_BUFFERED_EVENTS_PER_AGENT = 200;
export const MAX_DIGEST_EVENTS = 30;
export const MAX_DIGEST_PAYLOAD_CHARS = 2_000;

// One entry per (type, issue, comment) — a comment wake that is re-dispatched or coalesced again is the same
// event, not a new one. The newest occurrence is kept and takes its place in the order.
function dedupeKey(entry: BufferedEvent): string {
  const payload = (entry.payload ?? {}) as Record<string, unknown>;
  const commentId = typeof payload.commentId === "string" ? payload.commentId : "";
  return commentId ? `${entry.type}|${entry.issueId ?? ""}|${commentId}` : `id|${entry.id}`;
}

function keepNewest(events: BufferedEvent[]): BufferedEvent[] {
  const byKey = new Map<string, BufferedEvent>();
  for (const entry of events) {
    const key = dedupeKey(entry);
    byKey.delete(key);
    byKey.set(key, entry);
  }
  const unique = [...byKey.values()];
  return unique.length > MAX_BUFFERED_EVENTS_PER_AGENT
    ? unique.slice(unique.length - MAX_BUFFERED_EVENTS_PER_AGENT)
    : unique;
}

const MAX_DIGEST_STRING_CHARS = 300;

function compactValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") {
    return value.length > MAX_DIGEST_STRING_CHARS ? `${value.slice(0, MAX_DIGEST_STRING_CHARS)}…` : value;
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= 3) return "[…]";
  if (Array.isArray(value)) {
    const head = value.slice(0, 20).map((item) => compactValue(item, depth + 1));
    return value.length > 20 ? [...head, `…+${value.length - 20}`] : head;
  }
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] = compactValue(inner, depth + 1);
  }
  return out;
}

// Identifiers and short fields stay as they are; only long strings, deep nesting and long arrays are cut.
function compactPayload(payload: BufferedEvent["payload"]): BufferedEvent["payload"] {
  let text: string;
  try {
    text = JSON.stringify(payload ?? {});
  } catch {
    return { truncated: true } as BufferedEvent["payload"];
  }
  if (text.length <= MAX_DIGEST_PAYLOAD_CHARS) return payload;
  const compacted = compactValue(payload ?? {}, 0) as BufferedEvent["payload"];
  return { ...(compacted as Record<string, unknown>), truncated: true } as BufferedEvent["payload"];
}

/**
 * Bounds any digest before it is stored in a run context or rendered into a wake prompt — also a
 * digest copied from an older run snapshot (written before the buffer was capped).
 */
export function boundEventDigest<T>(digest: T): T {
  if (!digest || typeof digest !== "object") return digest;
  const raw = digest as unknown as { events?: unknown; eventCount?: unknown };
  if (!Array.isArray(raw.events)) return digest;
  const events = raw.events as BufferedEvent[];
  const kept = events
    .slice(Math.max(0, events.length - MAX_DIGEST_EVENTS))
    .map((entry) => ({ ...entry, payload: compactPayload(entry?.payload) }));
  const total = typeof raw.eventCount === "number" ? raw.eventCount : events.length;
  return { ...(digest as object), events: kept, eventCount: total, omittedEventCount: total - kept.length } as T;
}

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
      this.buffers.set(event.agentId, keepNewest(existing));
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
    if (triggeringEvent) {
      combined.push(triggeringEvent);
    }

    if (combined.length === 0) {
      return null;
    }

    const bounded = keepNewest(combined);
    this.preparedDigests.set(agentId, bounded);
    this.buffers.delete(agentId);

    return this.buildDigest(agentId, bounded);
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
    // Original semantics kept: everything staged goes back. Re-dispatched / coalesced wakes of the same
    // comment collapse into one entry (dedupe) and the buffer stays bounded, so they no longer pile up.
    const current = this.buffers.get(agentId) ?? [];
    this.buffers.set(agentId, keepNewest([...prepared, ...current]));
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
        const wakeResult = await deps.wakeup(buffered.agentId, {
          wakeReason: buffered.type,
          priority: buffered.priority,
          triggeringEvent: buffered,
          eventDigest: deliveredDigest,
        });

        if (
          wakeResult === null ||
          wakeResult === false ||
          (typeof wakeResult === "object" &&
            wakeResult !== null &&
            "woken" in wakeResult &&
            !(wakeResult as any).woken) ||
          (typeof wakeResult === "object" &&
            wakeResult !== null &&
            "created" in wakeResult &&
            !(wakeResult as any).created)
        ) {
          this.rollbackPendingDigest(buffered.agentId);
          return {
            woken: false,
            event: buffered,
            digest: this.getPendingDigest(buffered.agentId),
          };
        }

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

    const delivered = sorted
      .slice(Math.max(0, sorted.length - MAX_DIGEST_EVENTS))
      .map((entry) => ({ ...entry, payload: compactPayload(entry.payload) }));

    return {
      agentId,
      issueId: sorted[sorted.length - 1]?.issueId ?? null,
      events: delivered,
      eventCount: sorted.length,
      omittedEventCount: sorted.length - delivered.length,
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
