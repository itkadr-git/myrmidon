import { readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serializeKnowledgeTree, type KnowledgeTreePage } from "./domain.js";
import { runKnowledgeExportPass, type KnowledgeExportPorts } from "./git-export-job.js";

const state = vi.hoisted(() => ({ operation: "" as string, calls: 0, enabled: true }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    mkdir: async (...args: Parameters<typeof fs.mkdir>) => {
      if (state.operation === "mkdir" && state.enabled && ++state.calls === 2) throw new Error("scratch mkdir failed");
      return fs.mkdir(...args);
    },
    mkdtemp: async (...args: Parameters<typeof fs.mkdtemp>) => {
      if (state.operation === "mkdtemp" && state.enabled && ++state.calls === 2) throw new Error("scratch mkdtemp failed");
      return fs.mkdtemp(...args);
    },
  };
});

const settings = { enabled: true, repoUrl: "https://example.test/export.git", branch: "export", intervalHours: 24 };
const ids = ["company-alpha", "company-bravo", "company-charlie"];
let root = "";
afterEach(async () => {
  state.enabled = false;
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
});

describe("scratch creation isolation", () => {
  it.each(["mkdir", "mkdtemp"])("isolates %s failure and succeeds on retry", async (operation) => {
    const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.HOME;
    if (!scratch) throw new Error("scratch directory is required");
    root = await fs.mkdtemp(path.join(scratch, "export-scratch-test-"));
    const sentinel = path.join(root, "sentinel");
    await writeFile(sentinel, "foreign bytes");
    const exports: string[] = [];
    const publications: Array<{ id: string; text: string }> = [];
    const warn = vi.fn();
    const ports: Partial<KnowledgeExportPorts> = {
      listCompanyIds: async () => ids,
      exportCompany: async (_db, id) => {
        exports.push(id);
        const page: KnowledgeTreePage = { slug: `ops/${id}`, title: `Title ${id}`, content: `Content ${id}\n`, summary: null, kind: "wiki", folder: "ops", tags: [], roles: [], status: "published", approvalRequired: false, approverKind: null };
        return serializeKnowledgeTree({ nestId: id, pages: [page] });
      },
      publish: async (input) => {
        publications.push({ id: input.companyId, text: JSON.stringify(input.tree.files) });
        return { committed: input.companyId !== ids[2], commit: input.companyId !== ids[2] ? "abc" : null, contentHash: input.tree.contentHash, pageCount: input.tree.pageCount };
      },
      log: { info() {}, warn, error() {} },
    };
    state.operation = operation;
    state.calls = 0;
    state.enabled = true;
    const opts = { settings, ports, env: { PAPERCLIP_RUN_SCRATCH_DIR: root } };
    expect(await runKnowledgeExportPass({} as never, opts)).toEqual({ enabled: true, companies: 3, committed: 1, unchanged: 1, failed: 1 });
    expect(exports).toEqual([ids[0], ids[2]]);
    expect(publications.map((p) => p.id)).toEqual([ids[0], ids[2]]);
    for (const publication of publications) expect(publication.text).toContain(`Content ${publication.id}`);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ companyId: ids[1] }), expect.any(String));
    expect(await readFile(sentinel, "utf8")).toBe("foreign bytes");
    state.enabled = false;
    exports.length = 0;
    publications.length = 0;
    expect(await runKnowledgeExportPass({} as never, opts)).toEqual({ enabled: true, companies: 3, committed: 2, unchanged: 1, failed: 0 });
    expect(exports).toEqual(ids);
    expect(publications.map((p) => p.id)).toEqual(ids);
    for (const publication of publications) expect(publication.text).toContain(`Content ${publication.id}`);
    expect(await readFile(sentinel, "utf8")).toBe("foreign bytes");
  });

  it("propagates company listing errors", async () => {
    const error = new Error("listing failed");
    await expect(runKnowledgeExportPass({} as never, { settings, ports: { listCompanyIds: async () => { throw error; } } })).rejects.toBe(error);
  });
});
