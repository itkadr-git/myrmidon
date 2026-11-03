import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("DBC-2 heartbeat run indexes", () => {
  it("declares the database indexes and preserves the coalesce migration predecessor", async () => {
    const source = await readFile(new URL("./schema/heartbeat_runs.ts", import.meta.url), "utf8");
    expect(source).toContain('index("heartbeat_runs_company_issue_coalesce_created_idx")');
    expect(source).toContain('index("heartbeat_runs_company_ctx_paperclip_issue_created_idx")');

    const journal = JSON.parse(await readFile(new URL("./migrations/meta/_journal.json", import.meta.url), "utf8"));
    const coalesceIndex = journal.entries.findIndex((entry: { tag: string }) => entry.tag === "0302_heartbeat_runs_company_issue_coalesce_created_index");
    expect(coalesceIndex).toBeGreaterThan(0);
    expect(journal.entries[coalesceIndex - 1].tag).toBe("0301_heartbeat_run_ownership_index");

    const migrationIndex = journal.entries.findIndex((entry: { tag: string }) => entry.tag === "0451_db_care_heartbeat_runs_ctx_paperclip_issue_created");
    expect(migrationIndex).toBeGreaterThan(0);
    expect(journal.entries[migrationIndex - 1].tag).toBe("0447_project_development_process");

    const migration = await readFile(new URL("./migrations/0451_db_care_heartbeat_runs_ctx_paperclip_issue_created.sql", import.meta.url), "utf8");
    expect(migration).toContain('CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_ctx_paperclip_issue_created_idx"');
  });
});
