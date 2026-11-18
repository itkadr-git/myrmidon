import { access, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serializeKnowledgeTree, type KnowledgeTreePage } from "./domain.js";
import { runKnowledgeExportPass, type KnowledgeExportPorts } from "./git-export-job.js";

const observed = vi.hoisted(() => ({ dirs: [] as string[], root: "" }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    mkdtemp: async () => {
      const dir = await fs.mkdtemp(path.join(observed.root, "checkout-"));
      observed.dirs.push(dir);
      return dir;
    },
  };
});

const settings = { enabled: true, repoUrl: "https://example.test/export.git", branch: "export", intervalHours: 24 };
const ids = ["company-alpha", "company-bravo", "company-charlie"];
const fixtures = ids.map((id) => ({
  slug: `ops/${id}`, title: `Title ${id}`, content: `Content ${id}\n`,
}));
const log = { info() {}, warn() {}, error() {} };

function buffer(index: number): Buffer {
  const item = fixtures[index];
  const page: KnowledgeTreePage = {
    ...item, summary: null, kind: "wiki", folder: "ops", tags: [], roles: [],
    status: "published", approvalRequired: false, approverKind: null,
  };
  return serializeKnowledgeTree({ nestId: ids[index], pages: [page] });
}

async function exists(dir: string): Promise<boolean> {
  return access(dir).then(() => true, () => false);
}

afterEach(async () => {
  if (observed.root) await rm(observed.root, { recursive: true, force: true });
  observed.root = "";
  observed.dirs = [];
});

describe("knowledge export pass isolation", () => {
  it.each(["export", "parse", "publish"] as const)("isolates a company after %s failure, including a repeated pass", async (failure) => {
    const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.HOME;
    if (!scratch) throw new Error("scratch directory is required");
    const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    observed.root = await fs.mkdtemp(path.join(scratch, "export-pass-test-"));
    const publications: Array<{ id: string; prefix: string; text: string; dir: string; exists: boolean }> = [];
    const exports: Array<{ id: string; dir: string; exists: boolean }> = [];
    const ports = {
      listCompanyIds: async () => ids,
      exportCompany: async (_db: unknown, id: string) => {
        const dir = observed.dirs[observed.dirs.length - 1];
        exports.push({ id, dir, exists: await exists(dir) });
        if (id === ids[1] && failure === "export") throw new Error("export failure");
        if (id === ids[1] && failure === "parse") return Buffer.from("not a knowledge tree");
        return buffer(ids.indexOf(id));
      },
      publish: async (input: Parameters<KnowledgeExportPorts["publish"]>[0]) => {
        publications.push({ id: input.companyId, prefix: input.pathPrefix, text: JSON.stringify(input.tree.files), dir: input.workDir, exists: await exists(input.workDir) });
        if (input.companyId === ids[1] && failure === "publish") throw new Error("publish failure");
        return { committed: input.companyId === ids[0], commit: input.companyId === ids[0] ? "abc" : null, contentHash: input.tree.contentHash, pageCount: input.tree.pageCount };
      },
      log,
    };
    for (let pass = 0; pass < 2; pass++) {
      const result = await runKnowledgeExportPass({} as never, { settings, ports });
      expect(result).toEqual({ enabled: true, companies: 3, committed: 1, unchanged: 1, failed: 1 });
      const passExports = exports.slice(pass * 3, pass * 3 + 3);
      expect(passExports.map((entry) => entry.id)).toEqual(ids);
      expect(passExports.every((entry) => entry.exists)).toBe(true);
      expect(new Set(passExports.map((entry) => entry.dir)).size).toBe(3);
      expect(await Promise.all(passExports.map((entry) => exists(entry.dir)))).toEqual([false, false, false]);
      const count = failure === "publish" ? 3 : 2;
      const calls = publications.slice(pass * count, (pass + 1) * count);
      expect(calls.map((entry) => entry.id)).toEqual(failure === "publish" ? ids : [ids[0], ids[2]]);
      expect(calls.every((entry) => entry.exists && entry.dir === passExports[ids.indexOf(entry.id)].dir)).toBe(true);
      const c = calls[calls.length - 1];
      expect(c.prefix).toBe(ids[2]);
      expect(c.text).toContain(fixtures[2].slug);
      expect(c.text).toContain(fixtures[2].title);
      expect(c.text).toContain(fixtures[2].content.trim());
      for (const other of fixtures.slice(0, 2)) {
        expect(c.text).not.toContain(other.slug);
        expect(c.text).not.toContain(other.title);
        expect(c.text).not.toContain(other.content.trim());
        expect(c.prefix).not.toContain(other.slug);
      }
    }
    expect(new Set(observed.dirs).size).toBe(6);
  });

  it("propagates listCompanyIds rejection", async () => {
    const error = new Error("listing failed");
    await expect(runKnowledgeExportPass({} as never, { settings, ports: { listCompanyIds: async () => { throw error; } } })).rejects.toBe(error);
  });
});
