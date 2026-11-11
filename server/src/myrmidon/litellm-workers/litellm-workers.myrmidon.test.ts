// server/src/myrmidon/litellm-workers/litellm-workers.myrmidon.test.ts
//
// myrmidon(1.6.6 LITELLM-WORKERS restart): the acceptance criteria of the
// ticket, without a database, a container or a live gateway.
//
// The ports of the service are faked (settings store, gateway read, launch-line
// read, restart), so the tests cover what the ticket asks for exactly: the
// ceilings of a 6 core / 12 GB box, the memory rejection, the planned restart
// that replaces the gunicorn signals, `reachable` and `current` as the board
// reads them from a gateway that runs `litellm --num_workers N`, and that the
// result of a restart is confirmed rather than assumed.

import { describe, expect, it, vi } from "vitest";
import {
  LITELLM_WORKERS_BASELINE_ENV,
  LITELLM_WORKERS_RESTART_COMMAND_ENV,
  checkLitellmWorkersTarget,
  litellmWorkersCeilings,
  parseLitellmWorkersFromCommandLine,
  renderLitellmWorkersRestartCommand,
  type LitellmWorkersCeilings,
} from "@myrmidon/shared";
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
import {
  createLitellmWorkersGateway,
  createUnitFileDeclaredWorkers,
  type LitellmDeclaredWorkersPort,
  type LitellmMetricsRead,
  type LitellmRestartRunner,
  type LitellmWorkersGatewayPort,
} from "./gateway.js";
import {
  inProcessLitellmWorkersLock,
  memoryLitellmWorkersStore,
  noLitellmWorkersLock,
  preserveLitellmWorkersGeneralKey,
} from "./settings.js";
import { applyLitellmWorkersTarget, readLitellmWorkersView, type LitellmWorkersDeps } from "./service.js";

const COMPANY = "2870b911-483a-4091-9f15-183841811143";
const RESTART_COMMAND = "unit-restart --workers {workers}";
const RESTART_ENV = { [LITELLM_WORKERS_RESTART_COMMAND_ENV]: RESTART_COMMAND };

const PRODUCTION: LitellmWorkersCeilings = litellmWorkersCeilings({ cores: 6, memoryGb: 12, gbPerWorker: 1.5 });

/** A gateway whose metrics the test controls; the pool gauge is optional. */
class FakeGateway implements LitellmWorkersGatewayPort {
  workers: number | null;
  workersSource: "gauge" | "pids" | null;
  error: string | null = null;
  reads = 0;
  metrics = { perWorkerCpu: 42, medianLatencyMs: 210, queueDepth: 3 };

  constructor(workers: number | null, workersSource: "gauge" | "pids" | null = "gauge") {
    this.workers = workers;
    this.workersSource = workersSource;
  }

  async readMetrics(_companyId: string): Promise<LitellmMetricsRead> {
    this.reads += 1;
    if (this.error !== null) return { ok: false, error: this.error };
    return { ok: true, workers: this.workers, workersSource: this.workersSource, metrics: { ...this.metrics } };
  }
}

/** The launch line of the unit: `--num_workers N`, or unreadable (null). */
class FakeLaunchLine implements LitellmDeclaredWorkersPort {
  workers: number | null;
  constructor(workers: number | null) {
    this.workers = workers;
  }
  async readDeclaredWorkers() {
    return this.workers;
  }
}

/**
 * Records every restart. A real restart rewrites the unit's `--num_workers`
 * and brings the gateway back; here that is `onRestart`, which defaults to
 * moving the launch line to the requested number.
 */
class FakeRestart implements LitellmRestartRunner {
  commands: string[] = [];
  failWith: string | null = null;
  onRestart: ((workers: number) => void) | null = null;

  async run(command: string) {
    this.commands.push(command);
    if (this.failWith !== null) return { ok: false, error: this.failWith };
    this.onRestart?.(Number(/--workers (\d+)/.exec(command)?.[1]));
    return { ok: true, error: null };
  }
}

