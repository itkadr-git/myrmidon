export interface ExternalSessionSchedulerOptions {
  /** Maximum active sessions for the same credential/account. */
  concurrencyPerCredential: number;
  /** Accept an opaque, company-owned registry reference, never a credential secret. */
  authorizeCredential?: (credentialId: string) => Promise<boolean> | boolean;
}

export interface ExternalSessionSchedulerSnapshot {
  activeByCredential: Readonly<Record<string, number>>;
  queuedByCredential: Readonly<Record<string, number>>;
}

interface QueueEntry<T> {
  credentialId: string;
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  runId?: string;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/** In-process FIFO scheduler. Callers must pass opaque credential IDs, never secrets. */
export class ExternalSessionScheduler {
  private readonly active = new Map<string, number>();
  private readonly queues = new Map<string, QueueEntry<unknown>[]>();
  private readonly concurrencyPerCredential: number;
  private readonly authorizeCredential: (credentialId: string) => Promise<boolean> | boolean;

  constructor(options: ExternalSessionSchedulerOptions) {
    if (!Number.isInteger(options.concurrencyPerCredential) || options.concurrencyPerCredential < 1) {
      throw new Error("concurrencyPerCredential must be a positive integer");
    }
    this.concurrencyPerCredential = options.concurrencyPerCredential;
    this.authorizeCredential = options.authorizeCredential ?? (() => true);
  }

  async schedule<T>(
    credentialId: string,
    run: () => Promise<T>,
    options: { runId?: string; signal?: AbortSignal } = {},
  ): Promise<T> {
    if (!credentialId.trim()) throw new Error("credentialId is required");
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("Run cancelled");
    if (!(await this.authorizeCredential(credentialId))) {
      throw new Error("credentialId is not authorized");
    }
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("Run cancelled");

    return new Promise<T>((resolve, reject) => {
      const queue = this.queues.get(credentialId) ?? [];
      const entry = {
        credentialId, run, resolve, reject, runId: options.runId, signal: options.signal,
      } as QueueEntry<unknown>;
      if (options.signal) {
        entry.onAbort = () => {
          const pending = this.queues.get(credentialId);
          if (!pending) return;
          const index = pending.indexOf(entry);
          if (index < 0) return;
          pending.splice(index, 1);
          options.signal?.removeEventListener("abort", entry.onAbort!);
          if (!pending.length) this.queues.delete(credentialId);
          reject(options.signal?.reason ?? new Error("Run cancelled"));
        };
        options.signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      queue.push(entry);
      this.queues.set(credentialId, queue);
      this.drain(credentialId);
    });
  }

  cancel(runId: string, reason: unknown = new Error("Run cancelled")): boolean {
    for (const [credentialId, queue] of this.queues) {
      const entry = queue.find((candidate) => candidate.runId === runId);
      if (!entry) continue;
      queue.splice(queue.indexOf(entry), 1);
      if (!queue.length) this.queues.delete(credentialId);
      if (entry.signal && entry.onAbort) entry.signal.removeEventListener("abort", entry.onAbort);
      entry.reject(reason);
      return true;
    }
    return false;
  }

  snapshot(): ExternalSessionSchedulerSnapshot {
    return {
      activeByCredential: Object.fromEntries(this.active),
      queuedByCredential: Object.fromEntries(
        [...this.queues].map(([credentialId, queue]) => [credentialId, queue.length]),
      ),
    };
  }

  private drain(credentialId: string): void {
    const queue = this.queues.get(credentialId);
    if (!queue?.length || (this.active.get(credentialId) ?? 0) >= this.concurrencyPerCredential) return;

    const entry = queue.shift()!;
    if (entry.signal && entry.onAbort) entry.signal.removeEventListener("abort", entry.onAbort);
    if (!queue.length) this.queues.delete(credentialId);
    this.active.set(credentialId, (this.active.get(credentialId) ?? 0) + 1);

    void Promise.resolve()
      .then(entry.run)
      .then(entry.resolve, entry.reject)
      .finally(() => {
        const activeCount = (this.active.get(credentialId) ?? 1) - 1;
        if (activeCount === 0) this.active.delete(credentialId);
        else this.active.set(credentialId, activeCount);
        this.drain(credentialId);
      });
  }
}

/** Shared across heartbeatService instances in this server process. */
export const externalSessionScheduler = new ExternalSessionScheduler({
  concurrencyPerCredential: Math.max(
    1,
    Number.parseInt(process.env.EXTERNAL_SESSION_CONCURRENCY_PER_CREDENTIAL ?? "1", 10) || 1,
  ),
});
