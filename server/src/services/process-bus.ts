// server/src/services/process-bus.ts
//
// myrmidon(PROCS-1.3): the one inter-process bus of the board — Postgres
// LISTEN/NOTIFY, per design OPE-5394 §3. One `sql.listen` per channel through
// postgres.js (it keeps its own connection and re-LISTENs itself after a
// reconnect; every re-listen calls `onlisten`, which this module turns into
// the `onReconnect` dogon — subscribers re-read settings, run a resweep).
// `publish` goes through `pg_notify`. Every message carries `origin = bootId`
// (a `randomUUID()` per process, like `legacyControllerBootId`), and the
// receiver drops its own messages. `schemaVersion` is on every message and is
// validated on receive. Payloads are bounded: NOTIFY drops a payload above
// 8000 bytes, so this module refuses to send one instead of failing the
// query at Postgres.
//
// NOTIFY reaches only live listeners; a process that is down or
// disconnected misses the signal. That is why every channel of the design
// table keeps a timer fallback (a periodic sweep re-reads the state) — the
// bus is an optimization for latency, never the carrier of correctness.
//
// Off by default: a single-process deployment behaves exactly as before.
// The bus starts listening only when `startProcessBus` is called, and the
// callers gate that on the process-role profile (myrmidon(PROCS-1.1)).

import { randomUUID } from "node:crypto";

/** Channel names of the design table (OPE-5394 §3), unprefixed. */
export const PROCESS_BUS_CHANNELS = [
  "run_queued",
  "run_control",
  "settings_changed",
  "live_event",
  "secrets_changed",
  "bot_apply_requested",
  "leader_changed",
] as const;

export type ProcessBusChannel = (typeof PROCESS_BUS_CHANNELS)[number];

/** Prefix keeps board notifications off any other user's channels on a shared cluster. */
export const PROCESS_BUS_CHANNEL_PREFIX = "paperclip_bus_";

export function processBusChannelName(channel: ProcessBusChannel): string {
  return `${PROCESS_BUS_CHANNEL_PREFIX}${channel}`;
}

/**
 * Postgres NOTIFY hard limit (the full payload string, design §3). Sending
 * more aborts the query with `payload string too long`; the bus refuses
 * earlier with a typed error so the publisher gets a clear reason.
 */
export const PROCESS_BUS_MAX_PAYLOAD_BYTES = 8000;

/** Schema version stamped on every message; bumped with any envelope change. */
export const PROCESS_BUS_SCHEMA_VERSION = 1;

export class ProcessBusPayloadTooLargeError extends Error {
  readonly sizeBytes: number;
  constructor(channel: ProcessBusChannel, sizeBytes: number) {
    super(
      `process bus payload for channel ${channel} is ${sizeBytes} bytes, ` +
        `above the ${PROCESS_BUS_MAX_PAYLOAD_BYTES}-byte NOTIFY limit`,
    );
    this.name = "ProcessBusPayloadTooLargeError";
    this.sizeBytes = sizeBytes;
  }
}

/** The envelope every bus message is wrapped in. */
export interface ProcessBusEnvelope<T = unknown> {
  schemaVersion: number;
  origin: string;
  channel: ProcessBusChannel;
  payload: T;
  sentAt: string;
}

export type ProcessBusHandler<T = unknown> = (payload: T) => void;

/**
 * Called on every (re-)listen of the bus connection — the reconnect dogon:
 * subscribers re-read settings, run a resweep, refresh whatever a lost
 * NOTIFY could have skipped.
 */
export type ProcessBusReconnectHandler = () => void;

/** The narrow slice of a postgres.js client the bus uses (test-fakeable). */
export interface ProcessBusSql {
  listen(
    channel: string,
    onnotify: (payload: string) => void,
    onlisten?: () => void,
  ): Promise<{ unlisten(): Promise<void> }>;
  unsafe(query: string, parameters?: unknown[]): Promise<unknown>;
}

