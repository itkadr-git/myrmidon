import { describe, expect, it, vi } from "vitest";
import {
  readTracingHealthSettings,
  LANGFUSE_CLICKHOUSE_URL_ENV,
  LANGFUSE_EVENTS_SECRET_ENV,
  LITELLM_METRICS_URL_ENV,
  LITELLM_METRICS_SECRET_ENV,
  TRACING_WINDOW_MS_ENV,
  TRACING_MAX_CALLBACK_FAILURES_ENV,
} from "./settings.js";
import {
  parsePrometheusLine,
  prometheusLabel,
  parseClickHouseCount,
  type CallbackFailureSeries,
  type TracingProbeClient,
} from "./clients.js";
import { tracingHealthService, sumCallbackFailures, legFailureSummary, type TracingHealthCard } from "./service.js";
import { recordTracingHealthSignal, readTracingHealthAttentionSignal, resetTracingHealthSignals } from "./attention-bridge.js";

// TRACING-HEALTH: the OK decision is a delivery ratio — events in
// events_core while the gateway served traffic and callbacks are quiet; the
// incident was exactly "traces flowed, errors burned CPU, nobody noticed".
const NOW = new Date("2026-10-02T12:00:00.000Z");
const COMPANY = "11111111-1111-4111-8111-111111111111";

const ENABLED_ENV = {
  [LANGFUSE_CLICKHOUSE_URL_ENV]: "http://192.0.2.10:8123",
  [LANGFUSE_EVENTS_SECRET_ENV]: "tracing-clickhouse-key",
  [LITELLM_METRICS_URL_ENV]: "http://192.0.2.20:4000/metrics",
  [LITELLM_METRICS_SECRET_ENV]: "tracing-litellm-key",
} as Record<string, string>;

function makeDb(overrides: { costEvents?: number; runs?: number } = {}) {
  const state = { costEvents: overrides.costEvents ?? 0, runs: overrides.runs ?? 0 };
  const thenable = () => Promise.resolve([{ count: state.costEvents > 0 ? state.costEvents : state.runs }]);
  const proxy: Record<string, unknown> = {
    from: () => proxy,
    where: () => proxy,
    then: (resolve: (rows: unknown) => void) => thenable().then(resolve),
  };
  return {
    select: () => proxy,
    __state: state,
  } as unknown as Parameters<typeof tracingHealthService>[0]["db"];
}

function makeClient(
  eventsCore: number,
  failures: CallbackFailureSeries[],
  opts: { eventsThrows?: boolean; metricsThrows?: boolean } = {},
): TracingProbeClient {
  return {
    async countEventsCoreSince() {
      if (opts.eventsThrows) throw new Error("probe down");
      return { count: eventsCore };
    },
    async readGatewayMetrics() {
      if (opts.metricsThrows) throw new Error("metrics down");
      return { callbackFailures: failures, hasMetrics: true };
    },
  };
}

function makeService(input: {
  env?: Record<string, string>;
  envOverrideAll?: boolean;
  eventsCore?: number;
  failures?: CallbackFailureSeries[];
  costEvents?: number;
  runs?: number;
  clientOpts?: { eventsThrows?: boolean; metricsThrows?: boolean };
  readSecretValue?: (companyId: string, name: string) => Promise<string | null>;
} = {}) {
  const readSecretValue = input.readSecretValue ?? (async () => "key-value");
  const env = input.envOverrideAll ? (input.env ?? {}) : { ...ENABLED_ENV, ...(input.env ?? {}) };
  return tracingHealthService({
    db: makeDb({ costEvents: input.costEvents ?? 0, runs: input.runs ?? 0 }),
    env: env as NodeJS.ProcessEnv,
    readSecretValue,
    client: makeClient(input.eventsCore ?? 0, input.failures ?? [], input.clientOpts ?? {}),
    now: () => NOW,
  });
}

