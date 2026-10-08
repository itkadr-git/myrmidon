// server/src/myrmidon/litellm-workers/litellm-workers.myrmidon.test.ts
//
// myrmidon(1.6.6 LITELLM-WORKERS A): the acceptance criteria of the ticket,
// without a database, a container or a live gateway.
//
// The three ports of the service are faked (settings store, gateway read,
// signal delivery), so the tests cover what the ticket asks for exactly: the
// ceilings of a 6 core / 12 GB box, the memory rejection, the TTIN/TTOU
// arithmetic of a resize, and that a GET reflects the pool after a PUT.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_LITELLM_WORKERS_SIGNAL_COMMAND,
  LITELLM_WORKERS_BASELINE_ENV,
  checkLitellmWorkersTarget,
  litellmWorkersCeilings,
  litellmWorkersSignalSteps,
  renderLitellmWorkersSignalCommand,
  type LitellmWorkersCeilings,
} from "@paperclipai/shared";
import { HttpError } from "../../errors.js";
import {
  LitellmWorkerCpuSampler,
  derivePerWorkerCpu,
  parsePrometheusText,
  readPrometheusCpuSamples,
  readPrometheusMetrics,
  readPrometheusMedianLatencyMs,
  readPrometheusQueueDepth,
  readPrometheusWorkerGauge,
  readPrometheusWorkerPidCount,
} from "./metrics.js";
import type { LitellmMetricsRead, LitellmSignalRunner, LitellmWorkersGatewayPort } from "./gateway.js";
import { memoryLitellmWorkersStore, preserveLitellmWorkersGeneralKey } from "./settings.js";
import { applyLitellmWorkersTarget, readLitellmWorkersView, type LitellmWorkersDeps } from "./service.js";

const COMPANY = "2870b911-483a-4091-9f15-183841811143";

const PRODUCTION: LitellmWorkersCeilings = litellmWorkersCeilings({ cores: 6, memoryGb: 12, gbPerWorker: 1.5 });

/** A gateway whose pool the test can move, the way the master would. */
class FakeGateway implements LitellmWorkersGatewayPort {
  workers: number | null;
  workersSource: "gauge" | "pids" | null;
  error: string | null = null;
  reads = 0;
  metrics = { perWorkerCpu: 0.42, medianLatencyMs: 210, queueDepth: 3 };

  constructor(workers: number | null, workersSource: "gauge" | "pids" | null = "gauge") {
    this.workers = workers;
    this.workersSource = workersSource;
  }

  async readMetrics(): Promise<LitellmMetricsRead> {
    this.reads += 1;
    if (this.error !== null) return { ok: false, error: this.error };
    return { ok: true, workers: this.workers, workersSource: this.workersSource, metrics: { ...this.metrics } };
  }
}

/** Records every command, and moves the pool when the fake pool is watching. */
class FakeRunner implements LitellmSignalRunner {
  commands: string[] = [];
  failAt: number | null = null;
  onDelivered: ((signal: string) => void) | null = null;

  async run(command: string) {
    this.commands.push(command);
    const signal = command.includes("TTIN") ? "TTIN" : "TTOU";
    if (this.failAt !== null && this.commands.length === this.failAt) {
      return { ok: false, error: "signal delivery refused" };
    }
    this.onDelivered?.(signal);
    return { ok: true, error: null };
  }
}

function depsWith(input: {
  gateway?: LitellmWorkersGatewayPort | null;
  runner?: LitellmSignalRunner;
  env?: Record<string, string | undefined>;
  seed?: Record<string, { target: number | null; observed: { workers: number; at: string } | null }>;
}): LitellmWorkersDeps {
  return {
    store: memoryLitellmWorkersStore(input.seed ?? {}),
    env: input.env ?? {},
    gateway: input.gateway === undefined ? null : input.gateway,
    signalRunner: input.runner,
  };
}

