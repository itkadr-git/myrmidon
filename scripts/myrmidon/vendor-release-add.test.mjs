import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseMigrationSql } from "./vendor-release-add.mjs";

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