describe("myrmidon(TRACING-HEALTH) settings", () => {
  it("is disabled unless all four core values are set", () => {
    expect(readTracingHealthSettings({})).toMatchObject({ enabled: false });
    expect(readTracingHealthSettings({ [LANGFUSE_CLICKHOUSE_URL_ENV]: "http://192.0.2.10:8123" })).toMatchObject({
      enabled: false,
    });
    expect(
      readTracingHealthSettings({
        ...ENABLED_ENV,
        [LITELLM_METRICS_URL_ENV]: "ftp://192.0.2.20:4000",
      }),
    ).toMatchObject({ enabled: false });
    expect(readTracingHealthSettings(ENABLED_ENV as NodeJS.ProcessEnv)).toMatchObject({
      enabled: true,
      windowMs: 15 * 60 * 1000,
      maxCallbackFailures: 5,
    });
  });

  it("clamps the window and tolerance back to defaults on invalid input", () => {
    expect(
      readTracingHealthSettings({ ...ENABLED_ENV, [TRACING_WINDOW_MS_ENV]: "10" } as NodeJS.ProcessEnv),
    ).toMatchObject({ windowMs: 15 * 60 * 1000 });
    expect(
      readTracingHealthSettings({ ...ENABLED_ENV, [TRACING_MAX_CALLBACK_FAILURES_ENV]: "-1" } as NodeJS.ProcessEnv),
    ).toMatchObject({ maxCallbackFailures: 5 });
  });
});

describe("myrmidon(TRACING-HEALTH) probe parsers", () => {
  it("parses prometheus counter lines with and without labels", () => {
    expect(parsePrometheusLine("litellm_callback_logging_failures_metric{callback_name=\"langfuse\"} 12")).toEqual({
      name: "litellm_callback_logging_failures_metric",
      labels: '{callback_name="langfuse"}',
      value: 12,
    });
    expect(parsePrometheusLine("litellm_proxy_total_requests_metric 40")).toEqual({
      name: "litellm_proxy_total_requests_metric",
      labels: null,
      value: 40,
    });
    expect(parsePrometheusLine("# HELP some comment")).toBeNull();
    expect(parsePrometheusLine("garbage")).toBeNull();
    expect(prometheusLabel('{callback_name="langfuse_otel"}', "callback_name")).toBe("langfuse_otel");
    expect(prometheusLabel(null, "callback_name")).toBeNull();
    expect(prometheusLabel('{other="x"}', "callback_name")).toBeNull();
  });

  it("parses the clickhouse count and rejects other shapes", () => {
    expect(parseClickHouseCount('{"data":[{"count":"42"}]}')).toBe(42);
    expect(parseClickHouseCount('{"data":[{"count":7}]}')).toBe(7);
    expect(parseClickHouseCount("not json")).toBeNull();
    expect(parseClickHouseCount('{"data":[]}')).toBeNull();
    expect(parseClickHouseCount('{"data":[{}]}')).toBeNull();
  });

  it("sums callback failure series", () => {
    expect(sumCallbackFailures([{ callbackName: "langfuse", value: 3 }, { callbackName: "langfuse_otel", value: 4 }])).toBe(7);
    expect(sumCallbackFailures([])).toBe(0);
  });
});

