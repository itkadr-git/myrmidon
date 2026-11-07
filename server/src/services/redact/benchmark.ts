import os from "node:os";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { redactSecrets } from "./secret-detector.js";

export interface BenchmarkSizeConfig {
  label: string;
  bytes: number;
  iterations?: number;
}

export interface LatencyStats {
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
}

export interface ThroughputStats {
  bytesPerSec: number;
  mbPerSec: number;
  opsPerSec: number;
  charsPerSec: number;
}

export interface CpuStats {
  userMs: number;
  systemMs: number;
  totalMs: number;
  percent: number;
}

export interface MemoryStats {
  heapUsedDeltaBytes: number;
  heapUsedDeltaMb: number;
  heapTotalDeltaBytes: number;
  rssDeltaBytes: number;
  rssDeltaMb: number;
}

export interface BenchmarkResult {
  sizeLabel: string;
  sizeBytes: number;
  iterations: number;
  latencies: LatencyStats;
  throughput: ThroughputStats;
  cpu: CpuStats;
  memory: MemoryStats;
  rawLatenciesMs: number[];
}

export interface BenchmarkReport {
  timestamp: string;
  service: string;
  version: string;
  environment: {
    node: string;
    platform: string;
    arch: string;
    cpus: number;
  };
  results: BenchmarkResult[];
}

export interface BenchmarkOptions {
  sizes?: BenchmarkSizeConfig[];
  defaultIterations?: number;
  warmupIterations?: number;
  redactFn?: (text: string) => string | Promise<string>;
  sampleGenerator?: (targetBytes: number) => string;
}

export const DEFAULT_BENCHMARK_SIZES: BenchmarkSizeConfig[] = [
  { label: "1 KB", bytes: 1024, iterations: 50 },
  { label: "10 KB", bytes: 10 * 1024, iterations: 30 },
  { label: "100 KB", bytes: 100 * 1024, iterations: 10 },
];

const samplePcpToken = ["pcp", "live", "sampleauthkeyvalue12345"].join("_");
const sampleGhpToken = ["ghp", "samplegithubpattokenvalue12345"].join("_");
const sampleSkToken = ["sk", "sampleopenaikeyvalue12345"].join("-");
const sampleBearerToken = ["sample", "bearer", "token", "payload", "12345"].join("-");
const sampleDbSecret = ["secret", "db", "cluster", "master", "credential", "012345"].join("-");

export const BASE_BENCHMARK_CORPUS = `
АКТ ПРИЕМА-ПЕРЕДАЧИ ОБОРУДОВАНИЯ И ОКАЗАНИЯ УСЛУГ № 482/2026
г. Москва, Пресненская наб., д. 12                                      03 ноября 2026 г.

Общество с ограниченной ответственностью «Альфа-Технологии» (ООО «Альфа-Тех»),
ИНН 7707083893, КПП 773601001, ОГРН 1027700132195, ОКПО 12345678,
в лице генерального директора Иванова Сергея Петровича, паспорт серии 4510 № 123456,
выдан Отделом УФМС России по г. Москве 15.05.2012, код подразделения 770-001,
СНИЛС 112-233-445 95, действующего на основании Устава, с одной стороны,
и Публичное акционерное общество «ИнфоСистемы» (ПАО «ИнфоСистемы»),
ИНН 500100732259, ОГРН 304500116000157, расчетный счет 40702810938000012345
в ПАО СБЕРБАНК, корр. счет 30101810400000000225, БИК 044525225,
с другой стороны, составили настоящий акт о нижеследующем:

1. Исполнитель выполнил работы по настройке и вводу в эксплуатацию серверного кластера Myrmidon.
2. Авторизация агентов произведена с использованием ключей доступа:
   - Paperclip Agent Token: ${samplePcpToken}
   - GitHub Deployment Token: ${sampleGhpToken}
   - OpenAI Gateway Key: ${sampleSkToken}
   - Internal Bearer Token: Bearer ${sampleBearerToken}
   - Database Master Secret: ${sampleDbSecret}
3. Оплата сервисных сборов проведена корпоративной картой: 4532015112830366.
4. Контактные данные ответственных инженеров:
   - Email: s.ivanov@alpha-tech.example.com, tech-support@myrmidon.local
   - Телефон: +7 (495) 123-45-67, моб. +7 999 888-77-66.
5. Настоящий акт подтверждает полное исполнение обязательств сторонами без претензий по качеству и срокам.
`;

