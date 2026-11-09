import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import {
  PRESERVED_MIGRATION_COLUMNS,
  checkCheckList,
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
  it("parses unquoted table and column names (0313_private_task_access pattern)", () => {
    const sql = [
      'ALTER TABLE projects ADD COLUMN IF NOT EXISTS privacy_owner_user_id text;',
      'CREATE TABLE custom_metrics ("id" uuid PRIMARY KEY);',
      'ALTER TABLE ONLY public.projects ADD COLUMN notes text;',
      'ALTER TABLE tasks RENAME COLUMN old_name TO new_name;',
    ].join("\n--> statement-breakpoint\n");
    assert.deepEqual(parseMigrationSql(sql), {
      tables: ["custom_metrics"],
      columns: [
        "projects.notes",
        "projects.privacy_owner_user_id",
        "tasks.new_name",
      ],
    });
  });

  it("does not mistake a column named like a keyword or a data update for a schema change", () => {
    const sql = 'UPDATE "tool_connections" SET "agent_instructions" = \'{"enabled": true}\';';
    assert.deepEqual(parseMigrationSql(sql), { tables: [], columns: [] });
  });
});

describe("vendor-release-add v2026.1106.0 registry entry (OPE-12237)", () => {
  it("carries the 41 migrations 0334..0374 with non-empty tables/columns", () => {
    const tsFile = path.resolve(import.meta.dirname, "../../cli/src/commands/myrmidon-migrate-vendor-releases.ts");
    const content = fs.readFileSync(tsFile, "utf8");
    const m = /export const VENDOR_EXTRA_RELEASES[^=]*= (\[[\s\S]*\]);\s*$/.exec(content);
    assert.ok(m, "VENDOR_EXTRA_RELEASES found in vendor-releases.ts");
    const releases = new Function(`return ${m[1]}`)();
    const r1106 = releases.find((r) => r.release === "v2026.1106.0");
    assert.ok(r1106, "v2026.1106.0 entry present");
    assert.equal(r1106.extra.length, 95, "1106 carries all 95 extras since idx 280");
    const last41 = r1106.extra.slice(-41);
    assert.equal(last41[0].tag, "0334_rare_slipstream");
    assert.equal(last41[40].tag, "0374_rare_wolfpack");
    for (const e of last41) {
      assert.match(e.sha256, /^[0-9a-f]{64}$/, `${e.tag} sha256`);
      assert.ok(Number.isInteger(e.when) && e.when > 0, `${e.tag} when`);
      assert.ok(Array.isArray(e.tables) && Array.isArray(e.columns), `${e.tag} tables/columns arrays`);
    }
    const tables = new Set(last41.flatMap((e) => e.tables));
    const columns = new Set(last41.flatMap((e) => e.columns));
    assert.equal(tables.size, 25, "25 new tables introduced by 0334..0374");
    assert.equal(columns.size, 57, "57 new columns introduced by 0334..0374");
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

describe("vendor-release-add --check-check-list", () => {
  const all = {
    registry: ["v2026.1001.0", "v2026.1005.0", "v2026.1012.0", "v2026.1023.0"],
    smoke: ["v2026.916.0", "v2026.916.1", "v2026.1001.0", "v2026.1005.0", "v2026.1012.0", "v2026.1023.0"],
    fixtures: ["v2026.916.0", "v2026.916.1", "v2026.1001.0", "v2026.1005.0", "v2026.1012.0", "v2026.1023.0"],
  };

  it("passes when every registry release is smoke-covered and fixture-covered", () => {
    assert.deepEqual(checkCheckList(all), []);
  });

  it("fails when the vendor-watch check could mark a release supported without a smoke run", () => {
    // The OPE-12241 regression: v2026.1023.0 was in the registry on main but absent
    // from the db-migration-smoke matrix, so "supported" had no smoke proof.
    const problems = checkCheckList({
      registry: ["v2026.1005.0", "v2026.1023.0"],
      smoke: ["v2026.1005.0"],
      fixtures: all.fixtures,
    });
    assert.ok(
      problems.some((p) => p.includes("v2026.1023.0") && p.includes("smoke matrix")),
      `expected a missing-from-smoke-matrix problem, got: ${JSON.stringify(problems)}`,
    );
  });

  it("fails when the smoke matrix names a release the registry does not support", () => {
    const problems = checkCheckList({
      registry: ["v2026.1005.0"],
      smoke: ["v2026.916.0", "v2026.916.1", "v2026.1005.0", "v2026.1099.0"],
      fixtures: all.fixtures,
    });
    assert.ok(
      problems.some((p) => p.includes("v2026.1099.0") && p.includes("smoke matrix")),
      `expected an unsupported-smoke problem, got: ${JSON.stringify(problems)}`,
    );
  });

  it("fails when a fixture release is not in the registry", () => {
    const problems = checkCheckList({
      registry: ["v2026.1005.0"],
      smoke: ["v2026.916.0", "v2026.916.1", "v2026.1005.0"],
      fixtures: ["v2026.916.0", "v2026.916.1", "v2026.1005.0", "v2026.1099.0"],
    });
    assert.ok(
      problems.some((p) => p.includes("v2026.1099.0") && p.includes("fixture release")),
      `expected an unsupported-fixture problem, got: ${JSON.stringify(problems)}`,
    );
  });

  it("keeps the real repository consistent: registry, smoke matrix and fixtures agree today", () => {
    const tsFile = path.resolve(import.meta.dirname, "../../cli/src/commands/myrmidon-migrate-vendor-releases.ts");
    const releasesLine = fs.readFileSync(tsFile, "utf8").split("\n").find((l) => l.startsWith("// releases:"));
    const registry = releasesLine ? releasesLine.replace("// releases:", "").trim().split(/\s+/).filter(Boolean) : [];
    const workflow = fs.readFileSync(
      path.resolve(import.meta.dirname, "../../.github/workflows/myrmidon-paperclip-migration.yml"),
      "utf8",
    );
    const matrix = /matrix:[\s\S]*?release:\n((?:\s+-\s+"v[\d.]+"\n)+)/.exec(workflow);
    assert.ok(matrix, "release matrix found in the migration workflow");
    const smoke = [...matrix[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    const generator = fs.readFileSync(
      path.join(import.meta.dirname, "paperclip-migration-generate-fixture.mjs"),
      "utf8",
    );
    const block = /export const SUPPORTED_RELEASES = \[([\s\S]*?)\n\];/.exec(generator);
    assert.ok(block, "SUPPORTED_RELEASES found in the fixture generator");
    const fixtures = [...block[1].matchAll(/tag: "([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(checkCheckList({ registry, smoke, fixtures }), []);
  });
});

