// server/src/myrmidon/knowledge/migrate/classify.ts
//
// myrmidon(1.6.6 KNOWLEDGE-2.0 K-6): the §5.3 class rules, as code. The
// classifier is *deterministic and path-based* — it never guesses from page
// content (the operator owns the map, §5.3) and it produces the seed plan the
// operator then edits.
//
// Precedence is fixed and documented, because every page must land in exactly
// one class (§5.3: "каждая страница ровно в одном классе"):
//   G (root index) → F (logs) → D (template project pages) → B (regulations)
//   → E (stubs and probes) → C (answer pages / file-as-page) → A (content waves)
//
// The one deliberate exception: the OPE-3933 content waves (class A) are
// imported even when a page is short — a content wave page is knowledge by
// definition, and the operator's map can still drop it.

import type { MigrateAction } from "./map.js";

export const MIGRATE_CLASSES = ["A", "B", "C", "D", "E", "F", "G"] as const;
export type MigrateClass = (typeof MIGRATE_CLASSES)[number];

/** §5.3: the class-sum control the report asserts. */
export const DEFAULT_EXPECTED_TOTAL = 170;

/** §5.3: a stub/probe is a page smaller than this. */
export const STUB_BYTES = 200;

export interface SeedPlan {
  class: MigrateClass;
  action: MigrateAction;
  target?: string;
  kind?: string;
  mergeInto?: string;
  approverKind?: string | null;
  publish?: boolean;
  /** Why the classifier chose this class (goes into the report, no content). */
  reason: string;
}

const A_CONTENT_PREFIXES = ["myrmidon/", "company/", "bbq/", "infra/", "process/", "entities/", "work/", "glossary", "wiki-maintenance"] as const;

const C_PREFIXES = ["arch/", "ops/", "product/", "team/", "meta/", "synthesis/"] as const;

const D_PATTERNS = [
  /^projects\/[^/]+\/(index|standup|decisions|history)\.md$/,
  /^myrmidon\/(decisions-1\.6|release-1\.6|standup|index)\.md$/,
] as const;

const REGULATION_APPROVERS: Record<string, string> = {
  "secrets": "owner",
  "model-policy": "owner",
  "acceptance": "adm",
  "alerting": "adm",
  "backup": "adm",
};

/** Lowercases and slugifies one path segment into the knowledge slug alphabet. */
export function slugSegment(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, "")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  return cleaned === "" ? "page" : cleaned;
}

/** Derives a knowledge slug from a source path (folder + file, no extension). */
export function slugFor(sourcePath: string): string {
  const parts = sourcePath.split("/").filter((part) => part.length > 0);
  const segments = parts.map((part) => slugSegment(part));
  if (segments.length === 0) return "page";
  if (segments.length > 1 && segments[segments.length - 1] === "index") segments.pop();
  return segments.join("/");
}

function basename(sourcePath: string): string {
  const parts = sourcePath.split("/");
  return parts[parts.length - 1] ?? sourcePath;
}

function directory(sourcePath: string): string {
  const parts = sourcePath.split("/");
  parts.pop();
  return parts.join("/");
}

/** §5.3 class A target prefixes ("myrmidon/* → architecture/*" and friends). */
function classATarget(sourcePath: string): string {
  const slug = slugFor(sourcePath);
  const name = slugFor(sourcePath).split("/").pop() ?? slug;
  if (sourcePath.startsWith("myrmidon/")) return `architecture/${name}`;
  if (sourcePath.startsWith("company/decisions")) return `decisions/${name}`;
  if (sourcePath.startsWith("company/roles") || sourcePath.startsWith("team/")) return "product/roles-and-castes";
  if (sourcePath.startsWith("company/structure")) return "product/company-structure";
  if (sourcePath.startsWith("bbq/") || sourcePath.startsWith("work/")) return `directions/${name}`;
  if (sourcePath.startsWith("entities/outermust") || sourcePath.startsWith("entities/rq-002")) return `directions/${name}`;
  if (sourcePath.startsWith("infra/")) return `infra/${name}`;
  if (sourcePath.startsWith("process/")) return `runbooks/${name}`;
  if (sourcePath.startsWith("glossary")) return `glossary/${name}`;
  if (sourcePath.startsWith("wiki-maintenance")) return "runbooks/wiki-maintenance";
  return `architecture/${name}`;
}

