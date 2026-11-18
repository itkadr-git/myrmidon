import { access, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { serializeKnowledgeTree } from "./domain.js";
import { startKnowledgeExport, stopKnowledgeExport, type KnowledgeExportPorts } from "./git-export-job.js";

vi.mock("../monitoring/board-load/lanes.js", () => ({
  backgroundInterval: (work: () => void, intervalMs: number) => setInterval(work, intervalMs),
}));

const hour = 60 * 60 * 1000;
const immediate = setImmediate;
const exists = (dir: string) => access(dir).then(() => true, () => false);

async function until(predicate: () => Promise<boolean>) {
  for (let i = 0; i < 1000; i++) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => immediate(resolve));
  }
  throw new Error("Timed out waiting for export completion");
}

describe("knowledge export scheduler stop during publication", () => {
  it("finishes and cleans the in-flight pass without letting its old stop cancel the replacement", async () => {
    const scratch = process.env.MYRMIDON_RUN_SCRATCH_DIR || process.env.MYRMIDON_SCRATCH_DIR || process.env.HOME;
    if (!scratch) throw new Error("scratch directory is required");
    const root = await mkdtemp(path.join(scratch, "export-stop-inflight-"));
    const env = {
      MYRMIDON_RUN_SCRATCH_DIR: root,
      MYRMIDON_KNOWLEDGE_EXPORT_REPO: "https://example.test/export.git",
      MYRMIDON_KNOWLEDGE_EXPORT_INTERVAL_HOURS: "1",
    };
    const data = serializeKnowledgeTree({ nestId: "company-a", pages: [{
      slug: "ops/page", title: "A page", content: "Published content\n", summary: null,
      kind: "wiki", folder: "ops", tags: [], roles: [], status: "published",
      approvalRequired: false, approverKind: null,
    }] });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: (input: Parameters<KnowledgeExportPorts["publish"]>[0]) => void;
    const publication = new Promise<Parameters<KnowledgeExportPorts["publish"]>[0]>((resolve) => { entered = resolve; });
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const first = {
      listCompanyIds: vi.fn(async () => ["company-a"]),
      exportCompany: vi.fn(async () => data),
      publish: vi.fn(async (input: Parameters<KnowledgeExportPorts["publish"]>[0]) => {
        entered(input);
        await gate;
        return { committed: true, commit: "abc", contentHash: input.tree.contentHash, pageCount: input.tree.pageCount };
      }),
      log,
    };
    const second = { listCompanyIds: vi.fn(async () => []), log };
    vi.useFakeTimers();
    try {
      const oldStop = startKnowledgeExport({} as never, { env, ports: first });
      const input = await publication;
      expect(input.companyId).toBe("company-a");
      expect(JSON.stringify(input.tree.files)).toContain("Published content");
      expect(await exists(input.workDir)).toBe(true);
      stopKnowledgeExport();
      stopKnowledgeExport();
      await vi.advanceTimersByTimeAsync(3 * hour);
      expect(first.listCompanyIds).toHaveBeenCalledTimes(1);
      expect(first.publish).toHaveBeenCalledTimes(1);
      expect(await exists(input.workDir)).toBe(true);
      release();
      await until(async () => !(await exists(input.workDir)));
      expect(log.info).toHaveBeenCalledTimes(1);
      expect(log.warn).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(3 * hour);
      expect(first.listCompanyIds).toHaveBeenCalledTimes(1);
      startKnowledgeExport({} as never, { env, ports: second });
      expect(second.listCompanyIds).toHaveBeenCalledTimes(1);
      oldStop();
      await vi.advanceTimersByTimeAsync(hour);
      expect(second.listCompanyIds).toHaveBeenCalledTimes(2);
      expect(first.publish).toHaveBeenCalledTimes(1);
      expect(log.error).not.toHaveBeenCalled();
    } finally {
      release();
      stopKnowledgeExport();
      vi.useRealTimers();
      await rm(root, { recursive: true, force: true });
    }
  });
});
