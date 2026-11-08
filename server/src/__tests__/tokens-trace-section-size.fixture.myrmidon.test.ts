import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import fixture from "./fixtures/tokens-trace-section-size.fixture.json";

type Trace = (typeof fixture.calls)[number]["trace"];
const canonicalTools = fixture.toolsRevision.canonicalTools;

function toolsRevision(tools: typeof canonicalTools): string {
  return createHash("sha256").update(JSON.stringify(tools)).digest("hex");
}

function serializedTracePayload(): string {
  return JSON.stringify({
    version: fixture.version,
    release: fixture.release,
    feature: fixture.feature,
    toolsRevision: fixture.toolsRevision,
    calls: fixture.calls,
  });
}

describe("TOKENS-TRACE section-size fixture (1.6.7)", () => {
  it("hashes the canonical tool set and keeps its revision stable", () => {
    expect(toolsRevision(canonicalTools)).toBe(fixture.toolsRevision.expectedSha256);
    expect(toolsRevision([...canonicalTools].reverse())).not.toBe(fixture.toolsRevision.expectedSha256);
    expect(fixture.calls.every(({ trace }) => trace.toolsRev === fixture.toolsRevision.expectedSha256)).toBe(true);
  });

  it("covers every content section without retaining the content", () => {
    for (const { trace } of fixture.calls) {
      const section = trace.sections;
      for (const key of ["system", "tools", "wake", "history", "toolResults"] as const) {
        expect(section[`${key}Chars`]).toBeGreaterThan(0);
        expect(section[`${key}Tokens`]).toBeGreaterThan(0);
      }
      expect(section.totalChars).toBeGreaterThan(0);
      expect(section.totalTokens).toBeGreaterThan(0);
    }
    const traceKeys = Object.keys(fixture.calls[0]!.trace);
    expect(traceKeys).not.toContain("system");
    expect(traceKeys).not.toContain("tools");
    expect(traceKeys).not.toContain("wake");
    expect(traceKeys).not.toContain("history");
    expect(traceKeys).not.toContain("toolResults");
    expect(serializedTracePayload()).not.toContain("secretLeakSamples");
  });

  it("records compaction before and after with reduced history and results", () => {
    const before = fixture.calls[0]!.trace as Trace;
    const after = fixture.calls[1]!.trace as Trace;
    expect(before.compacted).toBe(false);
    expect(after.compacted).toBe(true);
    expect(after.preCompactChars).toBe(before.sections.totalChars);
    expect(after.postCompactChars).toBe(after.sections.totalChars);
    expect(after.sections.historyChars).toBeLessThan(before.sections.historyChars);
    expect(after.sections.toolResultsChars).toBeLessThan(before.sections.toolResultsChars);
    expect(after.sections.systemChars).toBe(before.sections.systemChars);
    expect(after.sections.toolsChars).toBe(before.sections.toolsChars);
  });

  it("fails closed if a raw secret-like value is emitted", () => {
    expect(fixture.secretLeakChecks.rawValuesStored).toBe(false);
    expect(fixture.secretLeakChecks.forbiddenPatternNames).toEqual([
      "paperclip API key",
      "bearer token",
      "private key",
      "prompt text",
    ]);
    const emitted = serializedTracePayload();
    expect(emitted).not.toMatch(/(?:pcp|sk)-[A-Za-z0-9_-]{8,}/);
    expect(emitted).not.toMatch(/Bearer\s+[A-Za-z0-9._-]+/);
    expect(emitted).not.toMatch(/-----BEGIN [A-Z ]+-----/);
  });
});