/**
 * Generates valid UTF-8 text with exact byte length matching `targetBytes`,
 * containing a realistic mix of natural language text and sensitive entities.
 */
export function generateBenchmarkText(targetBytes: number): string {
  if (targetBytes <= 0) return "";

  let text = "";
  while (Buffer.byteLength(text, "utf-8") < targetBytes) {
    text += BASE_BENCHMARK_CORPUS;
  }

  // Trim down while avoiding slicing multi-byte characters
  while (Buffer.byteLength(text, "utf-8") > targetBytes) {
    text = text.slice(0, -1);
  }

  // Pad to exact byte length with ASCII spaces if needed
  const currentBytes = Buffer.byteLength(text, "utf-8");
  if (currentBytes < targetBytes) {
    text += " ".repeat(targetBytes - currentBytes);
  }

  return text;
}

/**
 * Computes standard percentile value using linear interpolation.
 */
export function calculatePercentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

/**
 * Computes min, max, mean, p50, p95, and p99 from an array of latencies in ms.
 */
export function calculateLatencyStats(latencies: number[]): LatencyStats {
  if (latencies.length === 0) {
    return { min: 0, max: 0, mean: 0, p50: 0, p95: 0, p99: 0 };
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const mean = sum / sorted.length;
  const min = sorted[0];
  const max = sorted[sorted.length - 1];

  const p50 = calculatePercentile(sorted, 50);
  const p95 = calculatePercentile(sorted, 95);
  const p99 = calculatePercentile(sorted, 99);

  return {
    min: Number(min.toFixed(3)),
    max: Number(max.toFixed(3)),
    mean: Number(mean.toFixed(3)),
    p50: Number(p50.toFixed(3)),
    p95: Number(p95.toFixed(3)),
    p99: Number(p99.toFixed(3)),
  };
}

/**
 * Executes a reproducible redact benchmark measuring response times (p50, p95, p99),
 * throughput, CPU usage, and memory deltas across specified text sizes.
 */
export async function runRedactBenchmark(
  options?: BenchmarkOptions,
): Promise<BenchmarkReport> {
  const sizes = options?.sizes ?? DEFAULT_BENCHMARK_SIZES;
  const warmupCount = options?.warmupIterations ?? 3;
  const redactFn = options?.redactFn ?? ((t: string) => redactSecrets(t));
  const textGenerator = options?.sampleGenerator ?? generateBenchmarkText;

  const results: BenchmarkResult[] = [];

  for (const sizeConfig of sizes) {
    const text = textGenerator(sizeConfig.bytes);
    const iterations =
      sizeConfig.iterations ?? options?.defaultIterations ?? 30;

    // Warmup JIT compilation and regex state
    for (let w = 0; w < warmupCount; w++) {
      await redactFn(text);
    }

    if (typeof global.gc === "function") {
      global.gc();
    }

    const memBefore = process.memoryUsage();
    const cpuBefore = process.cpuUsage();
    const wallStart = performance.now();

    const latencies: number[] = [];
    for (let i = 0; i < iterations; i++) {
      const iterStart = performance.now();
      await redactFn(text);
      const iterEnd = performance.now();
      latencies.push(iterEnd - iterStart);
    }

    const wallTotalMs = performance.now() - wallStart;
    const cpuDiff = process.cpuUsage(cpuBefore);
    const memAfter = process.memoryUsage();

    const latencyStats = calculateLatencyStats(latencies);
    const wallSec = wallTotalMs / 1000;
    const totalBytes = sizeConfig.bytes * iterations;
    const mbPerSec = wallSec > 0 ? totalBytes / (1024 * 1024) / wallSec : 0;
    const opsPerSec = wallSec > 0 ? iterations / wallSec : 0;
    const charsPerSec = wallSec > 0 ? (text.length * iterations) / wallSec : 0;

    const userMs = cpuDiff.user / 1000;
    const sysMs = cpuDiff.system / 1000;
    const totalCpuMs = userMs + sysMs;
    const cpuPercent = wallTotalMs > 0 ? (totalCpuMs / wallTotalMs) * 100 : 0;

    const heapUsedDelta = memAfter.heapUsed - memBefore.heapUsed;
    const rssDelta = memAfter.rss - memBefore.rss;

    results.push({
      sizeLabel: sizeConfig.label,
      sizeBytes: sizeConfig.bytes,
      iterations,
      latencies: latencyStats,
      throughput: {
        bytesPerSec: wallSec > 0 ? totalBytes / wallSec : 0,
        mbPerSec: Number(mbPerSec.toFixed(2)),
        opsPerSec: Number(opsPerSec.toFixed(2)),
        charsPerSec: Number(charsPerSec.toFixed(2)),
      },
      cpu: {
        userMs: Number(userMs.toFixed(2)),
        systemMs: Number(sysMs.toFixed(2)),
        totalMs: Number(totalCpuMs.toFixed(2)),
        percent: Number(cpuPercent.toFixed(1)),
      },
      memory: {
        heapUsedDeltaBytes: heapUsedDelta,
        heapUsedDeltaMb: Number((heapUsedDelta / (1024 * 1024)).toFixed(3)),
        heapTotalDeltaBytes: memAfter.heapTotal - memBefore.heapTotal,
        rssDeltaBytes: rssDelta,
        rssDeltaMb: Number((rssDelta / (1024 * 1024)).toFixed(3)),
      },
      rawLatenciesMs: latencies,
    });
  }

  return {
    timestamp: new Date().toISOString(),
    service: "myrmidon-redact",
    version: "1.7.0",
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpus: os.cpus()?.length ?? 1,
    },
    results,
  };
}

