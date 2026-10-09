// myrmidon(1.6.6-LITELLM-WORKERS-UI): API module for the LiteLLM gateway
// worker-count controls. Written against the fixed part-A contract:
//   GET  /api/myrmidon/companies/:id/litellm/workers -> the state below
//   PUT  /api/myrmidon/companies/:id/litellm/workers { target } -> state after apply
// The `auto` field is OPTIONAL: a backend that does not implement auto-select
// simply omits it, and the tab renders the toggle disabled with an explanation.
import { api } from "@/api/client";

export interface LitellmWorkersState {
  /** Worker processes running now. */
  current: number;
  /** Desired worker count (what the last apply asked for). */
  target: number;
  /** Ceiling derived from host CPU. */
  maxByCpu: number;
  /** Ceiling derived from host memory; a target above it is refused with 400. */
  maxByMemory: number;
  metrics: {
    /** CPU load per worker process; a backend may send one number per worker,
     *  a single aggregate number, or null while the gateway is unreachable. */
    perWorkerCpu: number[] | number | null;
    medianLatencyMs: number | null;
    queueDepth: number | null;
  };
  /** Present only when the backend implements auto-select. */
  auto?: { enabled: boolean } | null;
}

/** PUT body: `auto` is attached only when the backend carries the field. */
export function buildWorkersPutBody(
  target: number,
  auto: boolean | null | undefined,
): { target: number; auto?: boolean } {
  return auto === null || auto === undefined ? { target } : { target, auto };
}

const base = (companyId: string) => `/myrmidon/companies/${encodeURIComponent(companyId)}/litellm/workers`;

export const litellmWorkersApi = {
  state: (companyId: string) => api.get<LitellmWorkersState>(base(companyId)),
  apply: (companyId: string, target: number, auto: boolean | null | undefined) =>
    api.put<LitellmWorkersState>(base(companyId), buildWorkersPutBody(target, auto)),
};

export const litellmWorkersKey = (companyId: string) => ["myrmidon", "litellm", "workers", companyId] as const;

/** Normalizes the flexible `perWorkerCpu` shape into one percentage per worker. */
export function perWorkerCpuSeries(value: number[] | number | null | undefined): number[] {
  if (value == null) return [];
  const raw = typeof value === "number" ? [value] : value;
  return raw
    .filter((entry): entry is number => typeof entry === "number" && Number.isFinite(entry))
    .map((entry) => Math.max(0, Math.min(100, entry)));
}

/**
 * Validates the worker-count input against the contract (integer, 1..maxByMemory).
 * Returns null when the draft is acceptable, the operator-facing reason otherwise.
 */
export function validateWorkerTarget(draft: string, maxByMemory: number): string | null {
  const trimmed = draft.trim();
  if (trimmed === "") return "Enter the number of worker processes.";
  const n = Number(trimmed);
  if (!Number.isInteger(n)) return "Worker count must be a whole number.";
  if (n < 1) return "Worker count must be at least 1.";
  if (n > maxByMemory) return `Worker count cannot exceed the memory ceiling (${maxByMemory}).`;
  return null;
}
