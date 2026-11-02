import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import {
  PRESERVED_MIGRATION_COLUMNS,
  formatUnsupportedRelease,
  isStableReleaseTag,
  parseMigrationSql,
  sanitizeMigrationColumns,
  selectLatestStableRelease,
} from "./vendor-release-add.mjs";

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

describe("vendor-release-add PR #1702 manual splice preservation (--regen)", () => {
  it("defines approved columns to preserve from PR #1702", () => {
    assert.ok(PRESERVED_MIGRATION_COLUMNS.has("agents.appearance"));
    assert.ok(PRESERVED_MIGRATION_COLUMNS.has("issues.title_needs_generation"));
  });

  it("sanitizes migration columns so --regen does not reintroduce approved columns", () => {
    const rawColumns = [
      "agents.appearance",
      "issues.title_needs_generation",
      "routine_triggers.archived",
      "browser_use_runs.recovery_cursor",
    ];
    const sanitized = sanitizeMigrationColumns(rawColumns);
    assert.deepEqual(sanitized, [
      "routine_triggers.archived",
      "browser_use_runs.recovery_cursor",
    ]);
  });

  it("filters PR #1702 columns from upstream ALTER statements during migration parsing", () => {
    const sql0280 = 'ALTER TABLE "agents" ADD COLUMN "appearance" jsonb;\n--> statement-breakpoint\nALTER TABLE "agents" ADD COLUMN "other" text;';
    const parsed0280 = parseMigrationSql(sql0280);
    assert.deepEqual(sanitizeMigrationColumns(parsed0280.columns), ["agents.other"]);

    const sql0293 = 'ALTER TABLE "issues" ADD COLUMN "title_needs_generation" boolean DEFAULT false NOT NULL;';
    const parsed0293 = parseMigrationSql(sql0293);
    assert.deepEqual(sanitizeMigrationColumns(parsed0293.columns), []);
  });

  it("ensures cli/src/commands/myrmidon-migrate-vendor-releases.ts does not contain approved columns in any release", () => {
    const tsFile = path.resolve(import.meta.dirname, "../../cli/src/commands/myrmidon-migrate-vendor-releases.ts");
    const content = fs.readFileSync(tsFile, "utf8");
    const m = /export const VENDOR_EXTRA_RELEASES[^=]*= (\[[\s\S]*\]);\s*$/.exec(content);
    assert.ok(m, "VENDOR_EXTRA_RELEASES found in vendor-releases.ts");
    const releases = new Function(`return ${m[1]}`)();
    assert.ok(releases.length >= 4, "at least 4 releases exist");
    for (const r of releases) {
      for (const e of r.extra) {
        assert.ok(
          !e.columns.includes("agents.appearance"),
          `Release ${r.release} migration ${e.tag} must not have agents.appearance in columns`,
        );
        assert.ok(
          !e.columns.includes("issues.title_needs_generation"),
          `Release ${r.release} migration ${e.tag} must not have issues.title_needs_generation in columns`,
        );
      }
    }
  });
});

