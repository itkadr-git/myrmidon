import { describe, expect, it } from "vitest";
import {
  runRedactBenchmark,
  formatBenchmarkReport,
  generateBenchmarkText,
  calculateLatencyStats,
  DEFAULT_BENCHMARK_SIZES,
  type BenchmarkReport,
} from "../../server/src/services/redact/benchmark.js";

describe("Myrmidon REDACT Performance Benchmark (OPE-10193)", () => {
  it("generates synthetic corpus with exact byte sizes", () => {
    for (const size of DEFAULT_BENCHMARK_SIZES) {
      const text = generateBenchmarkText(size.bytes);
      expect(Buffer.byteLength(text, "utf-8")).toBe(size.bytes);
      expect(text.length).toBeGreaterThan(0);
    }
  });

  it("calculates accurate percentile and latency statistics", () => {
    const latencies = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const stats = calculateLatencyStats(latencies);
    expect(stats.min).toBe(1);
    expect(stats.max).toBe(10);
    expect(stats.mean).toBe(5.5);
    expect(stats.p50).toBe(5.5);
    expect(stats.p95).toBeCloseTo(9.55, 1);
    expect(stats.p99).toBeCloseTo(9.91, 1);
  });

  it("generates a comprehensive benchmark report with p50, p95, p99 latencies across 1 KB, 10 KB, and 100 KB", async () => {
    const report: BenchmarkReport = await runRedactBenchmark({
      sizes: [
        { label: "1 KB", bytes: 1024, iterations: 20 },
        { label: "10 KB", bytes: 10 * 1024, iterations: 20 },
        { label: "100 KB", bytes: 100 * 1024, iterations: 5 },
      ],
      warmupIterations: 2,
    });

    expect(report).toBeDefined();
    expect(report.service).toBe("myrmidon-redact");
    expect(report.results).toHaveLength(3);

    const labels = report.results.map((r) => r.sizeLabel);
    expect(labels).toEqual(["1 KB", "10 KB", "100 KB"]);

    for (const result of report.results) {
      // Latency percentiles check
      expect(result.latencies.min).toBeGreaterThan(0);
      expect(result.latencies.p50).toBeGreaterThanOrEqual(result.latencies.min);
      expect(result.latencies.p95).toBeGreaterThanOrEqual(result.latencies.p50);
      expect(result.latencies.p99).toBeGreaterThanOrEqual(result.latencies.p95);
      expect(result.latencies.max).toBeGreaterThanOrEqual(result.latencies.p99);

      // Throughput check
      expect(result.throughput.mbPerSec).toBeGreaterThan(0);
      expect(result.throughput.opsPerSec).toBeGreaterThan(0);

      // CPU and memory metrics check
      expect(result.cpu.totalMs).toBeGreaterThanOrEqual(0);
      expect(typeof result.memory.heapUsedDeltaBytes).toBe("number");
      expect(typeof result.memory.heapUsedDeltaMb).toBe("number");
    }

    const formatted = formatBenchmarkReport(report);
    expect(formatted).toContain("MYRMIDON REDACT BENCHMARK REPORT");
    expect(formatted).toContain("p50");
    expect(formatted).toContain("p95");
    expect(formatted).toContain("p99");
    expect(formatted).toContain("Throughput");
    expect(formatted).toContain("CPU Total");
    expect(formatted).toContain("Heap Delta");
    expect(formatted).toContain("PASSED");
  });

  it("latency for 10 KB text does not exceed 50 ms on base configuration", async () => {
    const report = await runRedactBenchmark({
      sizes: [{ label: "10 KB", bytes: 10 * 1024, iterations: 30 }],
      warmupIterations: 3,
    });

    const result10Kb = report.results.find(
      (r) => r.sizeBytes === 10 * 1024 || r.sizeLabel === "10 KB",
    );
    expect(result10Kb).toBeDefined();

    // Acceptance criterion: latency for 10 KB does not exceed 50 ms
    expect(result10Kb!.latencies.p50).toBeLessThanOrEqual(50);
    expect(result10Kb!.latencies.p95).toBeLessThanOrEqual(50);
    expect(result10Kb!.latencies.p99).toBeLessThanOrEqual(50);
    expect(result10Kb!.latencies.mean).toBeLessThanOrEqual(50);
  });
});
