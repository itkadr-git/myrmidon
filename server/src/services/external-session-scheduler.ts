export interface ExternalSessionSchedulerOptions {
  /** Maximum active sessions for the same credential/account. */
  concurrencyPerCredential: number;
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
}

/** In-process FIFO scheduler. Callers must pass opaque credential IDs, never secrets. */
export class ExternalSessionScheduler {
  private readonly active = new Map<string, number>();
  private readonly queues = new Map<string, QueueEntry<unknown>[]>();
  private readonly concurrencyPerCredential: number;

  constructor(options: ExternalSessionSchedulerOptions) {
    if (!Number.isInteger(options.concurrencyPerCredential) || options.concurrencyPerCredential < 1) {
      throw new Error("concurrencyPerCredential must be a positive integer");
    }
    this.concurrencyPerCredential = options.concurrencyPerCredential;
  }

  schedule<T>(credentialId: string, run: () => Promise<T>): Promise<T> {
    if (!credentialId.trim()) return Promise.reject(new Error("credentialId is required"));

    return new Promise<T>((resolve, reject) => {
      const queue = this.queues.get(credentialId) ?? [];
      queue.push({ credentialId, run, resolve, reject } as QueueEntry<unknown>);
      this.queues.set(credentialId, queue);
      this.drain(credentialId);
    });
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