describe("ceilings of the production container (6 cores / 12 GB)", () => {
  it("allows one worker per core and eight by memory", () => {
    expect(PRODUCTION.maxByCpu).toBe(6);
    expect(PRODUCTION.maxByMemory).toBe(8);
    expect(PRODUCTION.maxTarget).toBe(6);
    expect(PRODUCTION.minTarget).toBe(1);
  });

  it("defaults to one core fewer than the container has", () => {
    expect(PRODUCTION.defaultTarget).toBe(5);
  });

  it("rejects a target above the memory ceiling", () => {
    const check = checkLitellmWorkersTarget(9, PRODUCTION);
    expect(check.ok).toBe(false);
    expect(check.reason).toBe("above_memory");
  });

  it("rejects a target above the CPU ceiling", () => {
    const check = checkLitellmWorkersTarget(7, PRODUCTION);
    expect(check.ok).toBe(false);
    expect(check.reason).toBe("above_cpu");
  });

  it("rejects zero, a fraction and a non-number", () => {
    expect(checkLitellmWorkersTarget(0, PRODUCTION).reason).toBe("below_minimum");
    expect(checkLitellmWorkersTarget(2.5, PRODUCTION).reason).toBe("not_integer");
    expect(checkLitellmWorkersTarget("5", PRODUCTION).reason).toBe("not_integer");
  });

  it("accepts the default and the ceilings", () => {
    expect(checkLitellmWorkersTarget(5, PRODUCTION).ok).toBe(true);
    expect(checkLitellmWorkersTarget(PRODUCTION.maxTarget, PRODUCTION).ok).toBe(true);
  });
});

describe("the signal arithmetic of a resize", () => {
  it("asks for one TTIN per worker to add", () => {
    expect(litellmWorkersSignalSteps(4, 5)).toEqual([{ signal: "TTIN", count: 1 }]);
    expect(litellmWorkersSignalSteps(4, 6)).toEqual([{ signal: "TTIN", count: 2 }]);
  });

  it("asks for one TTOU per worker to drop", () => {
    expect(litellmWorkersSignalSteps(4, 3)).toEqual([{ signal: "TTOU", count: 1 }]);
    expect(litellmWorkersSignalSteps(4, 1)).toEqual([{ signal: "TTOU", count: 3 }]);
  });

  it("asks for nothing when the pool is already at the target", () => {
    expect(litellmWorkersSignalSteps(4, 4)).toEqual([]);
  });

  it("renders the command the delivery path runs", () => {
    expect(renderLitellmWorkersSignalCommand(DEFAULT_LITELLM_WORKERS_SIGNAL_COMMAND, { signal: "TTIN", container: "litellm-gateway" })).toBe(
      "docker kill -s TTIN litellm-gateway",
    );
  });
});

describe("reading the gateway's numbers", () => {
  const exposition = [
    "# HELP litellm_in_flight_requests Requests in flight",
    "# TYPE litellm_in_flight_requests gauge",
    'litellm_in_flight_requests{pid="11"} 2',
    'litellm_in_flight_requests{pid="12"} 3',
    'litellm_workers 4',
    'litellm_request_total_latency_metric_bucket{le="0.5",pid="11"} 10',
    'litellm_request_total_latency_metric_bucket{le="1.0",pid="11"} 14',
    'litellm_request_total_latency_metric_bucket{le="+Inf",pid="11"} 16',
    'process_cpu_seconds_total{pid="11"} 10',
    'process_cpu_seconds_total{pid="12"} 20',
    "not_a_sample",
  ];

  it("parses name, labels and value", () => {
    const samples = parsePrometheusText(exposition.join("\n"));
    expect(samples).toContainEqual({ name: "litellm_workers", labels: {}, value: 4 });
    expect(samples.find((sample) => sample.name === "litellm_in_flight_requests" && sample.labels.pid === "12")?.value).toBe(3);
    expect(samples.some((sample) => sample.name === "not_a_sample")).toBe(false);
  });

  it("takes the pool size from the gateway's own gauge", () => {
    const samples = parsePrometheusText(exposition.join("\n"));
    expect(readPrometheusWorkerGauge(samples)).toBe(4);
    expect(readPrometheusWorkerPidCount(samples)).toBe(2);
  });

  it("sums the in-flight requests into a queue depth", () => {
    expect(readPrometheusQueueDepth(parsePrometheusText(exposition.join("\n")))).toBe(5);
  });

  it("interpolates the median inside the bucket it falls into", () => {
    // 16 answers, the median is the 8th, and the 0.5s bucket holds answers
    // 1..10 — so the median is 0.8 of the way through it: 0.4s.
    expect(readPrometheusMedianLatencyMs(parsePrometheusText(exposition.join("\n")))).toBe(400);
  });

  it("answers null for a family the gateway does not carry", () => {
    const samples = parsePrometheusText("unrelated_metric 1");
    expect(readPrometheusMedianLatencyMs(samples)).toBeNull();
    expect(readPrometheusQueueDepth(samples)).toBeNull();
  });

  it("turns the CPU counter into a rate only from a second scrape", () => {
    const first = readPrometheusCpuSamples(parsePrometheusText(exposition.join("\n")));
    const second = readPrometheusCpuSamples(parsePrometheusText(exposition.join("\n").replace('pid="11"} 10', 'pid="11"} 11')));
    expect(derivePerWorkerCpu(null, first, 10)).toBeNull();
    expect(derivePerWorkerCpu(first, second, 10)).toBe(0.05);
  });

  it("remembers the previous scrape in the sampler", () => {
    const sampler = new LitellmWorkerCpuSampler();
    const first = readPrometheusCpuSamples(parsePrometheusText(exposition.join("\n")));
    const second = readPrometheusCpuSamples(parsePrometheusText(exposition.join("\n").replace('pid="11"} 10', 'pid="11"} 11')));
    expect(sampler.observe(first, 1_000)).toBeNull();
    expect(sampler.observe(second, 11_000)).toBe(0.05);
  });

  it("reports the three numbers together", () => {
    const samples = parsePrometheusText(exposition.join("\n"));
    expect(readPrometheusMetrics(samples, null)).toEqual({ perWorkerCpu: null, medianLatencyMs: 400, queueDepth: 5 });
  });
});

