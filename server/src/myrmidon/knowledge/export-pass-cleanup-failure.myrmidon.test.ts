import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { serializeKnowledgeTree, type KnowledgeTreePage } from "./domain.js";
import { runKnowledgeExportPass, type KnowledgeExportPorts } from "./git-export-job.js";

const fault = vi.hoisted(() => ({ workDir: "", attempts: [] as string[], events: [] as string[] }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      const target = String(args[0]);
      fault.attempts.push(target);
      fault.events.push(`cleanup:${target}`);
      if (target === fault.workDir) throw Object.assign(new Error("cleanup denied"), { code: "EACCES" });
      return actual.rm(...args);
    },
  };
});

const ids = ["company-alpha", "company-bravo"];
const settings = { enabled: true, repoUrl: "https://example.invalid/export.git", branch: "export", intervalHours: 24 };
const log = { info() {}, warn() {}, error() {} };

function exportBuffer(id: string): Buffer {
  const page: KnowledgeTreePage = {
    slug: `ops/${id}`, title: `Title ${id}`, content: `Content ${id}\n`, summary: null,
    kind: "wiki", folder: "ops", tags: [], roles: [], status: "published",
    approvalRequired: false, approverKind: null,
  };
  return serializeKnowledgeTree({ nestId: id, pages: [page] });
}

describe("knowledge export pass cleanup failure", () => {
  it.each([false, true])("continues after cleanup fails (publish failure: %s)", async (publishFails) => {
    const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const scratch = process.env.MYRMIDON_RUN_SCRATCH_DIR || process.env.MYRMIDON_SCRATCH_DIR || process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.HOME;
    if (!scratch) throw new Error("No permitted scratch directory");
    const root = await fs.mkdtemp(path.join(scratch, "export-cleanup-test-"));
    const publications: Array<{ id: string; dir: string; prefix: string; files: string }> = [];
    try {
      const ports = {
        listCompanyIds: async () => ids,
        exportCompany: async (_db: unknown, id: string) => exportBuffer(id),
        publish: async (input: Parameters<KnowledgeExportPorts["publish"]>[0]) => {
          publications.push({ id: input.companyId, dir: input.workDir, prefix: input.pathPrefix, files: JSON.stringify(input.tree.files) });
          fault.events.push(`publish:${input.companyId}`);
          if (input.companyId === ids[0]) {
            fault.workDir = input.workDir;
            if (publishFails) throw new Error("publish failed");
          }
          return { committed: input.companyId === ids[0], commit: input.companyId === ids[0] ? "abc" : null, contentHash: input.tree.contentHash, pageCount: input.tree.pageCount };
        },
        log,
      };
      const result = await runKnowledgeExportPass({} as never, { settings, env: { MYRMIDON_RUN_SCRATCH_DIR: root }, ports });
      expect(result).toEqual({ enabled: true, companies: 2, committed: publishFails ? 0 : 1, unchanged: 1, failed: publishFails ? 1 : 0 });
      expect(publications.map((entry) => entry.id)).toEqual(ids);
      const [a, b] = publications;
      expect(a.dir).not.toBe(b.dir);
      expect(fault.attempts).toEqual([a.dir, b.dir]);
      expect(fault.events).toEqual([`publish:${ids[0]}`, `cleanup:${a.dir}`, `publish:${ids[1]}`, `cleanup:${b.dir}`]);
      expect(b.prefix).toBe(ids[1]);
      expect(b.files).toContain(`Content ${ids[1]}`);
      expect(b.files).not.toContain(`Content ${ids[0]}`);
      await expect(fs.access(a.dir)).resolves.toBeUndefined();
      await expect(fs.access(b.dir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      fault.workDir = "";
      fault.attempts = [];
      fault.events = [];
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
