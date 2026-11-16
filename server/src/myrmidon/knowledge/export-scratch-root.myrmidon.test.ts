import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serializeKnowledgeTree } from "./domain.js";
import { runKnowledgeExportPass } from "./git-export-job.js";

const settings = { enabled: true, repoUrl: "https://example.test/repo.git", branch: "export", intervalHours: 24 };

afterEach(() => vi.restoreAllMocks());

describe("knowledge export scratch root", () => {
  it("prefers run scratch over shared scratch", async () => {
    const base = await mkdtemp(path.join(os.homedir(), "knowledge-scratch-test-"));
    try {
      const run = path.join(base, "run");
      const shared = path.join(base, "shared");
      await mkdir(run);
      vi.spyOn(os, "tmpdir").mockReturnValue(base);
      let workDir = "";
      const result = await runKnowledgeExportPass({} as never, {
        settings,
        env: { PAPERCLIP_RUN_SCRATCH_DIR: run, PAPERCLIP_SCRATCH_DIR: shared },
        ports: {
          listCompanyIds: async () => ["c1"],
          exportCompany: async () => serializeKnowledgeTree({ nestId: "nest", pages: [] }),
          publish: async (input) => {
            workDir = input.workDir;
            await writeFile(path.join(workDir, "fixture"), "fixture");
            await access(path.join(workDir, "fixture"));
            return { committed: false, commit: null, contentHash: input.tree.contentHash, pageCount: 0 };
          },
        },
      });
      expect(result.failed).toBe(0);
      expect(path.dirname(workDir)).toBe(run);
      await expect(access(workDir)).rejects.toThrow();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
