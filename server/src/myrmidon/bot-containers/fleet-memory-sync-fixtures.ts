// server/src/myrmidon/bot-containers/fleet-memory-sync-fixtures.ts
//
// myrmidon(1.6.6 C-MEM): test doubles of the memory sync: an in-memory journal with the same
// contract as the Drizzle store, and a replica bank that, like hindsight's merge import with
// document_conflict=skip, keeps one document per document id.

import { randomUUID } from "node:crypto";
import type { FleetMemorySyncRecord, FleetMemorySyncStore } from "./fleet-memory-sync-store.js";

export function memoryJournal(): FleetMemorySyncStore & { rows: FleetMemorySyncRecord[] } {
  const rows: FleetMemorySyncRecord[] = [];
  return {
    rows,
    async begin(params) {
      const now = params.now ?? new Date();
      for (const row of rows) {
        if (
          row.status === "running" &&
          row.companyId === params.companyId &&
          row.siteName === params.siteName &&
          row.startedAt.getTime() < now.getTime() - params.staleAfterMs
        ) {
          row.status = "failed";
          row.error = "abandoned: the board process stopped before the sync finished";
          row.finishedAt = now;
        }
      }
      if (rows.some((r) => r.status === "running" && r.companyId === params.companyId && r.siteName === params.siteName)) return null;
      const row: FleetMemorySyncRecord = {
        id: randomUUID(),
        companyId: params.companyId,
        siteName: params.siteName,
        kind: params.kind,
        status: "running",
        targetBank: params.targetBank,
        botKey: params.botKey ?? null,
        moveId: params.moveId ?? null,
        archiveBytes: null,
        documentsImported: null,
        documentsSkipped: null,
        error: null,
        startedAt: now,
        finishedAt: null,
      };
      rows.push(row);
      return { ...row };
    },
    async finish(id, result, now = new Date()) {
      const row = rows.find((r) => r.id === id && r.status === "running");
      if (!row) return;
      row.status = result.status;
      row.archiveBytes = result.archiveBytes ?? null;
      row.documentsImported = result.documentsImported ?? null;
      row.documentsSkipped = result.documentsSkipped ?? null;
      row.error = result.error ?? null;
      row.finishedAt = now;
    },
    async lastOkAt(companyId, siteName) {
      const ok = rows.filter((r) => r.status === "ok" && r.companyId === companyId && r.siteName === siteName && r.finishedAt);
      return ok.length ? new Date(Math.max(...ok.map((r) => r.finishedAt!.getTime()))) : null;
    },
    async list(companyId, opts = {}) {
      return rows
        .filter((r) => r.companyId === companyId && (!opts.siteName || r.siteName === opts.siteName))
        .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
        .slice(0, opts.limit ?? 50)
        .map((r) => ({ ...r }));
    },
  };
}

/** An archive of documents: `{ "doc-1": "text" }` as JSON bytes (the fixtures never open a zip). */
export function archiveOf(documents: Record<string, string>): Buffer {
  return Buffer.from(JSON.stringify(documents));
}

/** The replica bank: merge-import with skip on a known document id. */
export function replicaBank() {
  const documents = new Map<string, string>();
  return {
    documents,
    async importArchive(_bank: string, archive: Buffer): Promise<{ imported: number; skipped: number }> {
      const incoming = JSON.parse(archive.toString("utf8")) as Record<string, string>;
      let imported = 0;
      let skipped = 0;
      for (const [id, text] of Object.entries(incoming)) {
        if (documents.has(id)) skipped += 1;
        else {
          documents.set(id, text);
          imported += 1;
        }
      }
      return { imported, skipped };
    },
  };
}
