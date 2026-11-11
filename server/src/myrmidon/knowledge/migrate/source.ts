// server/src/myrmidon/knowledge/migrate/source.ts
//
// myrmidon(1.6.6 KNOWLEDGE-2.0 K-6): reads the plugin wiki export — the tree of
// markdown pages the LLM Wiki plugin wrote (a folder per section, `[[…]]`
// links inside). Page bodies stay in memory only; the report never reprints
// them (§5.3: pages may carry personal data).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isControlFile, isRawSource } from "./classify.js";
import { extractHeading, mapFrontmatter, parseFrontmatter, type FrontmatterFields, type ParsedFrontmatter } from "./frontmatter.js";

/** Guard against walking something that is not an export (e.g. `/`). */
const MAX_PAGES = 5000;
const MAX_PAGE_BYTES = 4 * 1024 * 1024;

export interface SourcePage {
  /** Path relative to the export root, posix separators. */
  path: string;
  bytes: number;
  frontmatter: ParsedFrontmatter;
  /** The fields the frontmatter supplied, already mapped to knowledge fields. */
  fields: FrontmatterFields;
  /** Title: frontmatter (page or catalog), else the catalog title, else the first H1, else the file name. */
  title: string;
}

export interface SourceTree {
  root: string;
  pages: SourcePage[];
  skipped: { controlFiles: number; rawSources: number; other: number };
}

export class SourceTreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceTreeError";
  }
}

function walk(root: string, current: string, out: string[]): void {
  const entries = readdirSync(current, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const absolute = join(current, entry.name);
    const relative = absolute.slice(root.length + 1).split("\\").join("/");
    if (entry.isDirectory()) {
      walk(root, absolute, out);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    if (isControlFile(relative) || isRawSource(relative)) continue;
    out.push(relative);
    if (out.length > MAX_PAGES) throw new SourceTreeError(`Export holds more than ${MAX_PAGES} pages; is "${root}" the right root?`);
  }
}

export interface ReadSourceTreeOptions {
  /** Optional catalog dump of `wiki_pages` rows: path → frontmatter/title. */
  catalog?: Record<string, { title?: string; pageType?: string; frontmatter?: Record<string, unknown> }>;
}

export function readSourceTree(root: string, options: ReadSourceTreeOptions = {}): SourceTree {
  const stat = statSync(root, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isDirectory()) throw new SourceTreeError(`Source root "${root}" is not a directory.`);
  const paths: string[] = [];
  walk(root, root, paths);

  const pages: SourcePage[] = [];
  const skipped = { controlFiles: 0, rawSources: 0, other: 0 };
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".md") && isControlFile(entry.name)) skipped.controlFiles += 1;
    else if (entry.isDirectory() && isRawSource(entry.name)) skipped.rawSources += 1;
  }

  for (const relative of paths.sort()) {
    const absolute = join(root, relative);
    const bytes = statSync(absolute).size;
    if (bytes > MAX_PAGE_BYTES) {
      skipped.other += 1;
      continue;
    }
    const raw = readFileSync(absolute, "utf8");
    const frontmatter = parseFrontmatter(raw);
    const catalogEntry = options.catalog?.[relative];
    const merged: Record<string, unknown> = { ...frontmatter.data, ...(catalogEntry?.frontmatter ?? {}) };
    const fields = mapFrontmatter(merged);
    const title = fields.title
      ?? catalogEntry?.title?.trim()
      ?? extractHeading(frontmatter.body)
      ?? relative.split("/").pop()!.replace(/\.md$/, "");
    pages.push({ path: relative, bytes, frontmatter, fields, title: title.trim() });
  }

  return { root, pages, skipped };
}

/** The catalog dump shape written next to an export (all keys optional). */
export function parseCatalog(text: string): Record<string, { title?: string; pageType?: string; frontmatter?: Record<string, unknown> }> {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SourceTreeError("Catalog dump must be a JSON object keyed by page path.");
  }
  return parsed as Record<string, { title?: string; pageType?: string; frontmatter?: Record<string, unknown> }>;
}