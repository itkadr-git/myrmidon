#!/usr/bin/env node
/**
 * generate-llms-txt.mjs
 *
 * Generates `docs/llms.txt` from `docs/docs.json` Mintlify navigation.
 *
 * docs.json is the publish contract for the Mintlify docs site: a page is
 * public on the published docs if and only if it appears in `navigation`.
 * The manifest therefore contains exactly the nav pages — nothing from the
 * 622-file docs tree outside nav (internal runbooks, ADRs, plans, .ru
 * variants, wikis, changelogs) can leak into it, and the generator fails
 * closed when a nav entry has no backing file.
 *
 * Usage:
 *   node scripts/myrmidon/docs/generate-llms-txt.mjs            # write docs/llms.txt
 *   node scripts/myrmidon/docs/generate-llms-txt.mjs --check    # exit 1 if docs/llms.txt is stale
 *
 * The output uses stable relative links (`start/quickstart.md`), so the
 * manifest works at the docs root both on disk and when served.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "../../..");
const DOCS_DIR = path.join(REPO_ROOT, "docs");
export const DOCS_JSON_PATH = path.join(DOCS_DIR, "docs.json");
export const OUTPUT_PATH = path.join(DOCS_DIR, "llms.txt");
export const OUTPUT_NAME = "llms.txt";

export function parseArgs(argv) {
  const args = { check: false, stdout: false };
  for (const arg of argv) {
    if (arg === "--check") args.check = true;
    else if (arg === "--stdout") args.stdout = true;
    else {
      process.stderr.write(`generate-llms-txt: unknown argument: ${arg}\n`);
      process.exitCode = 1;
      return null;
    }
  }
  return args;
}

/**
 * Collects page paths in nav order: tabs -> groups -> pages, in docs.json
 * order. Anchors (`page#section`) are rejected: they are not stable paths
 * resolvable to a .md file. Duplicate nav entries are included once.
 */
export function collectNavPages(docsJson) {
  const tabs = docsJson?.navigation?.tabs;
  if (!Array.isArray(tabs)) {
    throw new Error("docs.json navigation.tabs is missing or not an array");
  }
  const pages = [];
  const seen = new Set();
  for (const tab of tabs) {
    for (const group of Array.isArray(tab.groups) ? tab.groups : []) {
      for (const page of Array.isArray(group.pages) ? group.pages : []) {
        if (typeof page !== "string") {
          throw new Error(`nav page is not a string: ${JSON.stringify(page)}`);
        }
        if (page.includes("#")) {
          throw new Error(`nav page with anchor is not resolvable to a .md file: ${page}`);
        }
        if (page.trim() !== page || page === "") {
          throw new Error(`nav page is not a clean path: ${JSON.stringify(page)}`);
        }
        if (seen.has(page)) continue;
        seen.add(page);
        pages.push(page);
      }
    }
  }
  return pages;
}

/** Extracts `title` and `summary` from the leading `---` front matter block. */
export function parseFrontMatter(content) {
  if (!content.startsWith("---")) {
    return { title: null, summary: null };
  }
  const end = content.indexOf("\n---", 3);
  if (end === -1) {
    return { title: null, summary: null };
  }
  const block = content.slice(3, end);
  const result = { title: null, summary: null };
  for (const line of block.split("\n")) {
    const match = /^(title|summary):\s*(.*)$/.exec(line);
    if (match) {
      let value = match[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      result[match[1]] = value;
    }
  }
  return result;
}

/** Resolves a nav page path to an existing .md/.mdx file relative to the docs root. */
export function resolvePageFile(docsDir, page) {
  for (const ext of [".mdx", ".md"]) {
    const candidate = path.join(docsDir, page + ext);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

/**
 * Builds the full manifest body. Throws when a nav page cannot be resolved
 * to a backing file (fail closed: never publish a manifest with dead links).
 */
export function buildManifest(docsJson, docsDir) {
  const pages = collectNavPages(docsJson);
  const lines = ["# Myrmidon", "", "> The control plane for autonomous AI companies.", ""];
  const missing = [];
  const entries = [];
  for (const page of pages) {
    const file = resolvePageFile(docsDir, page);
    if (!file) {
      missing.push(page);
      continue;
    }
    const { title, summary } = parseFrontMatter(fs.readFileSync(file, "utf8"));
    const link = `- [${title ?? page}](${page}.md)`;
    entries.push(summary ? `${link}: ${summary}` : link);
  }
  if (missing.length > 0) {
    throw new Error(
      `nav pages without a backing .md/.mdx file (refusing to emit llms.txt with broken links): ${missing.join(", ")}`,
    );
  }
  return [...lines, ...entries, ""].join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) return;
  const docsJson = JSON.parse(fs.readFileSync(DOCS_JSON_PATH, "utf8"));
  const manifest = buildManifest(docsJson, DOCS_DIR);
  if (args.stdout) {
    process.stdout.write(manifest);
    return;
  }
  if (args.check) {
    const current = fs.existsSync(OUTPUT_PATH) ? fs.readFileSync(OUTPUT_PATH, "utf8") : "";
    if (current !== manifest) {
      process.stderr.write(
        `${OUTPUT_NAME} is stale. Run: node scripts/myrmidon/docs/generate-llms-txt.mjs\n`,
      );
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${OUTPUT_NAME} is up to date.\n`);
    return;
  }
  fs.writeFileSync(OUTPUT_PATH, manifest);
  process.stdout.write(`wrote ${path.relative(REPO_ROOT, OUTPUT_PATH)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