describe("myrmidon(TRACING-HEALTH) decision", () => {
  it("OK: gateway traffic, events in events_core, zero callback failures", async () => {
    const service = makeService({ costEvents: 30, eventsCore: 28, failures: [] });
    const card = await service.evaluate(COMPANY);
    expect(card.status).toBe("ok");
    expect(card.enabled).toBe(true);
    expect(card.checks.gatewayTraffic.note).toContain("30 gateway request");
    expect(card.checks.eventsCore.count).toBe(28);
    expect(card.checks.callbackErrors.failures).toBe(0);
    expect(card.summary).toContain("healthy");
    expect(readTracingHealthAttentionSignal(COMPANY)).toBeNull();
  });

  it("RED: traffic and zero events in events_core (the incident shape: v4 rejects, nothing arrives)", async () => {
    const service = makeService({ costEvents: 30, eventsCore: 0, failures: [] });
    const card = await service.evaluate(COMPANY);
    expect(card.status).toBe("red");
    expect(card.checks.eventsCore.ok).toBe(false);
    expect(card.summary).toContain("unhealthy");
    // The operator signal exists and names the failing leg.
    const signal = readTracingHealthAttentionSignal(COMPANY);
    expect(signal).not.toBeNull();
    expect(signal!.dedupKey).toBe("tracing_health:llm-tracing");
    expect(signal!.severity).toBe("high");
    expect(signal!.whyNow).toContain("events_core");
  });

  it("RED: callback failures above tolerance (the ~12k/hour legacy callback)", async () => {
    const service = makeService({ costEvents: 30, eventsCore: 28, failures: [{ callbackName: "langfuse", value: 9000 }] });
    const card = await service.evaluate(COMPANY);
    expect(card.status).toBe("red");
    expect(card.checks.callbackErrors.ok).toBe(false);
    expect(card.checks.callbackErrors.failures).toBe(9000);
  });

  it("OK (idle) with no gateway traffic: nothing to trace is not red", async () => {
    const service = makeService({ costEvents: 0, runs: 0, eventsCore: 0, failures: [] });
    const card = await service.evaluate(COMPANY);
    expect(card.status).toBe("ok");
    expect(card.summary).toContain("idle");
    expect(readTracingHealthAttentionSignal(COMPANY)).toBeNull();
  });

  it("RED when a probe is unreachable: a dead probe is not a green card", async () => {
    const service = makeService({ costEvents: 30, eventsCore: 5, clientOpts: { eventsThrows: true } });
    const card = await service.evaluate(COMPANY);
    expect(card.status).toBe("red");
    expect(card.checks.eventsCore.note).toContain("ClickHouse probe failed");
    expect(card.checks.eventsCore.count).toBeNull();
  });

  it("RED when the metrics probe is unreachable", async () => {
    const service = makeService({ costEvents: 30, eventsCore: 5, clientOpts: { metricsThrows: true } });
    const card = await service.evaluate(COMPANY);
    expect(card.status).toBe("red");
    expect(card.checks.callbackErrors.note).toContain("LiteLLM metrics probe failed");
  });

  it("disabled settings answer a 200-style not-enabled card and clear the signal", async () => {
    const service = makeService({ env: {}, envOverrideAll: true, eventsCore: 5 });
    const card = await service.evaluate(COMPANY);
    expect(card.enabled).toBe(false);
    expect(card.status).toBe("ok");
    expect(card.summary).toContain("not enabled");
    expect(readTracingHealthAttentionSignal(COMPANY)).toBeNull();
  });

  it("the signal re-arms: red then healthy clears the attention row", async () => {
    resetTracingHealthSignals();
    const red = makeService({ costEvents: 30, eventsCore: 0 });
    await red.evaluate(COMPANY);
    expect(readTracingHealthAttentionSignal(COMPANY)).not.toBeNull();
    const green = makeService({ costEvents: 30, eventsCore: 12 });
    await green.evaluate(COMPANY);
    expect(readTracingHealthAttentionSignal(COMPANY)).toBeNull();
  });

  it("reads the probe credentials from the company secret store by name", async () => {
    const seen: Array<[string, string]> = [];
    const service = makeService({
      costEvents: 30,
      eventsCore: 10,
      readSecretValue: async (companyId, name) => {
        seen.push([companyId, name]);
        return "key-value";
      },
    });
    await service.evaluate(COMPANY);
    expect(seen).toContainEqual([COMPANY, "tracing-clickhouse-key"]);
    expect(seen).toContainEqual([COMPANY, "tracing-litellm-key"]);
  });
});

describe("myrmidon(TRACING-HEALTH) bridge", () => {
  it("records one signal per company, stable dedupKey, and clears on healthy", () => {
    resetTracingHealthSignals();
    const redCard: TracingHealthCard = {
      status: "red",
      checks: {
        gatewayTraffic: { ok: true, note: "30 gateway requests in the window" },
        eventsCore: { ok: false, note: "no events in events_core", count: 0 },
        callbackErrors: { ok: true, note: "none", failures: 0 },
      },
      summary: "LLM tracing is unhealthy",
      enabled: true,
      windowMs: 900_000,
      checkedAt: NOW.toISOString(),
    };
    recordTracingHealthSignal(COMPANY, redCard, NOW);
    const signal = readTracingHealthAttentionSignal(COMPANY);
    expect(signal).not.toBeNull();
    expect(signal!.activityAt).toBe(NOW.toISOString());
    expect(legFailureSummary(redCard)).toBe("no events in events_core");
    recordTracingHealthSignal(COMPANY, { ...redCard, status: "ok" }, NOW);
    expect(readTracingHealthAttentionSignal(COMPANY)).toBeNull();
    resetTracingHealthSignals();
  });
});
