// server/src/services/intake-queue.ts
// myrmidon(1.7 WEBHOOK-INTAKE): Queue and storage interface for received webhooks.

export type IntakeItemStatus = "pending" | "processing" | "processed" | "failed";

export interface IntakeQueueItem {
  id: string;
  source: string;
  payload: unknown;
  rawBody?: string;
  headers: Record<string, string | string[] | undefined>;
  status: IntakeItemStatus;
  retryCount?: number;
  lastError?: string | null;
  issueId?: string | null;
  issueIdentifier?: string | null;
  enqueuedAt: string;
  receivedAt: string;
  clientIp?: string;
  eventId?: string | null;
  signature?: string | null;
  metadata?: Record<string, unknown>;
}

export type EnqueueIntakeInput = {
  id?: string;
  source: string;
  payload: unknown;
  rawBody?: string;
  headers?: Record<string, string | string[] | undefined>;
  status?: IntakeItemStatus;
  retryCount?: number;
  lastError?: string | null;
  issueId?: string | null;
  issueIdentifier?: string | null;
  enqueuedAt?: string;
  receivedAt?: string;
  clientIp?: string;
  eventId?: string | null;
  signature?: string | null;
  metadata?: Record<string, unknown>;
};

export type UpdateIntakeStatusOptions = {
  metadata?: Record<string, unknown>;
  retryCount?: number;
  lastError?: string | null;
  issueId?: string | null;
  issueIdentifier?: string | null;
};

export interface IntakeQueue {
  enqueue(item: EnqueueIntakeInput): Promise<IntakeQueueItem>;
  get(id: string): Promise<IntakeQueueItem | null>;
  list(filter?: { source?: string; status?: IntakeItemStatus; limit?: number }): Promise<IntakeQueueItem[]>;
  updateStatus(
    id: string,
    status: IntakeItemStatus,
    options?: UpdateIntakeStatusOptions | Record<string, unknown>,
  ): Promise<IntakeQueueItem | null>;
  size(): Promise<number>;
  clear(): Promise<void>;
}

export class InMemoryIntakeQueue implements IntakeQueue {
  private readonly items = new Map<string, IntakeQueueItem>();
  private readonly order: string[] = [];
  private readonly maxSize: number;

  constructor(options: { maxSize?: number } = {}) {
    this.maxSize = options.maxSize ?? 10_000;
  }

  async enqueue(input: EnqueueIntakeInput): Promise<IntakeQueueItem> {
    const id = input.id ?? (await import("node:crypto")).randomUUID();
    const now = new Date().toISOString();
    const item: IntakeQueueItem = {
      id,
      source: input.source,
      payload: input.payload,
      rawBody: input.rawBody,
      headers: input.headers ?? {},
      status: input.status ?? "pending",
      retryCount: input.retryCount ?? 0,
      lastError: input.lastError ?? null,
      issueId: input.issueId ?? null,
      issueIdentifier: input.issueIdentifier ?? null,
      enqueuedAt: input.enqueuedAt ?? now,
      receivedAt: input.receivedAt ?? now,
      clientIp: input.clientIp,
      eventId: input.eventId ?? null,
      signature: input.signature ?? null,
      metadata: input.metadata,
    };

    if (this.order.length >= this.maxSize) {
      const oldestId = this.order.shift();
      if (oldestId) {
        this.items.delete(oldestId);
      }
    }

    this.items.set(id, item);
    this.order.push(id);
    return item;
  }

  async get(id: string): Promise<IntakeQueueItem | null> {
    return this.items.get(id) ?? null;
  }

  async list(filter?: { source?: string; status?: IntakeItemStatus; limit?: number }): Promise<IntakeQueueItem[]> {
    let result = this.order
      .map((id) => this.items.get(id)!)
      .filter(Boolean);

    if (filter?.source) {
      result = result.filter((item) => item.source === filter.source);
    }
    if (filter?.status) {
      result = result.filter((item) => item.status === filter.status);
    }
    if (filter?.limit && filter.limit > 0) {
      result = result.slice(0, filter.limit);
    }
    return result;
  }

  async updateStatus(
    id: string,
    status: IntakeItemStatus,
    options?: UpdateIntakeStatusOptions | Record<string, unknown>,
  ): Promise<IntakeQueueItem | null> {
    const item = this.items.get(id);
    if (!item) return null;
    item.status = status;

    if (options) {
      const opts = options as UpdateIntakeStatusOptions;
      if (opts.retryCount !== undefined) {
        item.retryCount = opts.retryCount;
      }
      if (opts.lastError !== undefined) {
        item.lastError = opts.lastError;
      }
      if (opts.issueId !== undefined) {
        item.issueId = opts.issueId;
      }
      if (opts.issueIdentifier !== undefined) {
        item.issueIdentifier = opts.issueIdentifier;
      }
      if (opts.metadata) {
        item.metadata = { ...(item.metadata ?? {}), ...opts.metadata };
      } else {
        const { retryCount, lastError, issueId, issueIdentifier, ...rest } = options as any;
        if (Object.keys(rest).length > 0) {
          item.metadata = { ...(item.metadata ?? {}), ...rest };
        }
      }
    }
    return item;
  }

  async size(): Promise<number> {
    return this.items.size;
  }

  async clear(): Promise<void> {
    this.items.clear();
    this.order.length = 0;
  }
}

export function createInMemoryIntakeQueue(options?: { maxSize?: number }): InMemoryIntakeQueue {
  return new InMemoryIntakeQueue(options);
}

export const defaultIntakeQueue = createInMemoryIntakeQueue();
