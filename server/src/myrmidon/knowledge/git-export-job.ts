// server/src/myrmidon/knowledge/git-export-job.ts
//
// myrmidon(1.7 KNOWLEDGE-2.0 L-8): the nightly pass. One company at a time,
// each failure logged and skipped, a tick that is still running is not
// stacked. Off unless MYRMIDON_KNOWLEDGE_EXPORT_REPO is set — same switch
// shape as the baseline snapshot job.
//
// The life contour is removed before anything is written (I-7). The export
// reads the delivered tree through the knowledge module, so a draft that
// was never published does not leave the board.

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Db } from "@myrmidon/db";
import { companies } from "@myrmidon/db";
import { isNotNull } from "drizzle-orm";
import { logger } from "../../middleware/logger.js";
import { createKnowledgeModule } from "./service.js";
import { parseKnowledgeTree } from "./domain.js";
import { buildKnowledgeGitTree, readKnowledgeExportSettings, type KnowledgeExportSettings } from "./git-export.js";
import { errorMessage, publishKnowledgeExport, type PublishKnowledgeExportResult } from "./git-export-git.js";

export interface KnowledgeExportPorts {
  listCompanyIds(db: Db): Promise<string[]>;
  exportCompany(db: Db, companyId: string): Promise<Buffer>;
  publish(input: {
    companyId: string;
    repoUrl: string;
    branch: string;
    tree: ReturnType<typeof buildKnowledgeGitTree>;
    workDir: string;
    /** Directory of this company in the shared repository. */
    pathPrefix: string;
  }): Promise<PublishKnowledgeExportResult>;
  log: {
    info(fields: object, message: string): void;
    warn(fields: object, message: string): void;
    error(fields: object, message: string): void;
  };
}

export const defaultKnowledgeExportPorts: KnowledgeExportPorts = {
  async listCompanyIds(db) {
    const rows = await db.select({ id: companies.id }).from(companies).where(isNotNull(companies.id));
    return rows.map((row) => row.id);
  },
  async exportCompany(db, companyId) {
    const module = createKnowledgeModule(db, companyId);
    return module.exportTree();
  },
  async publish(input) {
    return publishKnowledgeExport({
      workDir: input.workDir,
      repoUrl: input.repoUrl,
      branch: input.branch,
      tree: input.tree,
      pathPrefix: input.pathPrefix,
    });
  },
  log: logger,
};

export interface KnowledgeExportPassResult {
  enabled: boolean;
  companies: number;
  committed: number;
  unchanged: number;
  failed: number;
}

/** One pass over every company. Disabled settings return immediately. */
export async function runKnowledgeExportPass(
  db: Db,
  opts: { env?: NodeJS.ProcessEnv; ports?: Partial<KnowledgeExportPorts>; settings?: KnowledgeExportSettings } = {},
): Promise<KnowledgeExportPassResult> {
  const settings = opts.settings ?? readKnowledgeExportSettings(opts.env ?? process.env);
  if (!settings.enabled || !settings.repoUrl) {
    return { enabled: false, companies: 0, committed: 0, unchanged: 0, failed: 0 };
  }
  const ports: KnowledgeExportPorts = { ...defaultKnowledgeExportPorts, ...opts.ports };
  const companyIds = await ports.listCompanyIds(db);
  let committed = 0;
  let unchanged = 0;
  let failed = 0;
  for (const companyId of companyIds) {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "knowledge-export-"));
    try {
      const buf = await ports.exportCompany(db, companyId);
      const doc = parseKnowledgeTree(buf);
      const tree = buildKnowledgeGitTree(doc);
      const result = await ports.publish({
        companyId,
        repoUrl: settings.repoUrl,
        branch: settings.branch,
        tree,
        workDir,
        pathPrefix: companyId,
      });
      if (result.committed) committed += 1;
      else unchanged += 1;
      ports.log.info(
        { companyId, committed: result.committed, pages: tree.pageCount, excludedLife: tree.excludedLifePages, hash: tree.contentHash.slice(0, 12) },
        "knowledge export pass",
      );
    } catch (err) {
      failed += 1;
      ports.log.warn({ error: errorMessage(err), companyId }, "knowledge export failed for one company");
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  return { enabled: true, companies: companyIds.length, committed, unchanged, failed };
}

let stopRunning: (() => void) | null = null;

/**
 * Starts the nightly export. Returns a stop function. A no-op (no timer)
 * when the repo URL is unset, so a board that has not opted in does nothing.
 */
export function startKnowledgeExport(
  db: Db,
  opts: { env?: NodeJS.ProcessEnv; ports?: Partial<KnowledgeExportPorts> } = {},
): () => void {
  const env = opts.env ?? process.env;
  const settings = readKnowledgeExportSettings(env);
  if (!settings.enabled) return () => {};
  stopKnowledgeExport();

  let running = false;
  let stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await runKnowledgeExportPass(db, { env, ports: opts.ports });
    } catch (err) {
      (opts.ports?.log ?? logger).error({ error: errorMessage(err) }, "knowledge export tick failed");
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, settings.intervalHours * 60 * 60 * 1000);
  if (typeof timer.unref === "function") timer.unref();
  void tick();

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    if (stopRunning === stop) stopRunning = null;
  };
  stopRunning = stop;
  return stop;
}

/** Stops the job started by `startKnowledgeExport`. A no-op when none runs. */
export function stopKnowledgeExport(): void {
  stopRunning?.();
}
