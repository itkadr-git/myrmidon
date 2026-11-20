import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { serializeKnowledgeTree, type KnowledgeTreePage } from "./domain.js";
import { runKnowledgeExportPass, type KnowledgeExportPorts } from "./git-export-job.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const ids = ["company-alpha", "company-bravo", "company-charlie"];
const settings = { enabled: true, repoUrl: "https://example.invalid/export.git", branch: "export", intervalHours: 24 };
const log = { info() {}, warn() {}, error() {} };

function fixture(id: string): Buffer {
  const page: KnowledgeTreePage = {
    slug: `ops/${id}`, title: `Title ${id}`, content: `Content ${id}\n`,
    summary: null, kind: "wiki", folder: "ops", tags: [], roles: [],
    status: "published", approvalRequired: false, approverKind: null,
  };
  return serializeKnowledgeTree({ nestId: id, pages: [page] });
}

describe("knowledge export pass serial order", () => {
  it("waits for each company's export and publish before starting the next", async () => {
    const scratch = process.env.MYRMIDON_RUN_SCRATCH_DIR || process.env.MYRMIDON_SCRATCH_DIR || process.env.HOME;
    if (!scratch) throw new Error("No permitted scratch directory");
    const root = await mkdtemp(path.join(scratch, "knowledge-serial-"));
    const publishA = deferred<void>();
    const exportB = deferred<void>();
    const reachedPublishA = deferred<void>();
    const reachedExportB = deferred<void>();
    const events: string[] = [];
    const publications: Parameters<KnowledgeExportPorts["publish"]>[0][] = [];
    const ports: Partial<KnowledgeExportPorts> = {
      listCompanyIds: async () => ids,
      exportCompany: async (_db, id) => {
        events.push(`export:${id}`);
        if (id === ids[1]) {
          reachedExportB.resolve();
          await exportB.promise;
        }
        return fixture(id);
      },
      publish: async (input) => {
        events.push(`publish:${input.companyId}`);
        publications.push(input);
        await access(input.workDir);
        if (input.companyId === ids[0]) {
          reachedPublishA.resolve();
          await publishA.promise;
        }
        const committed = input.companyId !== ids[1];
        return { committed, commit: committed ? "abc" : null, contentHash: input.tree.contentHash, pageCount: input.tree.pageCount };
      },
      log,
    };
    const pass = runKnowledgeExportPass({} as never, { settings, ports, env: { MYRMIDON_RUN_SCRATCH_DIR: root } });
    try {
      await Promise.race([reachedPublishA.promise, pass.then(() => { throw new Error("pass finished before publishing A"); })]);
      // Allow concurrent filesystem work to run while the first publication is held.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(events).toEqual([`export:${ids[0]}`, `publish:${ids[0]}`]);
      publishA.resolve();
      await reachedExportB.promise;
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(events).toEqual([`export:${ids[0]}`, `publish:${ids[0]}`, `export:${ids[1]}`]);
      exportB.resolve();
      expect(await pass).toEqual({ enabled: true, companies: 3, committed: 2, unchanged: 1, failed: 0 });
      expect(events).toEqual(ids.flatMap((id) => [`export:${id}`, `publish:${id}`]));
      expect(publications.map((entry) => entry.pathPrefix)).toEqual(ids);
      expect(new Set(publications.map((entry) => entry.workDir)).size).toBe(3);
      for (const [index, entry] of publications.entries()) {
        expect(entry.companyId).toBe(ids[index]);
        expect(entry.tree.pageCount).toBe(1);
        const bytes = Buffer.from(JSON.stringify(entry.tree.files));
        expect(bytes.includes(Buffer.from(`Content ${ids[index]}`))).toBe(true);
        for (const other of ids.filter((id) => id !== ids[index])) {
          expect(bytes.includes(Buffer.from(`Content ${other}`))).toBe(false);
        }
        await expect(access(entry.workDir)).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect(await readdir(root)).toEqual([]);
    } finally {
      publishA.resolve();
      exportB.resolve();
      await pass;
      await rm(root, { recursive: true, force: true });
    }
  });
});
