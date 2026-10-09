// server/src/myrmidon/knowledge/migrate/map.ts
//
// myrmidon(1.6.6 KNOWLEDGE-2.0 K-6): the slug map is the operator's artefact
// (§5.3, "карта slug'ов — оператор правит руками, не регуляркой"). The script
// seeds a template from the deterministic class rules (`classify --emit-map`)
// and then *reads* the hand-edited map; it never rewrites the operator's
// decisions on its own.

import { MIGRATE_CLASSES, type MigrateClass } from "./classify.js";

export const MIGRATE_ACTIONS = ["import", "merge", "drop", "replace_index"] as const;
export type MigrateAction = (typeof MIGRATE_ACTIONS)[number];

export interface MigratePagePlan {
  class: MigrateClass;
  action: MigrateAction;
  /** Target knowledge slug (absent for `drop`). */
  target?: string;
  /** Knowledge kind override (`wiki` by default, `rule` for regulations). */
  kind?: string;
  /** For `merge`: the slug the page is merged into (and superseded by). */
  mergeInto?: string;
  /** Rule pages only: who must approve (§4.3). */
  approverKind?: string | null;
  /** Import straight past review (glossary, releases). */
  publish?: boolean;
  /** Extra source refs appended to the page's own sources. */
  sources?: string[];
  tags?: string[];
  title?: string;
}

export interface MigrateCheck {
  query: string;
  /** Slug (or title fragment) the query must find. */
  expect: string;
}

export interface MigrateMap {
  version: 1;
  /** The class-sum control (§5.3: "сумма классов = 170"). */
  expectedTotal: number;
  /** Default source refs added to every imported page. */
  defaultSources?: string[];
  pages: Record<string, MigratePagePlan>;
  /** Three control queries that must find the expected pages (§5.3). */
  checks?: MigrateCheck[];
}

export class MigrateInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrateInputError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new MigrateInputError(`${where} must be a non-empty string.`);
  }
  return value.trim();
}

function isClass(value: unknown): value is MigrateClass {
  return typeof value === "string" && (MIGRATE_CLASSES as readonly string[]).includes(value);
}

/** Parses and validates the operator's slug map (JSON — hand-editable). */
export function parseSlugMap(text: string): MigrateMap {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new MigrateInputError(`Slug map is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) throw new MigrateInputError("Slug map must be a JSON object.");
  if (parsed["version"] !== 1) throw new MigrateInputError("Slug map version must be 1.");
  const expectedTotal = parsed["expectedTotal"];
  if (typeof expectedTotal !== "number" || !Number.isInteger(expectedTotal) || expectedTotal <= 0) {
    throw new MigrateInputError("Slug map expectedTotal must be a positive integer.");
  }
  const rawPages = parsed["pages"];
  if (!isRecord(rawPages)) throw new MigrateInputError("Slug map pages must be an object keyed by source path.");

  const pages: Record<string, MigratePagePlan> = {};
  for (const [sourcePath, rawPlan] of Object.entries(rawPages)) {
    if (!isRecord(rawPlan)) throw new MigrateInputError(`Slug map page "${sourcePath}" must be an object.`);
    const classId = rawPlan["class"];
    if (!isClass(classId)) throw new MigrateInputError(`Slug map page "${sourcePath}" has an unknown class.`);
    const action = rawPlan["action"];
    if (typeof action !== "string" || !(MIGRATE_ACTIONS as readonly string[]).includes(action)) {
      throw new MigrateInputError(`Slug map page "${sourcePath}" has an unknown action.`);
    }
    const plan: MigratePagePlan = { class: classId, action: action as MigrateAction };
    if (rawPlan["target"] !== undefined) plan.target = asString(rawPlan["target"], `pages["${sourcePath}"].target`);
    if (rawPlan["kind"] !== undefined) plan.kind = asString(rawPlan["kind"], `pages["${sourcePath}"].kind`);
    if (rawPlan["mergeInto"] !== undefined) plan.mergeInto = asString(rawPlan["mergeInto"], `pages["${sourcePath}"].mergeInto`);
    if (rawPlan["approverKind"] !== undefined) {
      plan.approverKind = rawPlan["approverKind"] === null ? null : asString(rawPlan["approverKind"], `pages["${sourcePath}"].approverKind`);
    }
    if (rawPlan["publish"] !== undefined) plan.publish = rawPlan["publish"] === true;
    if (rawPlan["sources"] !== undefined) {
      if (!Array.isArray(rawPlan["sources"])) throw new MigrateInputError(`pages["${sourcePath}"].sources must be an array.`);
      plan.sources = rawPlan["sources"].map((entry) => asString(entry, `pages["${sourcePath}"].sources[]`));
    }
    if (rawPlan["tags"] !== undefined) {
      if (!Array.isArray(rawPlan["tags"])) throw new MigrateInputError(`pages["${sourcePath}"].tags must be an array.`);
      plan.tags = rawPlan["tags"].map((entry) => asString(entry, `pages["${sourcePath}"].tags[]`));
    }
    if (rawPlan["title"] !== undefined) plan.title = asString(rawPlan["title"], `pages["${sourcePath}"].title`);
    if (plan.action !== "drop" && plan.target === undefined && plan.mergeInto === undefined) {
      throw new MigrateInputError(`pages["${sourcePath}"] action "${plan.action}" needs a target.`);
    }
    pages[sourcePath] = plan;
  }

  const defaultSources = Array.isArray(parsed["defaultSources"])
    ? parsed["defaultSources"].map((entry) => asString(entry, "defaultSources[]"))
    : undefined;

  let checks: MigrateCheck[] | undefined;
  if (parsed["checks"] !== undefined) {
    if (!Array.isArray(parsed["checks"])) throw new MigrateInputError("Slug map checks must be an array.");
    checks = parsed["checks"].map((entry, index) => {
      if (!isRecord(entry)) throw new MigrateInputError(`checks[${index}] must be an object.`);
      return {
        query: asString(entry["query"], `checks[${index}].query`),
        expect: asString(entry["expect"], `checks[${index}].expect`),
      };
    });
  }

  return { version: 1, expectedTotal, defaultSources, pages, checks };
}

export function serializeSlugMap(map: MigrateMap): string {
  const pages: Record<string, MigratePagePlan> = {};
  for (const sourcePath of Object.keys(map.pages).sort()) pages[sourcePath] = map.pages[sourcePath]!;
  const doc: Record<string, unknown> = {
    version: 1,
    expectedTotal: map.expectedTotal,
  };
  if (map.defaultSources !== undefined) doc["defaultSources"] = map.defaultSources;
  doc["pages"] = pages;
  if (map.checks !== undefined) doc["checks"] = map.checks;
  return `${JSON.stringify(doc, null, 2)}\n`;
}