export interface ProcessBusOptions {
  /** Boot id of this process; defaults to a fresh `randomUUID()`. */
  bootId?: string;
  /** Test hook for the envelope timestamp. */
  now?: () => Date;
}

function parseEnvelope(raw: string): ProcessBusEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const envelope = parsed as Record<string, unknown>;
  if (envelope.schemaVersion !== PROCESS_BUS_SCHEMA_VERSION) {
    // Foreign-schema message (deploy skew): drop it, never deliver it.
    return null;
  }
  if (typeof envelope.origin !== "string") return null;
  return envelope as unknown as ProcessBusEnvelope;
}

/**
 * The process-wide bus. A value object: construct one per process, wire the
 * handlers, `start` it once. No module-level singleton, so a test drives its
 * own instance end to end.
 */
export class ProcessBus {
  readonly bootId: string;
  private readonly sql: ProcessBusSql;
  private readonly now: () => Date;
  private readonly handlers = new Map<ProcessBusChannel, Set<ProcessBusHandler<never>>>();
  private readonly reconnectHandlers = new Set<ProcessBusReconnectHandler>();
  private listens: { unlisten(): Promise<void> }[] = [];
  private started = false;

  constructor(sql: ProcessBusSql, options: ProcessBusOptions = {}) {
    this.sql = sql;
    this.bootId = options.bootId ?? randomUUID();
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Subscribe to a channel. The handler never sees this process's own
   * messages (origin filter) and never sees a malformed payload (it is
   * dropped, not delivered).
   */
  subscribe<T>(channel: ProcessBusChannel, handler: ProcessBusHandler<T>): () => void {
    let set = this.handlers.get(channel);
    if (!set) {
      set = new Set();
      this.handlers.set(channel, set);
    }
    const typed = handler as ProcessBusHandler<never>;
    set.add(typed);
    return () => set!.delete(typed);
  }

  /** Register a reconnect-dogon handler (fires on the initial listen too). */
  onReconnect(handler: ProcessBusReconnectHandler): () => void {
    this.reconnectHandlers.add(handler);
    return () => this.reconnectHandlers.delete(handler);
  }

  /** Listen on every channel that has a subscriber. Idempotent. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const channels = [...this.handlers.keys()];
    this.listens = await Promise.all(
      channels.map((channel) =>
        this.sql.listen(
          processBusChannelName(channel),
          (raw) => this.dispatch(channel, raw),
          () => this.handleReconnect(),
        ),
      ),
    );
  }

  async stop(): Promise<void> {
    const listens = this.listens;
    this.listens = [];
    this.started = false;
    await Promise.all(listens.map((listen) => listen.unlisten().catch(() => {})));
  }

  /** Publish an envelope on a channel. Refuses a payload above the NOTIFY limit. */
  async publish(channel: ProcessBusChannel, payload: unknown): Promise<void> {
    const envelope: ProcessBusEnvelope = {
      schemaVersion: PROCESS_BUS_SCHEMA_VERSION,
      origin: this.bootId,
      channel,
      payload,
      sentAt: this.now().toISOString(),
    };
    const raw = JSON.stringify(envelope);
    const sizeBytes = Buffer.byteLength(raw, "utf8");
    if (sizeBytes > PROCESS_BUS_MAX_PAYLOAD_BYTES) {
      throw new ProcessBusPayloadTooLargeError(channel, sizeBytes);
    }
    await this.sql.unsafe("select pg_notify($1, $2)", [processBusChannelName(channel), raw]);
  }

  private dispatch(channel: ProcessBusChannel, raw: string): void {
    const envelope = parseEnvelope(raw);
    if (!envelope) return;
    if (envelope.origin === this.bootId) return; // own message
    const set = this.handlers.get(channel);
    if (!set) return;
    for (const handler of set) handler(envelope.payload as never);
  }

  private handleReconnect(): void {
    for (const handler of this.reconnectHandlers) handler();
  }
}
