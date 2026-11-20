import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startKnowledgeExport, stopKnowledgeExport } from "./git-export-job.js";

vi.mock("../monitoring/board-load/lanes.js", () => ({
  backgroundInterval: (work: () => void, intervalMs: number) => setInterval(work, intervalMs),
}));

const hour = 60 * 60 * 1000;
const env = {
  MYRMIDON_KNOWLEDGE_EXPORT_REPO: "https://example.test/knowledge.git",
  MYRMIDON_KNOWLEDGE_EXPORT_INTERVAL_HOURS: "1",
};
const db = {} as never;

function ports() {
  return {
    listCompanyIds: vi.fn<() => Promise<string[]>>().mockResolvedValue([]),
    exportCompany: vi.fn(),
    publish: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

describe("knowledge export scheduler lifecycle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    stopKnowledgeExport();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not access ports or schedule a timer when disabled", async () => {
    const p = ports();
    const stop = startKnowledgeExport(db, { env: {}, ports: p });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(3 * hour);
    expect(p.listCompanyIds).not.toHaveBeenCalled();
    expect(p.exportCompany).not.toHaveBeenCalled();
    expect(p.publish).not.toHaveBeenCalled();
    expect(p.log.info).not.toHaveBeenCalled();
    expect(p.log.warn).not.toHaveBeenCalled();
    expect(p.log.error).not.toHaveBeenCalled();
    stop();
  });

  it("starts immediately, suppresses overlapping ticks, then runs the next tick", async () => {
    const p = ports();
    let resolve!: (ids: string[]) => void;
    p.listCompanyIds.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    startKnowledgeExport(db, { env, ports: p });
    expect(p.listCompanyIds).toHaveBeenCalledTimes(1);
    expect(p.listCompanyIds).toHaveBeenCalledWith(db);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(3 * hour);
    expect(p.listCompanyIds).toHaveBeenCalledTimes(1);
    resolve([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(p.listCompanyIds).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(hour);
    expect(p.listCompanyIds).toHaveBeenCalledTimes(2);
    expect(p.exportCompany).not.toHaveBeenCalled();
    expect(p.publish).not.toHaveBeenCalled();
    expect(p.log.error).not.toHaveBeenCalled();
  });

  it("stops idempotently and replaces the previous timer on restart", async () => {
    const first = ports();
    const second = ports();
    const oldStop = startKnowledgeExport(db, { env, ports: first });
    await vi.advanceTimersByTimeAsync(0);
    expect(first.listCompanyIds).toHaveBeenCalledTimes(1);
    const newStop = startKnowledgeExport(db, { env, ports: second });
    expect(second.listCompanyIds).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    oldStop();
    await vi.advanceTimersByTimeAsync(hour);
    expect(first.listCompanyIds).toHaveBeenCalledTimes(1);
    expect(second.listCompanyIds).toHaveBeenCalledTimes(2);
    newStop();
    newStop();
    stopKnowledgeExport();
    stopKnowledgeExport();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(3 * hour);
    expect(first.listCompanyIds).toHaveBeenCalledTimes(1);
    expect(second.listCompanyIds).toHaveBeenCalledTimes(2);
  });

  it("logs a rejected pass and permits the next tick", async () => {
    const p = ports();
    p.listCompanyIds.mockRejectedValueOnce(new Error("list failed"));
    startKnowledgeExport(db, { env, ports: p });
    expect(p.listCompanyIds).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(p.log.error).toHaveBeenCalledTimes(1);
    expect(p.log.error).toHaveBeenCalledWith({ error: "list failed" }, "knowledge export tick failed");
    expect(p.exportCompany).not.toHaveBeenCalled();
    expect(p.publish).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(hour);
    expect(p.listCompanyIds).toHaveBeenCalledTimes(2);
    expect(p.log.error).toHaveBeenCalledTimes(1);
  });
});
