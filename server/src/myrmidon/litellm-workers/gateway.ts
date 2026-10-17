// server/src/myrmidon/litellm-workers/gateway.ts
//
// myrmidon(1.6.5 LITELLM-WORKERS A): the two things the board does to the live
// gateway — read its numbers, and ask its gunicorn master for a different
// number of workers.
//
// Both are ports with one real adapter each, so the service that decides can be
// tested against a recording fake instead of a live container:
//
// - `readMetrics` scrapes `GET /metrics` once and answers what the exposition
//   says, or why it could not be read. It never throws: an unreachable gateway
//   is a state the endpoint reports, not an error the caller has to catch.
// - `runSignalCommand` delivers ONE master signal. gunicorn has no API for
//   resizing: TTIN adds a worker and TTOU removes one, both delivered to the
//   master as a signal. The repo already delivers signals to a service with a
//   configured command line, so the command is a template
//   (`MYRMIDON_LITELLM_WORKERS_SIGNAL_COMMAND`, default
//   `docker kill -s {signal} {container}`) and `{signal}`/`{container}` are
//   filled in per delivery. On the production node the gateway is the
//   container's PID 1, which is why `docker kill -s` reaches the master; a
//   host that runs the unit directly points the variable at
//   `systemctl kill -s {signal} litellm-gateway.service` instead.

import { execFile } from "node:child_process";
import type { LitellmWorkersMetrics } from "@paperclipai/shared";
import {
  LitellmWorkerCpuSampler,
  parsePrometheusText,
  readPrometheusCpuSamples,
  readPrometheusMetrics,
  readPrometheusWorkerGauge,
  readPrometheusWorkerPidCount,
} from "./metrics.js";

/** The default scrape timeout: the gateway answers its metrics in milliseconds. */
export const LITELLM_METRICS_TIMEOUT_MS = 8000;

/** What one successful read of the gateway says about the pool. */
export interface LitellmMetricsReading {
  /** The pool size the gateway reports, or null when it does not report one. */
  workers: number | null;
  /** Where that size came from: an explicit pool gauge, or a per-pid hint. */
  workersSource: "gauge" | "pids" | null;
  metrics: LitellmWorkersMetrics;
}

/** One read: the numbers, or the reason there are none. */
export type LitellmMetricsRead = ({ ok: true } & LitellmMetricsReading) | { ok: false; error: string };

/** The board's read port onto the live gateway. */
export interface LitellmWorkersGatewayPort {
  /** Reads the gateway once. Never throws; a failed read is `ok: false`. */
  readMetrics(): Promise<LitellmMetricsRead>;
}

export interface LitellmWorkersHttpGatewayDeps {
  /** The gateway endpoint; the caller has already checked it is set. */
  baseUrl: string;
  /** Sent as a bearer token when set; the exposition may be open inside the host. */
  adminKey?: string | null;
  fetchImpl?: typeof fetch;
  /** The per-worker CPU sampler; one per gateway, so two never average together. */
  sampler?: LitellmWorkerCpuSampler;
  timeoutMs?: number;
}

function metricsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/metrics`;
}

/**
 * The HTTP adapter. A non-2xx answer, a transport failure and a timeout all
 * become `ok: false` with a sentence, because the endpoint above reports the
 * gateway as unreachable rather than failing the whole GET: an operator
 * reading the pool size must still see the target and the ceilings.
 */
export function createLitellmWorkersGateway(deps: LitellmWorkersHttpGatewayDeps): LitellmWorkersGatewayPort {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sampler = deps.sampler ?? new LitellmWorkerCpuSampler();
  const timeoutMs = deps.timeoutMs ?? LITELLM_METRICS_TIMEOUT_MS;
  const adminKey = deps.adminKey?.trim() || null;
  return {
    async readMetrics(): Promise<LitellmMetricsRead> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(metricsUrl(deps.baseUrl), {
          headers: adminKey ? { authorization: `Bearer ${adminKey}` } : {},
          signal: controller.signal,
        });
        if (!response.ok) return { ok: false, error: `gateway metrics answered HTTP ${response.status}` };
        const samples = parsePrometheusText(await response.text());
        const perWorkerCpu = sampler.observe(readPrometheusCpuSamples(samples), Date.now());
        const gauge = readPrometheusWorkerGauge(samples);
        const pids = gauge === null ? readPrometheusWorkerPidCount(samples) : null;
        return {
          ok: true,
          workers: gauge ?? pids,
          workersSource: gauge !== null ? "gauge" : pids !== null ? "pids" : null,
          metrics: readPrometheusMetrics(samples, perWorkerCpu),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: `gateway metrics unreadable: ${message}` };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** One delivered signal: what was run and whether it worked. */
export interface LitellmSignalDelivery {
  signal: string;
  command: string;
  ok: boolean;
  error: string | null;
}

/** The board's delivery port onto the gateway's master process. */
export interface LitellmSignalRunner {
  /** Runs one fully rendered command. Never throws. */
  run(command: string): Promise<{ ok: boolean; error: string | null }>;
}

/** How long one signal command may take before it is abandoned. */
export const LITELLM_SIGNAL_TIMEOUT_MS = 15000;

/** The only things the board may ever run: the two master signals. */
export const LITELLM_SIGNAL_ALLOWLIST: readonly string[] = ["TTIN", "TTOU"];

/**
 * The real runner: one shell command per signal.
 *
 * The command line comes from the instance's own configuration (checked
 * against the two signals above before it is rendered), never from a request
 * body — the same rule the setup-token transport follows.
 */
export function createShellLitellmSignalRunner(timeoutMs = LITELLM_SIGNAL_TIMEOUT_MS): LitellmSignalRunner {
  return {
    run(command: string) {
      return new Promise((resolve) => {
        execFile("sh", ["-c", command], { timeout: timeoutMs }, (error: Error | null, _stdout: string | Buffer, stderr: string | Buffer) => {
          if (!error) {
            resolve({ ok: true, error: null });
            return;
          }
          const code = (error as { code?: unknown }).code;
          const detail = String(stderr ?? "").trim().slice(0, 500) || error.message;
          resolve({ ok: false, error: `${typeof code === "number" ? `exit ${code}: ` : ""}${detail}` });
        });
      });
    },
  };
}

/**
 * Delivers the steps that take the pool from its current size to the target.
 * A step stops the walk on its first failure: sending half of a shrink and
 * then reporting success would leave the operator with a pool nobody asked
 * for, so what was delivered is reported as it happened.
 */
export async function deliverLitellmWorkersSignals(
  runner: LitellmSignalRunner,
  steps: readonly { signal: string; count: number }[],
  render: (signal: string) => string,
): Promise<{ deliveries: LitellmSignalDelivery[]; error: string | null }> {
  const deliveries: LitellmSignalDelivery[] = [];
  for (const step of steps) {
    if (!LITELLM_SIGNAL_ALLOWLIST.includes(step.signal)) {
      return { deliveries, error: `refusing to deliver unknown signal ${step.signal}` };
    }
    for (let index = 0; index < step.count; index += 1) {
      const command = render(step.signal);
      const result = await runner.run(command);
      deliveries.push({ signal: step.signal, command, ok: result.ok, error: result.error });
      if (!result.ok) {
        return { deliveries, error: `${step.signal} was not delivered: ${result.error ?? "unknown failure"}` };
      }
    }
  }
  return { deliveries, error: null };
}