describe("GET the worker count", () => {
  it("reports the pool the gateway runs, the default target and the live numbers", async () => {
    const view = await readLitellmWorkersView(depsWith({ gateway: new FakeGateway(4) }), COMPANY);
    expect(view.current).toBe(4);
    expect(view.currentSource).toBe("gateway");
    expect(view.target).toBe(5);
    expect(view.targetSource).toBe("default");
    expect(view.maxByCpu).toBe(6);
    expect(view.maxByMemory).toBe(8);
    expect(view.metrics).toEqual({ perWorkerCpu: 0.42, medianLatencyMs: 210, queueDepth: 3 });
    expect(view.metricsSource).toBe("gateway");
    expect(view.apply).toEqual({ path: "gunicorn-ttin-ttou", configured: true, command: DEFAULT_LITELLM_WORKERS_SIGNAL_COMMAND, container: "litellm-gateway" });
  });

  it("reports the stored target over the default", async () => {
    const deps = depsWith({ gateway: new FakeGateway(4), seed: { [COMPANY]: { target: 2, observed: null } } });
    const view = await readLitellmWorkersView(deps, COMPANY);
    expect(view.target).toBe(2);
    expect(view.targetSource).toBe("settings");
  });

  it("falls back to the declared baseline when the gateway reports no pool", async () => {
    const deps = depsWith({ gateway: new FakeGateway(null, null), env: { [LITELLM_WORKERS_BASELINE_ENV]: "4" } });
    const view = await readLitellmWorkersView(deps, COMPANY);
    expect(view.current).toBe(4);
    expect(view.currentSource).toBe("baseline");
  });

  it("labels a per-pid count as the weak source it is", async () => {
    const view = await readLitellmWorkersView(depsWith({ gateway: new FakeGateway(1, "pids") }), COMPANY);
    expect(view.current).toBe(1);
    expect(view.currentSource).toBe("gateway_pids");
  });

  it("says why the live numbers are missing when no gateway is configured", async () => {
    const view = await readLitellmWorkersView(depsWith({}), COMPANY);
    expect(view.current).toBeNull();
    expect(view.currentSource).toBe("unknown");
    expect(view.target).toBe(5);
    expect(view.metricsSource).toBe("unavailable");
    expect(view.metrics).toEqual({ perWorkerCpu: null, medianLatencyMs: null, queueDepth: null });
    expect(view.gateway).toEqual({ configured: false, reachable: false, error: null, workersSource: null });
  });

  it("reports an unreachable gateway without failing the read", async () => {
    const gateway = new FakeGateway(4);
    gateway.error = "connect ECONNREFUSED 127.0.0.1:4000";
    const view = await readLitellmWorkersView(depsWith({ gateway }), COMPANY);
    expect(view.gateway.reachable).toBe(false);
    expect(view.gateway.error).toContain("ECONNREFUSED");
    expect(view.current).toBeNull();
  });
});