/**
 * Classifies one source page. `bytes` is the file size — the stub rule (§5.3 E)
 * is the only rule that reads the file, and only its length.
 */
export function classifyPath(sourcePath: string, bytes: number): SeedPlan {
  const name = basename(sourcePath);
  const dir = directory(sourcePath);

  // G — the root index is replaced by generated section indexes.
  if (sourcePath === "index.md") {
    return { class: "G", action: "replace_index", reason: "root index.md → generated section indexes (§5.3 G)" };
  }

  // F — journals are dropped.
  if (/^log([-.].*)?\.md$/.test(name) || dir.split("/").some((segment) => /^log([-.].*)?$/.test(segment))) {
    return { class: "F", action: "drop", reason: "log journal (§5.3 F)" };
  }

  // D — template project pages live on the board and are not migrated.
  if (D_PATTERNS.some((pattern) => pattern.test(sourcePath))) {
    if (sourcePath === "myrmidon/release-1.6.md") {
      return { class: "D", action: "import", target: "releases/1.6.0", publish: true, reason: "release-1.6 → releases/1.6.0 (§5.3 D)" };
    }
    if (sourcePath === "myrmidon/decisions-1.6.md") {
      return { class: "D", action: "import", target: "decisions/1.6-release-registry", reason: "decisions-1.6 → check for decisions outside the registry (§5.3 D)" };
    }
    return { class: "D", action: "drop", reason: "template project page, the board shows it live (§5.3 D)" };
  }

  // B — regulations become rules (kind=rule, draft, imperative text).
  if (dir === "regulations" || dir.startsWith("regulations/")) {
    const approver = REGULATION_APPROVERS[slugSegment(name)] ?? null;
    return {
      class: "B",
      action: "import",
      target: `regulations/${slugSegment(name)}`,
      kind: "rule",
      approverKind: approver,
      reason: "regulation → kind=rule draft (§5.3 B)",
    };
  }

  // E — stubs and probes are dropped; the wiki schema page is rewritten.
  //    Exception: the OPE-3933 content waves below are knowledge regardless of
  //    size, so they skip the stub rule.
  if (bytes < STUB_BYTES && !A_CONTENT_PREFIXES.some((prefix) => sourcePath === prefix || sourcePath.startsWith(prefix))) {
    if (sourcePath === "meta/about-this-wiki.md") {
      return { class: "E", action: "import", target: "meta/schema", reason: "about-this-wiki → meta/schema (§5.3 E)" };
    }
    return { class: "E", action: "drop", reason: `stub/probe under ${STUB_BYTES} bytes (§5.3 E)` };
  }

  // C — answer pages are merged into the sections above, originals superseded.
  if (C_PREFIXES.some((prefix) => sourcePath.startsWith(prefix))) {
    const slug = slugFor(sourcePath);
    return {
      class: "C",
      action: "merge",
      target: `${slugSegment(dir.split("/")[0] ?? "page")}/${slug.split("/").pop() ?? "page"}`,
      reason: "answer page (file-as-page) merged into its section (§5.3 C)",
    };
  }

  // A — the OPE-3933 content waves are imported as drafts.
  if (A_CONTENT_PREFIXES.some((prefix) => sourcePath === prefix || sourcePath.startsWith(prefix))) {
    return {
      class: "A",
      action: "import",
      target: classATarget(sourcePath),
      kind: "wiki",
      reason: "OPE-3933 content wave (§5.3 A)",
    };
  }

  // Unknown layout: the operator must place it in the map by hand.
  throw new Error(`Unclassified source path "${sourcePath}"; the slug map must decide.`);
}

/** True when the path is a plugin control file, not a wiki page. */
export function isControlFile(sourcePath: string): boolean {
  const name = basename(sourcePath);
  return name === "AGENTS.md" || name === "IDEA.md";
}

/** True when the path is a raw source document (the plugin's `raw/` inbox). */
export function isRawSource(sourcePath: string): boolean {
  return sourcePath === "raw" || sourcePath.startsWith("raw/");
}