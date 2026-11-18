import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseMigrationSql, sanitizeMigrationColumns } from "./vendor-release-add.mjs";

describe("vendor migration SQL set contract", () => {
  it("deduplicates repeated CREATE, ADD, and RENAME statements", () => {
    const sql = [
      'CREATE TABLE "audit_events" ("id" uuid);',
      'CREATE TABLE "audit_events" ("id" uuid);',
      'ALTER TABLE "audit_events" ADD COLUMN "source" text;',
      'ALTER TABLE "audit_events" ADD COLUMN "source" text;',
      'ALTER TABLE "audit_events" RENAME COLUMN "old_source" TO "source";',
      'ALTER TABLE "audit_events" RENAME COLUMN "old_source" TO "source";',
    ].join("\n--> statement-breakpoint\n");

    assert.deepEqual(parseMigrationSql(sql), {
      tables: ["audit_events"],
      columns: ["audit_events.source"],
    });
  });

  it("returns sorted sets regardless of DDL and breakpoint order", () => {
    const statements = [
      'ALTER TABLE "zebra" ADD COLUMN "z_col" text;',
      'CREATE TABLE "middle" ("id" uuid);',
      'ALTER TABLE "alpha" RENAME COLUMN "old_name" TO "new_name";',
      'CREATE TABLE "zebra" ("id" uuid);',
      'ALTER TABLE "middle" ADD COLUMN "m_col" text;',
    ];
    const reordered = [statements[4], statements[2], statements[0], statements[3], statements[1]];
    const join = (items) => items.join("\n--> statement-breakpoint\n");
    const expected = {
      tables: ["middle", "zebra"],
      columns: ["alpha.new_name", "middle.m_col", "zebra.z_col"],
    };

    assert.deepEqual(parseMigrationSql(join(statements)), expected);
    assert.deepEqual(parseMigrationSql(join(reordered)), expected);
  });

  it("accepts quoted and unquoted public-qualified table names", () => {
    const sql = [
      'CREATE TABLE public.unquoted_table ("id" uuid);',
      'CREATE TABLE "public"."quoted_table" ("id" uuid);',
      'ALTER TABLE public.unquoted_table ADD COLUMN "unquoted_column" text;',
      'ALTER TABLE "public"."quoted_table" RENAME COLUMN "before" TO "after";',
    ].join("\n--> statement-breakpoint\n");

    assert.deepEqual(parseMigrationSql(sql), {
      tables: ["quoted_table", "unquoted_table"],
      columns: ["quoted_table.after", "unquoted_table.unquoted_column"],
    });
  });

  it("accepts ALTER ONLY, IF EXISTS, and ADD IF NOT EXISTS", () => {
    const sql = [
      'ALTER TABLE ONLY IF EXISTS public.accounts ADD COLUMN IF NOT EXISTS "region_code" text;',
      'ALTER TABLE ONLY IF EXISTS "public"."accounts" ADD COLUMN IF NOT EXISTS "timezone" text;',
    ].join("\n--> statement-breakpoint\n");

    assert.deepEqual(parseMigrationSql(sql), {
      tables: [],
      columns: ["accounts.region_code", "accounts.timezone"],
    });
  });

  it("collects every ADD and RENAME in one ALTER statement", () => {
    const sql = 'ALTER TABLE "profiles" ADD COLUMN "locale" text, ADD COLUMN IF NOT EXISTS "timezone" text, RENAME COLUMN "name" TO "display_name";';

    assert.deepEqual(parseMigrationSql(sql), {
      tables: [],
      columns: ["profiles.display_name", "profiles.locale", "profiles.timezone"],
    });
  });

  it("keeps empty and non-schema controls empty", () => {
    for (const sql of [
      "",
      "UPDATE profiles SET display_name = 'changed';",
      'ALTER TABLE "profiles" DROP COLUMN "obsolete";',
      'ALTER TABLE "profiles" ALTER COLUMN "display_name" SET NOT NULL;',
    ]) {
      assert.deepEqual(parseMigrationSql(sql), { tables: [], columns: [] }, sql || "empty SQL");
    }
  });

  it("does not treat similar names or other schemas as preserved columns", () => {
    const sql = [
      'ALTER TABLE "agents" ADD COLUMN "appearance_extra" text;',
      'ALTER TABLE "other" ADD COLUMN "appearance" text;',
      'ALTER TABLE "issues" ADD COLUMN "title_needs_generation_extra" boolean;',
    ].join("\n--> statement-breakpoint\n");

    const parsed = parseMigrationSql(sql);
    assert.deepEqual(sanitizeMigrationColumns(parsed.columns), [
      "agents.appearance_extra",
      "issues.title_needs_generation_extra",
      "other.appearance",
    ]);
  });

  it("removes exactly the two preserved columns after parsing", () => {
    const sql = [
      'ALTER TABLE "agents" ADD COLUMN "appearance" jsonb;',
      'ALTER TABLE "agents" ADD COLUMN "appearance_extra" text;',
      'ALTER TABLE "issues" ADD COLUMN "title_needs_generation" boolean;',
      'ALTER TABLE "other" ADD COLUMN "appearance" text;',
      'ALTER TABLE "jobs" ADD COLUMN "status" text;',
    ].join("\n--> statement-breakpoint\n");
    const parsed = parseMigrationSql(sql);

    assert.deepEqual(sanitizeMigrationColumns(parsed.columns), [
      "agents.appearance_extra",
      "jobs.status",
      "other.appearance",
    ]);
  });

  it("does not mutate frozen input and returns an independent sanitized array", () => {
    const columns = Object.freeze([
      "agents.appearance",
      "issues.title_needs_generation",
      "jobs.status",
      "jobs.status",
    ]);
    const sanitized = sanitizeMigrationColumns(columns);

    assert.deepEqual(sanitized, ["jobs.status", "jobs.status"]);
    assert.notStrictEqual(sanitized, columns);
    sanitized.push("jobs.priority");
    assert.deepEqual(columns, [
      "agents.appearance",
      "issues.title_needs_generation",
      "jobs.status",
      "jobs.status",
    ]);
  });
});
