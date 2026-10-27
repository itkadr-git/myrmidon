// Pins the production coalesce declaration and the journal/snapshot chain.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const COALESCE_INDEX_NAME = "heartbeat_runs_company_issue_coalesce_created_idx";
const PAPERCLIP_INDEX_NAME = "heartbeat_runs_company_ctx_paperclip_issue_created_idx";
const MIGRATION_TAG = "0421_db_care_heartbeat_runs_ctx_paperclip_issue_created";
const SNAPSHOT_FILE = "./migrations/meta/0421_snapshot.json";
const PREVIOUS_SNAPSHOT_FILE = "./migrations/meta/0420_snapshot.json";

describe("DB-CARE index declarations", () => {
  it("keeps declarations and migration predecessor chains in sync", async () => {
    const read = (path: string) => readFile(fileURLToPath(new URL(path, import.meta.url)), "utf8");
    const schema = await read("./schema/heartbeat_runs.ts");
    const originalMigration = await read("./migrations/0302_heartbeat_runs_company_issue_coalesce_created_index.sql");
    const migration = await read("./migrations/0421_db_care_heartbeat_runs_ctx_paperclip_issue_created.sql");
    const journal = JSON.parse(await read("./migrations/meta/_journal.json")) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const snapshot = JSON.parse(await read(SNAPSHOT_FILE)) as {
      prevId: string;
      tables: { "public.heartbeat_runs": { indexes: Record<string, unknown> } };
    };
    const previous = JSON.parse(await read(PREVIOUS_SNAPSHOT_FILE)) as { id: string };

    expect(schema).toContain(`index("${COALESCE_INDEX_NAME}")`);
    expect(schema).toContain(`index("${PAPERCLIP_INDEX_NAME}")`);
    expect(originalMigration).toContain(COALESCE_INDEX_NAME);
    expect(migration).toContain(`CREATE INDEX IF NOT EXISTS "${PAPERCLIP_INDEX_NAME}"`);

    const coalescePosition = journal.entries.findIndex(
      (entry) => entry.tag === "0302_heartbeat_runs_company_issue_coalesce_created_index",
    );
    expect(coalescePosition).toBeGreaterThan(0);
    expect(journal.entries[coalescePosition - 1]?.idx).toBe(301);
    expect(journal.entries[coalescePosition - 1]?.tag).toBe("0301_heartbeat_run_ownership_index");

    const lz4Position = journal.entries.findIndex((entry) => entry.tag === "0309_db_care_lz4_compression");
    expect(lz4Position).toBeGreaterThan(0);
    expect(journal.entries[lz4Position - 1]?.idx).toBe(308);
    expect(journal.entries[lz4Position - 1]?.tag).toBe("0308_db_care_audit_indexes");

    const currentPosition = journal.entries.findIndex((entry) => entry.tag === MIGRATION_TAG);
    expect(currentPosition).toBe(journal.entries.length - 1);
    expect(journal.entries[currentPosition]?.idx).toBe(422);
    expect(journal.entries[currentPosition - 1]?.tag).toBe("0420_issue_recovery_actions_dedupe_sla");
    expect(snapshot.prevId).toBe(previous.id);
    expect(snapshot.tables["public.heartbeat_runs"].indexes).toHaveProperty(COALESCE_INDEX_NAME);
    expect(snapshot.tables["public.heartbeat_runs"].indexes).toHaveProperty(PAPERCLIP_INDEX_NAME);
  });
});