/**
 * Formats a BenchmarkReport into a structured ASCII table and summary.
 */
export function formatBenchmarkReport(report: BenchmarkReport): string {
  const lines: string[] = [];
  lines.push("=".repeat(92));
  lines.push("MYRMIDON REDACT BENCHMARK REPORT");
  lines.push("=".repeat(92));
  lines.push(`Timestamp:   ${report.timestamp}`);
  lines.push(`Service:     ${report.service} v${report.version}`);
  lines.push(
    `Environment: Node ${report.environment.node}, ${report.environment.platform} ${report.environment.arch} (${report.environment.cpus} CPUs)`,
  );
  lines.push("-".repeat(92));
  lines.push(
    "Size     | Iter | p50 (ms) | p95 (ms) | p99 (ms) | Mean (ms) | Throughput   | CPU Total | Heap Delta",
  );
  lines.push(
    "---------+------+----------+----------+----------+-----------+--------------+-----------+-----------",
  );

  for (const r of report.results) {
    const size = r.sizeLabel.padEnd(8);
    const iter = String(r.iterations).padStart(4);
    const p50 = r.latencies.p50.toFixed(2).padStart(8);
    const p95 = r.latencies.p95.toFixed(2).padStart(8);
    const p99 = r.latencies.p99.toFixed(2).padStart(8);
    const mean = r.latencies.mean.toFixed(2).padStart(9);
    const throughput = `${r.throughput.mbPerSec.toFixed(2)} MB/s`.padStart(12);
    const cpu = `${r.cpu.totalMs.toFixed(1)} ms`.padStart(9);
    const heap = `${r.memory.heapUsedDeltaMb >= 0 ? "+" : ""}${r.memory.heapUsedDeltaMb.toFixed(2)} MB`.padStart(9);

    lines.push(
      `${size} | ${iter} | ${p50} | ${p95} | ${p99} | ${mean} | ${throughput} | ${cpu} | ${heap}`,
    );
  }

  lines.push("=".repeat(92));
  lines.push("Acceptance Criteria Verification:");

  const r10Kb = report.results.find(
    (r) => r.sizeBytes === 10 * 1024 || r.sizeLabel === "10 KB",
  );
  if (r10Kb) {
    const passed = r10Kb.latencies.p95 <= 50;
    lines.push(
      `- Latency 10 KB (p95 <= 50 ms): ${r10Kb.latencies.p95.toFixed(2)} ms -> [${passed ? "PASSED" : "FAILED"}]`,
    );
    lines.push(
      `- Latency 10 KB (p50): ${r10Kb.latencies.p50.toFixed(2)} ms`,
    );
    lines.push(
      `- Latency 10 KB (p99): ${r10Kb.latencies.p99.toFixed(2)} ms`,
    );
  }

  lines.push("=".repeat(92));
  return lines.join("\n");
}
