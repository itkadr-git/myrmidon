// server/src/myrmidon/litellm-workers/gateway.ts
//
// myrmidon(1.6.6 LITELLM-WORKERS restart): the things the board does to the live
// gateway — read its numbers, read how many processes it was launched with,
// and run the planned restart that gives it a different number.
//
// All three are ports with one real adapter each, so the service that decides
// can be tested against a recording fake instead of a live container:
//
// - `readMetrics` scrapes `GET /metrics/` once and answers what the exposition
//   says, or why it could not be read. It never throws: an unreachable gateway
//   is a state the endpoint reports, not an error the caller has to catch.
//   The path carries its trailing slash because the gateway answers the bare
//   `/metrics` with a 307 to `/metrics/`. The key is resolved per company from
//   the secret store (the secret NAME is what the environment carries) and is
//   a key whose allowed routes include `/metrics`.
// - `readDeclaredWorkers` reads `--num_workers N` from the gateway's unit file:
//   the gateway runs as `litellm --num_workers N` (no gunicorn), and with
//   Prometheus in multiprocess mode its exposition names no worker count, so
//   the launch line is the only place the actual number is written.
// - `run` executes the configured restart command. The pool size of a
//   `litellm --num_workers` gateway changes only with a restart of the unit;
//   the board never signals the process.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { parseLitellmWorkersFromCommandLine, type LitellmWorkersMetrics } from "@myrmidon/shared";
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
  /** Reads the gateway once for a company. Never throws; a failed read is `ok: false`. */
  readMetrics(companyId: string): Promise<LitellmMetricsRead>;
}

/** The board's read port onto the pool size the gateway was launched with. */
export interface LitellmDeclaredWorkersPort {
  /** The `--num_workers` of the launch line, or null when it cannot be read. Never throws. */
  readDeclaredWorkers(): Promise<number | null>;
}

/** Reads the launch line from a unit file; an unreadable file is "no answer". */
export function createUnitFileDeclaredWorkers(
  unitFile: string,
  readText: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
): LitellmDeclaredWorkersPort {
  return {
    async readDeclaredWorkers() {
      try {
        return parseLitellmWorkersFromCommandLine(await readText(unitFile));
      } catch {
        return null;
      }
    },
  };
}

export interface LitellmWorkersHttpGatewayDeps {
  /** The gateway endpoint; the caller has already checked it is set. */
  baseUrl: string;
  /**
   * Resolves the bearer key for a company (null when it has none). Called per
   * read so a rotated key is picked up without a restart of the board.
   */
  resolveKey?: (companyId: string) => Promise<string | null>;
  fetchImpl?: typeof fetch;
  /** The per-worker CPU sampler; one per gateway, so two never average together. */
  sampler?: LitellmWorkerCpuSampler;
  timeoutMs?: number;
}

function metricsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/metrics/`;
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
  return {
    async readMetrics(companyId: string): Promise<LitellmMetricsRead> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const key = ((await deps.resolveKey?.(companyId)) ?? "").trim();
        const response = await fetchImpl(metricsUrl(deps.baseUrl), {
          headers: key ? { authorization: `Bearer ${key}` } : {},
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

/** One delivered restart: what was run and whether it worked. */
export interface LitellmRestartDelivery {
  command: string;
  ok: boolean;
  error: string | null;
}

/** The board's delivery port onto the gateway's unit. */
export interface LitellmRestartRunner {
  /** Runs one fully rendered command. Never throws. */
  run(command: string): Promise<{ ok: boolean; error: string | null }>;
}

/**
 * How long the restart command may take before it is abandoned. A restart of
 * the production unit takes about a minute (the gateway comes up in ~57 s), so
 * the command is expected to return only once the unit is active again.
 */
export const LITELLM_RESTART_TIMEOUT_MS = 180000;

/**
 * The real runner: one shell command.
 *
 * The command line comes from the instance's own configuration
 * (`MYRMIDON_LITELLM_WORKERS_RESTART_COMMAND`), never from a request body —
 * the same rule the setup-token transport follows. The only substitution is
 * the validated integer target.
 */
export function createShellLitellmRestartRunner(timeoutMs = LITELLM_RESTART_TIMEOUT_MS): LitellmRestartRunner {
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
