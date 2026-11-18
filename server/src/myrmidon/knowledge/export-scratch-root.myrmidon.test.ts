import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serializeKnowledgeTree } from "./domain.js";
import { runKnowledgeExportPass } from "./git-export-job.js";

const settings = { enabled: true, repoUrl: "https://example.test/repo.git", branch: "export", intervalHours: 24 };
const log = { info() {}, warn() {}, error() {} };
afterEach(() => vi.restoreAllMocks());

async function exercise(env: NodeJS.ProcessEnv, expectedRoot: string) {
  let workDir = "";
  const result = await runKnowledgeExportPass({} as never, {
    settings, env,
    ports: {
      log,
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
  expect(result).toMatchObject({ companies: 1, failed: 0, unchanged: 1 });
  expect(workDir).not.toBe("");
  expect(path.dirname(workDir)).toBe(expectedRoot);
  expect(workDir.startsWith("/tmp/")).toBe(false);
  await expect(access(workDir)).rejects.toThrow();
}

describe("knowledge export scratch root", () => {
  it("prefers run scratch over shared scratch and honors canonical aliases", async () => {
    const base = await mkdtemp(path.join(os.homedir(), "knowledge-scratch-test-"));
    try {
      const run = path.join(base, "run");
      await mkdir(run);
      vi.spyOn(os, "tmpdir").mockReturnValue(base);
      await exercise({ MYRMIDON_RUN_SCRATCH_DIR: run, PAPERCLIP_RUN_SCRATCH_DIR: path.join(base, "legacy"), PAPERCLIP_SCRATCH_DIR: path.join(base, "shared") }, run);
    } finally { await rm(base, { recursive: true, force: true }); }
  });

  it("uses the legacy shared scratch when run scratch is absent", async () => {
    const base = await mkdtemp(path.join(os.homedir(), "knowledge-scratch-test-"));
    try { await exercise({ PAPERCLIP_SCRATCH_DIR: base }, base); }
    finally { await rm(base, { recursive: true, force: true }); }
  });

  it("falls back to profile home even when system tmpdir is /tmp", async () => {
    const base = await mkdtemp(path.join(os.homedir(), "knowledge-scratch-test-"));
    try {
      vi.spyOn(os, "homedir").mockReturnValue(base);
      vi.spyOn(os, "tmpdir").mockReturnValue("/tmp");
      await exercise({}, base);
    } finally { await rm(base, { recursive: true, force: true }); }
  });

  it("creates a missing run scratch root", async () => {
    const base = await mkdtemp(path.join(os.homedir(), "knowledge-scratch-test-"));
    try { await exercise({ PAPERCLIP_RUN_SCRATCH_DIR: path.join(base, "new", "run") }, path.join(base, "new", "run")); }
    finally { await rm(base, { recursive: true, force: true }); }
  });

  it("fails explicitly without publishing or falling back when the root is inaccessible", async () => {
    const base = await mkdtemp(path.join(os.homedir(), "knowledge-scratch-test-"));
    try {
      const file = path.join(base, "not-a-directory");
      await writeFile(file, "fixture");
      vi.spyOn(os, "tmpdir").mockReturnValue("/tmp");
      const publish = vi.fn();
      const exportCompany = vi.fn();
      const warn = vi.fn();
      await expect(runKnowledgeExportPass({} as never, {
        settings, env: { MYRMIDON_RUN_SCRATCH_DIR: path.join(file, "child"), MYRMIDON_SCRATCH_DIR: base },
        ports: { log: { ...log, warn }, listCompanyIds: async () => ["c1"], exportCompany, publish },
      })).resolves.toEqual({ enabled: true, companies: 1, committed: 0, unchanged: 0, failed: 1 });
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ companyId: "c1", error: expect.any(String) }), "knowledge export failed for one company");
      expect(exportCompany).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    } finally { await rm(base, { recursive: true, force: true }); }
  });
});
