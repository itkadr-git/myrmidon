import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatUnsupportedRelease, isStableReleaseTag, parseMigrationSql, selectLatestStableRelease } from "./vendor-release-add.mjs";

describe("latest stable Paperclip release", () => {
  it("ignores prerelease tags and selects the newest published stable release", () => {
    const releases = [
      { tag_name: "v2026.1012.0", published_at: "2026-10-12T00:00:00Z", prerelease: false, draft: false },
      { tag_name: "nightly/2026-10-13", published_at: "2026-10-13T00:00:00Z", prerelease: false, draft: false },
      { tag_name: "v2026.1013.0-beta", published_at: "2026-10-14T00:00:00Z", prerelease: true, draft: false },
      { tag_name: "v2026.1005.0", published_at: "2026-10-05T00:00:00Z", prerelease: false, draft: false },
    ];
    assert.equal(isStableReleaseTag("v2026.1012.0"), true);
    assert.equal(isStableReleaseTag("v2026.1013.0-beta"), false);
    assert.equal(selectLatestStableRelease(releases).tag_name, "v2026.1012.0");
  });

  it("reports the unsupported tag and migration bounds", () => {
    const message = formatUnsupportedRelease("v2026.1013.0", 317, "0318_new_migration");
    assert.match(message, /v2026\.1013\.0/);
    assert.match(message, /Release migrations: 317/);
    assert.match(message, /Last migration: 0318_new_migration/);
  });
});

describe("vendor-release-add parseMigrationSql", () => {
  it("finds created tables and added columns, one ALTER per statement", () => {
    const sql = [
      'CREATE TABLE "browser_use_runs" (\n\t"id" uuid PRIMARY KEY NOT NULL\n);',
      'CREATE TABLE IF NOT EXISTS "public"."chat_task_handoffs" ("id" uuid);',
      'ALTER TABLE "agents" ADD COLUMN "appearance" jsonb;',
      'ALTER TABLE "routine_triggers" ADD COLUMN IF NOT EXISTS "archived" boolean DEFAULT false NOT NULL;',
      'ALTER TABLE "browser_use_runs" ADD COLUMN "a" text, ADD COLUMN "b" text;',
      'ALTER TABLE "user" DROP COLUMN IF EXISTS "keyboard_shortcuts";',
      'ALTER TABLE "assets" ALTER COLUMN "byte_size" SET DATA TYPE bigint;',
      'UPDATE agents SET appearance = jsonb_build_object(\'x\', 1);',
    ].join("\n--> statement-breakpoint\n");
    assert.deepEqual(parseMigrationSql(sql), {
      tables: ["browser_use_runs", "chat_task_handoffs"],
      columns: ["agents.appearance", "browser_use_runs.a", "browser_use_runs.b", "routine_triggers.archived"],
    });
  });

  it("does not mistake a column named like a keyword or a data update for a schema change", () => {
    const sql = 'UPDATE "tool_connections" SET "agent_instructions" = \'{"enabled": true}\';';
    assert.deepEqual(parseMigrationSql(sql), { tables: [], columns: [] });
  });
});
