// scripts/knowledge-migrate.ts
//
// myrmidon(1.6.6 KNOWLEDGE-2.0 K-6): the plugin → knowledge transfer CLI.
//
//   knowledge-migrate classify --root <export> [--map <map.json>] [--emit-map <file>]
//   knowledge-migrate import   --root <export> --map <map.json> --company-id <uuid>
//
// Both take `--dry-run` (compute everything, write nothing) and both print a
// numeric report: page counts per §5.3 class and their sum, the link
// resolution rate, the frontmatter keys that were parsed. Page bodies never
// reach the report — they may hold personal data (§5.3).

import { readFileSync, writeFileSync } from "node:fs";
import { createDb, createPgKnowledgeSearchIndex } from "../packages/db/src/index.js";
import { loadConfig } from "../server/src/config.js";
import { createKnowledgeService } from "../server/src/myrmidon/knowledge/store.js";
import {
  DEFAULT_EXPECTED_TOTAL,
  MigrateInputError,
  parseCatalog,
  parseSlugMap,
  planMigration,
  runImport,
  seedSlugMap,
  serializeSlugMap,
  type KnowledgeActor,
  type MigrationPlan,
  type MigrateMap,
} from "../server/src/myrmidon/knowledge/migrate/index.js";

function flag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

function has(name: string): boolean {
  return process.argv.includes(name);
}

function usage(): never {
  console.error(
    [
      "usage:",
      "  knowledge-migrate classify --root <export> [--map <map.json>] [--emit-map <file>] [--catalog <json>] [--out <json>] [--expected-total 170] [--dry-run]",
      "  knowledge-migrate import   --root <export> --map <map.json> --company-id <uuid> [--nest-id <uuid>] [--actor-agent <id>] [--out <json>] [--dry-run]",
    ].join("\n"),
  );
  process.exit(2);
}

function readMap(path: string | null): MigrateMap {
  if (path === null) {
    return { version: 1, expectedTotal: DEFAULT_EXPECTED_TOTAL, pages: {}, checks: [] };
  }
  return parseSlugMap(readFileSync(path, "utf8"));
}

function databaseUrl(): string {
  const fromEnv = process.env["DATABASE_URL"]?.trim();
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return loadConfig().databaseUrl;
}

function emit(report: unknown, out: string | null): void {
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (out === null) process.stdout.write(text);
  else {
    writeFileSync(out, text, "utf8");
    console.log(`knowledge-migrate: report written to ${out}`);
  }
}

function summarize(plan: MigrationPlan, report: ReturnType<typeof planMigration>["report"]): void {
  const classes = Object.entries(report.classes)
    .filter(([, count]) => count > 0)
    .map(([classId, count]) => `${classId}=${count}`)
    .join(" ");
  console.log(`knowledge-migrate: ${report.source.pages} pages at ${plan.source.root}`);
  console.log(`knowledge-migrate: classes ${classes} (sum ${report.classSum.actual}/${report.classSum.expected}${report.classSum.ok ? "" : " MISMATCH"})`);
  console.log(`knowledge-migrate: actions ${Object.entries(report.actions).filter(([, count]) => count > 0).map(([action, count]) => `${action}=${count}`).join(" ")}`);
  console.log(`knowledge-migrate: frontmatter parsed ${report.frontmatter.withBlock}/${report.source.pages} (malformed lines ${report.frontmatter.malformedLines}); keys ${Object.keys(report.frontmatter.keys).join(",") || "-"}`);
  console.log(`knowledge-migrate: links ${report.links.resolved}/${report.links.total} resolved (${report.links.percent}%), unresolved targets ${report.links.unresolvedTargets.length}`);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== "classify" && command !== "import") usage();
  const root = flag("--root");
  if (root === null) usage();
  const dryRun = has("--dry-run");
  const expectedTotal = Number.parseInt(flag("--expected-total") ?? `${DEFAULT_EXPECTED_TOTAL}`, 10);
  const mapPath = flag("--map");
  const catalogPath = flag("--catalog");
  const out = flag("--out");
  const map = readMap(mapPath);
  const catalog = catalogPath === null ? undefined : parseCatalog(readFileSync(catalogPath, "utf8"));

  const plan = planMigration({ root, map, expectedTotal, dryRun, catalog });
  summarize(plan, plan.report);

  if (command === "classify") {
    const emitMap = flag("--emit-map");
    if (emitMap !== null) {
      const seeded = seedSlugMap(plan, map);
      if (dryRun) {
        console.log(`knowledge-migrate: --dry-run: would write the seeded slug map to ${emitMap} (${Object.keys(seeded.pages).length} pages)`);
      } else {
        writeFileSync(emitMap, serializeSlugMap(seeded), "utf8");
        console.log(`knowledge-migrate: seeded slug map written to ${emitMap} (${Object.keys(seeded.pages).length} pages) — hand-edit it before import`);
      }
    }
    emit(plan.report, out);
    if (!plan.report.classSum.ok) {
      console.error(`knowledge-migrate: class sum ${plan.report.classSum.actual} != expected ${plan.report.classSum.expected}`);
      process.exitCode = 1;
    }
    return;
  }

  const companyId = flag("--company-id");
  if (companyId === null) usage();
  const nestId = flag("--nest-id") ?? companyId;
  const actorAgent = flag("--actor-agent");
  const actor: KnowledgeActor = actorAgent === null
    ? { actorType: "system", actorId: null, kind: null }
    : { actorType: "agent", actorId: actorAgent, kind: null };

  const db = createDb(databaseUrl());
  const service = createKnowledgeService(db, { searchIndex: createPgKnowledgeSearchIndex(db) });
  const report = await runImport({ plan, service, companyId, nestId, actor, dryRun, expectedTotal });
  emit(report, out);

  console.log(
    `knowledge-migrate: ${dryRun ? "would write" : "wrote"} ${report.created} items, ${report.appended} merged revisions, ` +
      `${report.revisionsWritten} revisions, ${report.sourcesWritten} sources, ${report.dropped} pages not moved`,
  );
  console.log(`knowledge-migrate: links resolved ${report.links.percent}%; checks ${report.checks.filter((check) => check.found).length}/${report.checks.length} found`);
  if (report.mergeNeedsDecision.length > 0) console.log(`knowledge-migrate: ${report.mergeNeedsDecision.length} merged pages still need the operator's mergeInto`);
  if (report.failed.length > 0) {
    for (const failure of report.failed) console.error(`knowledge-migrate: page ${failure.path} failed (${failure.code})`);
    process.exitCode = 1;
  } else if (!report.classSum.ok) {
    process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  if (error instanceof MigrateInputError) {
    console.error(`knowledge-migrate: ${error.message}`);
  } else {
    console.error(`knowledge-migrate failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exitCode = 1;
});