describe("PUT the worker count", () => {
  it("grows the pool with one TTIN and reports the new state", async () => {
    const gateway = new FakeGateway(4);
    const runner = new FakeRunner();
    runner.onDelivered = (signal) => {
      gateway.workers = (gateway.workers ?? 0) + (signal === "TTIN" ? 1 : -1);
    };
    const deps = depsWith({ gateway, runner });
    const result = await applyLitellmWorkersTarget(deps, { companyId: COMPANY, target: 5 });

    expect(runner.commands).toEqual(["docker kill -s TTIN litellm-gateway"]);
    expect(result.applied).toBe(true);
    expect(result.applyError).toBeNull();
    expect(result.signals).toEqual([{ signal: "TTIN", count: 1 }]);
    expect(result.view.target).toBe(5);
    expect(result.view.current).toBe(5);
    expect(result.view.targetSource).toBe("settings");
  });

  it("shrinks the pool with as many TTOU signals as workers to drop", async () => {
    const gateway = new FakeGateway(4);
    const runner = new FakeRunner();
    runner.onDelivered = (signal) => {
      gateway.workers = (gateway.workers ?? 0) + (signal === "TTIN" ? 1 : -1);
    };
    const result = await applyLitellmWorkersTarget(depsWith({ gateway, runner }), { companyId: COMPANY, target: 2 });

    expect(runner.commands).toEqual([
      "docker kill -s TTOU litellm-gateway",
      "docker kill -s TTOU litellm-gateway",
    ]);
    expect(result.applied).toBe(true);
    expect(result.view.current).toBe(2);
    expect(result.view.target).toBe(2);
  });

  it("delivers nothing when the pool is already at the target", async () => {
    const runner = new FakeRunner();
    const result = await applyLitellmWorkersTarget(
      depsWith({ gateway: new FakeGateway(5), runner, seed: { [COMPANY]: { target: 5, observed: null } } }),
      { companyId: COMPANY, target: 5 },
    );
    expect(runner.commands).toEqual([]);
    expect(result.signals).toEqual([]);
    expect(result.applied).toBe(true);
    expect(result.changed).toBe(false);
  });

  it("rejects a target above the memory ceiling with a 400 and delivers nothing", async () => {
    const runner = new FakeRunner();
    const deps = depsWith({ gateway: new FakeGateway(4), runner });
    await expect(applyLitellmWorkersTarget(deps, { companyId: COMPANY, target: 9 })).rejects.toBeInstanceOf(HttpError);
    await expect(applyLitellmWorkersTarget(deps, { companyId: COMPANY, target: 9 })).rejects.toMatchObject({
      status: 400,
      details: { reason: "above_memory", maxByMemory: 8 },
    });
    expect(runner.commands).toEqual([]);
    expect(await deps.store.read(COMPANY)).toEqual({ target: null, observed: null });
  });

  it("stores the target but refuses to guess the signals when the pool size is unknown", async () => {
    const runner = new FakeRunner();
    const deps = depsWith({ runner });
    const result = await applyLitellmWorkersTarget(deps, { companyId: COMPANY, target: 5 });

    expect(runner.commands).toEqual([]);
    expect(result.applied).toBe(false);
    expect(result.applyError).toContain("TTIN/TTOU");
    expect(result.view.target).toBe(5);
    expect(result.view.current).toBeNull();
    expect((await deps.store.read(COMPANY)).target).toBe(5);
  });

  it("counts a retry from what was actually delivered, not from the intention", async () => {
    const gateway = new FakeGateway(4);
    const runner = new FakeRunner();
    runner.failAt = 2;
    runner.onDelivered = (signal) => {
      gateway.workers = (gateway.workers ?? 0) + (signal === "TTIN" ? 1 : -1);
    };
    const deps = depsWith({ gateway, runner });
    const result = await applyLitellmWorkersTarget(deps, { companyId: COMPANY, target: 1 });

    expect(gateway.workers).toBe(3);
    expect(result.applied).toBe(false);
    expect(result.applyError).toBe("signal delivery refused");
    expect(result.deliveries).toHaveLength(2);
    expect((await deps.store.read(COMPANY)).observed?.workers).toBe(3);
  });

  it("keeps the stored target across a resize of another company", async () => {
    const store = memoryLitellmWorkersStore({});
    const runner = new FakeRunner();
    const deps: LitellmWorkersDeps = { store, env: {}, gateway: new FakeGateway(4), signalRunner: runner };
    await applyLitellmWorkersTarget(deps, { companyId: "other-company", target: 2 });
    await applyLitellmWorkersTarget(deps, { companyId: COMPANY, target: 6 });
    expect((await store.read("other-company")).target).toBe(2);
    expect((await store.read(COMPANY)).target).toBe(6);
  });
});

describe("keeping the stored map across instance settings writes", () => {
  it("carries the key of every company forward", () => {
    const stored = { myrmidonLitellmWorkersCompanies: { [COMPANY]: { target: 5 } }, somethingElse: true };
    expect(preserveLitellmWorkersGeneralKey(stored)).toEqual({ myrmidonLitellmWorkersCompanies: { [COMPANY]: { target: 5 } } });
  });

  it("answers an empty object for a general without the key", () => {
    expect(preserveLitellmWorkersGeneralKey(undefined)).toEqual({});
    expect(preserveLitellmWorkersGeneralKey({ other: 1 })).toEqual({});
    expect(preserveLitellmWorkersGeneralKey({ myrmidonLitellmWorkersCompanies: "not-an-object" })).toEqual({});
  });
});