/** A restart that really moves the pool the way the unit would. */
function restartMoving(launchLine: FakeLaunchLine): FakeRestart {
  const runner = new FakeRestart();
  runner.onRestart = (workers) => {
    launchLine.workers = workers;
  };
  return runner;
}

function depsWith(input: {
  gateway?: LitellmWorkersGatewayPort | null;
  declared?: LitellmDeclaredWorkersPort;
  runner?: LitellmRestartRunner;
  env?: Record<string, string | undefined>;
  seed?: Record<string, { target: number | null; observed: { workers: number; at: string } | null }>;
}): LitellmWorkersDeps {
  return {
    store: memoryLitellmWorkersStore(input.seed ?? {}),
    env: input.env ?? {},
    gateway: input.gateway === undefined ? null : input.gateway,
    // No launch line unless the test gives one: the host's real unit file must
    // never leak into a test.
    declared: input.declared ?? new FakeLaunchLine(null),
    restartRunner: input.runner,
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

describe("the restart that applies a target", () => {
  it("fills the target into the configured restart command", () => {
    expect(renderLitellmWorkersRestartCommand("restart-unit --workers {workers}", 4)).toBe("restart-unit --workers 4");
  });

  it("reads --num_workers from the launch line of the unit", () => {
    const unit = [
      "# the window of DNS errors comes from --num_workers 9 in an old comment",
      "ExecStartPre=/usr/bin/docker create --name litellm-gateway \\",
      "    --config /app/config.yaml --port 4000 --host 0.0.0.0 --num_workers 2",
      "ExecStart=/usr/bin/docker start -a litellm-gateway",
    ].join("\n");
    expect(parseLitellmWorkersFromCommandLine(unit)).toBe(2);
    expect(parseLitellmWorkersFromCommandLine("litellm --num_workers=3 --port 4000")).toBe(3);
  });

  it("answers null for a launch line that declares no usable number", () => {
    expect(parseLitellmWorkersFromCommandLine("litellm --port 4000")).toBeNull();
    expect(parseLitellmWorkersFromCommandLine("litellm --num_workers 0")).toBeNull();
    expect(parseLitellmWorkersFromCommandLine("litellm --num_workers two")).toBeNull();
  });

  it("treats an unreadable unit file as no answer, not as an error", async () => {
    const port = createUnitFileDeclaredWorkers("/nonexistent/unit", async () => {
      throw new Error("EACCES");
    });
    expect(await port.readDeclaredWorkers()).toBeNull();
    const readable = createUnitFileDeclaredWorkers("/unit", async () => "ExecStart=litellm --num_workers 2");
    expect(await readable.readDeclaredWorkers()).toBe(2);
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
    const second = readPrometheusCpuSamples(parsePrometheusText(exposition.join("\n").replace('process_cpu_seconds_total{pid="11"} 10', 'process_cpu_seconds_total{pid="11"} 11')));
    expect(derivePerWorkerCpu(null, first, 10)).toBeNull();
    expect(derivePerWorkerCpu(first, second, 10)).toBe(5);
  });

  it("remembers the previous scrape in the sampler", () => {
    const sampler = new LitellmWorkerCpuSampler();
    const first = readPrometheusCpuSamples(parsePrometheusText(exposition.join("\n")));
    const second = readPrometheusCpuSamples(parsePrometheusText(exposition.join("\n").replace('process_cpu_seconds_total{pid="11"} 10', 'process_cpu_seconds_total{pid="11"} 11')));
    expect(sampler.observe(first, 1_000)).toBeNull();
    expect(sampler.observe(second, 11_000)).toBe(5);
  });

  it("reports the three numbers together", () => {
    const samples = parsePrometheusText(exposition.join("\n"));
    expect(readPrometheusMetrics(samples, null)).toEqual({ perWorkerCpu: null, medianLatencyMs: 400, queueDepth: 5 });
  });
});

describe("GET the worker count", () => {
  it("reports the pool the gateway's own gauge names, the default target and the live numbers", async () => {
    const view = await readLitellmWorkersView(depsWith({ gateway: new FakeGateway(4) }), COMPANY);
    expect(view.current).toBe(4);
    expect(view.currentSource).toBe("gateway");
    expect(view.target).toBe(5);
    expect(view.targetSource).toBe("default");
    expect(view.maxByCpu).toBe(6);
    expect(view.maxByMemory).toBe(8);
    expect(view.metrics).toEqual({ perWorkerCpu: 42, medianLatencyMs: 210, queueDepth: 3 });
    expect(view.metricsSource).toBe("gateway");
    expect(view.apply).toEqual({ path: "restart", configured: false, interruption: true });
  });

  it("says the apply path is configured once a restart command is set", async () => {
    const view = await readLitellmWorkersView(depsWith({ gateway: new FakeGateway(2), env: RESTART_ENV }), COMPANY);
    expect(view.apply).toEqual({ path: "restart", configured: true, interruption: true });
  });

  it("takes current from the launch line when the exposition names no pool (multiprocess Prometheus)", async () => {
    // The production shape: /metrics answers, but in multiprocess mode it has no
    // worker gauge, so the number comes from `--num_workers 2` of the unit.
    const deps = depsWith({ gateway: new FakeGateway(null, null), declared: new FakeLaunchLine(2) });
    const view = await readLitellmWorkersView(deps, COMPANY);
    expect(view.gateway.reachable).toBe(true);
    expect(view.metricsSource).toBe("gateway");
    expect(view.current).toBe(2);
    expect(view.currentSource).toBe("launch_line");
  });

  it("prefers the launch line over a per-pid hint and over the board's own record", async () => {
    const deps = depsWith({
      gateway: new FakeGateway(1, "pids"),
      declared: new FakeLaunchLine(2),
      seed: { [COMPANY]: { target: null, observed: { workers: 6, at: "2026-10-01T00:00:00.000Z" } } },
    });
    const view = await readLitellmWorkersView(deps, COMPANY);
    expect(view.current).toBe(2);
    expect(view.currentSource).toBe("launch_line");
  });

  it("reports the stored target over the default", async () => {
    const deps = depsWith({ gateway: new FakeGateway(4), seed: { [COMPANY]: { target: 2, observed: null } } });
    const view = await readLitellmWorkersView(deps, COMPANY);
    expect(view.target).toBe(2);
    expect(view.targetSource).toBe("settings");
  });

  it("falls back to the declared baseline when nothing reads the pool", async () => {
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
    // Nothing knows the pool: no number is invented for the card.
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
    expect(view.currentSource).toBe("unknown");
  });

  it("still reports current from the launch line while the gateway answers 401 (the pre-fix production state)", async () => {
    const gateway = new FakeGateway(null, null);
    gateway.error = "gateway metrics answered HTTP 401";
    const view = await readLitellmWorkersView(depsWith({ gateway, declared: new FakeLaunchLine(2) }), COMPANY);
    expect(view.gateway.reachable).toBe(false);
    expect(view.gateway.error).toBe("gateway metrics answered HTTP 401");
    expect(view.current).toBe(2);
    expect(view.currentSource).toBe("launch_line");
  });
});

describe("reading /metrics of a gateway over HTTP: reachable and current", () => {
  const MULTIPROC_EXPOSITION = [
    "# TYPE litellm_in_flight_requests gauge",
    "litellm_in_flight_requests 1",
    'litellm_request_total_latency_metric_bucket{le="0.5"} 10',
    'litellm_request_total_latency_metric_bucket{le="+Inf"} 20',
  ].join("\n");

  /** A gateway that checks the path and the key the way the production one does. */
  function httpGateway(input: { acceptedKey: string; sentKey: string | null }) {
    const urls: string[] = [];
    const fetchImpl = (async (url: string, init?: { headers?: Record<string, string> }) => {
      urls.push(url);
      const auth = init?.headers?.authorization ?? null;
      if (!url.endsWith("/metrics/")) return new Response("", { status: 307, headers: { location: "/metrics/" } });
      if (auth !== `Bearer ${input.acceptedKey}`) return new Response("unauthorized", { status: 401 });
      return new Response(MULTIPROC_EXPOSITION, { status: 200 });
    }) as unknown as typeof fetch;
    const gateway = createLitellmWorkersGateway({
      baseUrl: "http://gateway.test:4000/",
      fetchImpl,
      resolveKey: async () => input.sentKey,
    });
    return { gateway, urls };
  }

  it("is reachable with a key that may read /metrics, and current comes from the launch line", async () => {
    const { gateway, urls } = httpGateway({ acceptedKey: "k-metrics", sentKey: "k-metrics" });
    const view = await readLitellmWorkersView(depsWith({ gateway, declared: new FakeLaunchLine(2) }), COMPANY);
    // The slash is part of the request: the bare path is a redirect.
    expect(urls).toEqual(["http://gateway.test:4000/metrics/"]);
    expect(view.gateway.reachable).toBe(true);
    expect(view.gateway.error).toBeNull();
    expect(view.metricsSource).toBe("gateway");
    expect(view.metrics.queueDepth).toBe(1);
    expect(view.metrics.medianLatencyMs).toBe(500);
    expect(view.current).toBe(2);
    expect(view.currentSource).toBe("launch_line");
  });

  it("is not reachable without a key (401), and current is still the launch line, never null", async () => {
    const { gateway } = httpGateway({ acceptedKey: "k-metrics", sentKey: null });
    const view = await readLitellmWorkersView(depsWith({ gateway, declared: new FakeLaunchLine(2) }), COMPANY);
    expect(view.gateway.reachable).toBe(false);
    expect(view.gateway.error).toBe("gateway metrics answered HTTP 401");
    expect(view.metricsSource).toBe("unavailable");
    expect(view.current).toBe(2);
  });

  it("resolves the key per company on every read", async () => {
    const asked: string[] = [];
    const gateway = createLitellmWorkersGateway({
      baseUrl: "http://gateway.test:4000",
      fetchImpl: (async () => new Response(MULTIPROC_EXPOSITION, { status: 200 })) as typeof fetch,
      resolveKey: async (companyId) => {
        asked.push(companyId);
        return "k";
      },
    });
    await gateway.readMetrics("company-a");
    await gateway.readMetrics("company-b");
    expect(asked).toEqual(["company-a", "company-b"]);
  });
});

describe("PUT the worker count", () => {
  it("restarts the unit with the target and confirms the new pool size", async () => {
    const launch = new FakeLaunchLine(2);
    const runner = restartMoving(launch);
    const deps = depsWith({ gateway: new FakeGateway(null, null), declared: launch, runner, env: RESTART_ENV });
    const result = await applyLitellmWorkersTarget(deps, { companyId: COMPANY, target: 4 });

    expect(runner.commands).toEqual(["unit-restart --workers 4"]);
    expect(result.restarted).toBe(true);
    expect(result.applied).toBe(true);
    expect(result.applyError).toBeNull();
    expect(result.view.target).toBe(4);
    expect(result.view.current).toBe(4);
    expect(result.view.currentSource).toBe("launch_line");
    expect(result.view.targetSource).toBe("settings");
    expect((await deps.store.read(COMPANY)).observed?.workers).toBe(4);
  });

  it("shrinks the pool with the same single restart", async () => {
    const launch = new FakeLaunchLine(5);
    const runner = restartMoving(launch);
    const result = await applyLitellmWorkersTarget(
      depsWith({ declared: launch, runner, env: RESTART_ENV }),
      { companyId: COMPANY, target: 2 },
    );
    expect(runner.commands).toEqual(["unit-restart --workers 2"]);
    expect(result.applied).toBe(true);
    expect(result.view.current).toBe(2);
  });

  it("does not restart when the measured pool is already at the target", async () => {
    const runner = new FakeRestart();
    const result = await applyLitellmWorkersTarget(
      depsWith({ declared: new FakeLaunchLine(5), runner, env: RESTART_ENV, seed: { [COMPANY]: { target: 5, observed: null } } }),
      { companyId: COMPANY, target: 5 },
    );
    expect(runner.commands).toEqual([]);
    expect(result.restarted).toBe(false);
    expect(result.applied).toBe(true);
    expect(result.changed).toBe(false);
  });

  it("restarts anyway when the equal number is only the board's own old record", async () => {
    const runner = new FakeRestart();
    const result = await applyLitellmWorkersTarget(
      depsWith({
        runner,
        env: RESTART_ENV,
        seed: { [COMPANY]: { target: null, observed: { workers: 4, at: "2026-10-01T00:00:00.000Z" } } },
      }),
      { companyId: COMPANY, target: 4 },
    );
    expect(runner.commands).toEqual(["unit-restart --workers 4"]);
    // The restart ran but nothing measures the pool: no applied claim.
    expect(result.applied).toBe(false);
    expect(result.applyError).toContain("could not be confirmed");
  });

  it("rejects a target above the memory ceiling with a 400 and restarts nothing", async () => {
    const runner = new FakeRestart();
    const deps = depsWith({ declared: new FakeLaunchLine(2), runner, env: RESTART_ENV });
    await expect(applyLitellmWorkersTarget(deps, { companyId: COMPANY, target: 9 })).rejects.toBeInstanceOf(HttpError);
    await expect(applyLitellmWorkersTarget(deps, { companyId: COMPANY, target: 9 })).rejects.toMatchObject({
      status: 400,
      details: { reason: "above_memory", maxByMemory: 8 },
    });
    expect(runner.commands).toEqual([]);
    expect(await deps.store.read(COMPANY)).toEqual({ target: null, observed: null });
  });

  it("stores the target but runs nothing when no restart command is configured", async () => {
    const runner = new FakeRestart();
    const deps = depsWith({ declared: new FakeLaunchLine(2), runner });
    const result = await applyLitellmWorkersTarget(deps, { companyId: COMPANY, target: 4 });

    expect(runner.commands).toEqual([]);
    expect(result.restarted).toBe(false);
    expect(result.applied).toBe(false);
    expect(result.applyError).toContain("MYRMIDON_LITELLM_WORKERS_RESTART_COMMAND");
    expect(result.view.target).toBe(4);
    expect(result.view.current).toBe(2);
    expect((await deps.store.read(COMPANY)).target).toBe(4);
  });

  it("stores the target and refuses to restart blind when the pool size is unknown", async () => {
    const runner = new FakeRestart();
    const deps = depsWith({ runner, env: RESTART_ENV });
    const result = await applyLitellmWorkersTarget(deps, { companyId: COMPANY, target: 4 });

    expect(runner.commands).toEqual([]);
    expect(result.applied).toBe(false);
    expect(result.applyError).toContain("could not be read");
    expect(result.view.current).toBeNull();
    expect(result.view.currentSource).toBe("unknown");
    expect((await deps.store.read(COMPANY)).target).toBe(4);
  });

  it("reports a failed restart and keeps the real pool size", async () => {
    const runner = new FakeRestart();
    runner.failWith = "exit 1: unit failed to start";
    const deps = depsWith({ declared: new FakeLaunchLine(2), runner, env: RESTART_ENV });
    const result = await applyLitellmWorkersTarget(deps, { companyId: COMPANY, target: 4 });

    expect(result.restarted).toBe(true);
    expect(result.applied).toBe(false);
    expect(result.applyError).toBe("the gateway restart failed: exit 1: unit failed to start");
    expect(result.view.current).toBe(2);
    expect(result.view.target).toBe(4);
    expect((await deps.store.read(COMPANY)).observed?.workers).toBe(2);
  });

  it("does not claim applied when the restart returned but the pool is not the target", async () => {
    // The command exits 0 and the unit still says 2: the board must not believe it.
    const runner = new FakeRestart();
    const result = await applyLitellmWorkersTarget(
      depsWith({ declared: new FakeLaunchLine(2), runner, env: RESTART_ENV }),
      { companyId: COMPANY, target: 4 },
    );
    expect(runner.commands).toEqual(["unit-restart --workers 4"]);
    expect(result.applied).toBe(false);
    expect(result.applyError).toBe("the gateway was restarted but runs 2 worker process(es), not the requested 4");
    expect(result.view.current).toBe(2);
  });

  it("keeps the stored target across a resize of another company", async () => {
    const launch = new FakeLaunchLine(4);
    const store = memoryLitellmWorkersStore({});
    const deps: LitellmWorkersDeps = {
      store,
      env: RESTART_ENV,
      gateway: new FakeGateway(null, null),
      declared: launch,
      restartRunner: restartMoving(launch),
    };
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
describe("the unit of perWorkerCpu on the wire", () => {
  // The interface (litellmWorkersApi.perWorkerCpuSeries) clamps to 0..100 and
  // draws the number as a percentage, so the API must send percent, not a 0..1
  // fraction: 0.05 would be drawn as a 0.05% bar.
  it("sends percent: one worker burning 1 CPU-second in 10 s with another idle is 5, not 0.05", async () => {
    const scrapes = [
      ['process_cpu_seconds_total{pid="11"} 10', 'process_cpu_seconds_total{pid="12"} 20'].join("\n"),
      ['process_cpu_seconds_total{pid="11"} 11', 'process_cpu_seconds_total{pid="12"} 20'].join("\n"),
    ];
    let call = 0;
    vi.useFakeTimers({ toFake: ["Date"] });
    const gateway = createLitellmWorkersGateway({
      baseUrl: "http://gateway.test",
      fetchImpl: (async () => new Response(scrapes[call++] ?? "", { status: 200 })) as typeof fetch,
    });
    try {
      vi.setSystemTime(1_000);
      await gateway.readMetrics(COMPANY);
      vi.setSystemTime(11_000);
      const second = await gateway.readMetrics(COMPANY);
      expect(second.ok && second.metrics.perWorkerCpu).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a fully busy worker at 100", () => {
    const first = new Map([["11", 0]]);
    const second = new Map([["11", 10]]);
    expect(derivePerWorkerCpu(first, second, 10)).toBe(100);
  });
});

describe("two PUTs at once", () => {
  /** A restart that takes a moment, the way a real unit restart does. */
  function slowUnit(start: number) {
    const launch = new FakeLaunchLine(start);
    const runner = restartMoving(launch);
    const originalRun = runner.run.bind(runner);
    runner.run = async (command: string) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return originalRun(command);
    };
    return { launch, runner };
  }

  it("without a lock both read the same pool and both restart (the race the lock closes)", async () => {
    const { launch, runner } = slowUnit(2);
    const deps = { ...depsWith({ declared: launch, runner, env: RESTART_ENV }), lock: noLitellmWorkersLock() };
    await Promise.all([
      applyLitellmWorkersTarget(deps, { companyId: COMPANY, target: 4 }),
      applyLitellmWorkersTarget(deps, { companyId: COMPANY, target: 4 }),
    ]);
    expect(runner.commands.length).toBe(2);
  });

  it("under the lock the second PUT sees the first one's result and restarts nothing", async () => {
    const { launch, runner } = slowUnit(2);
    const deps = { ...depsWith({ declared: launch, runner, env: RESTART_ENV }), lock: inProcessLitellmWorkersLock() };
    const [first, second] = await Promise.all([
      applyLitellmWorkersTarget(deps, { companyId: COMPANY, target: 4 }),
      applyLitellmWorkersTarget(deps, { companyId: COMPANY, target: 4 }),
    ]);
    expect(runner.commands).toEqual(["unit-restart --workers 4"]);
    expect(launch.workers).toBe(4);
    expect(first.applied && second.applied).toBe(true);
    expect(second.restarted).toBe(false);
  });

  it("serialises two companies as well: the pool is one per instance", async () => {
    const { launch, runner } = slowUnit(2);
    const deps = { ...depsWith({ declared: launch, runner, env: RESTART_ENV }), lock: inProcessLitellmWorkersLock() };
    await Promise.all([
      applyLitellmWorkersTarget(deps, { companyId: COMPANY, target: 4 }),
      applyLitellmWorkersTarget(deps, { companyId: "other-company", target: 3 }),
    ]);
    // 2 -> 4, then 4 -> 3: the pool ends where the last PUT asked.
    expect(runner.commands).toEqual(["unit-restart --workers 4", "unit-restart --workers 3"]);
    expect(launch.workers).toBe(3);
  });
});
