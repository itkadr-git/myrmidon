#!/usr/bin/env node
// CHANGE-FRAGMENTS: assembles the per-PR change fragments of
// docs/myrmidon/changes/ into the shared registry documents and removes the
// fragments. Run by whoever cuts a release, as one PR, right before the
// `myr-vX.Y.Z` tag.
//
//   node scripts/myrmidon/release/collect-fragments.mjs --version X.Y.Z [--root <dir>] [--dry-run]
//
// What it does, per fragment file docs/myrmidon/changes/<slug>.md:
//   ## changelog-en   -> a "###" section under "## X.Y.Z" in CHANGELOG.md
//                        (created from "## Unreleased"; the heading is left
//                        behind, empty, for the next cycle)
//   ## changelog-ru   -> same for CHANGELOG.ru.md ("## Без выпуска")
//   ## divergence     -> table rows appended to the section named by the
//                        front-matter key `divergence-section`
//   ## settings-en    -> table rows appended to SETTINGS.md, section
//                        `settings-section`
//   ## settings-ru    -> table rows appended to SETTINGS.ru.md, same section
//                        name (the RU file reuses the EN section headings)
// Then every consumed fragment file is deleted.
//
// Fragment format (docs/myrmidon/changes/README.md):
//   ---
//   divergence-section: Трек 5 — эксплуатация
//   settings-section: Track 5 — operations
//   ---
//   ## changelog-en
//   ### Title (FEATURE-ID)
//   - …
//
// Every section is optional; a fragment must carry at least one of them.
// Table-row sections must contain only table rows (lines starting with `|`).
//
// Exit code: 0 ok (or nothing to do), 1 errors, 2 usage. Node built-ins only.

import fs from "node:fs";
import path from "node:path";

const FRAGMENTS_DIR = "docs/myrmidon/changes";
const SECTION_KEYS = [
  "changelog-en",
  "changelog-ru",
  "divergence",
  "settings-en",
  "settings-ru",
];
const FRONT_MATTER_KEYS = ["divergence-section", "settings-section"];

export function parseFragment(text, fileName = "<fragment>") {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const meta = {};
  let rest = lines;
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end === -1) {
      throw new Error(`${fileName}: front matter opened but never closed`);
    }
    for (const raw of lines.slice(1, end)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const m = /^([a-z-]+):\s*(.+)$/.exec(line);
      if (!m) throw new Error(`${fileName}: bad front-matter line: ${raw}`);
      if (!FRONT_MATTER_KEYS.includes(m[1])) {
        throw new Error(`${fileName}: unknown front-matter key "${m[1]}"`);
      }
      meta[m[1]] = m[2].trim();
    }
    rest = lines.slice(end + 1);
  }
  const sections = {};
  let current = null;
  for (const raw of rest) {
    const h = /^## ([a-z-]+)\s*$/.exec(raw);
    if (h) {
      if (!SECTION_KEYS.includes(h[1])) {
        throw new Error(
          `${fileName}: unknown section "## ${h[1]}" (known: ${SECTION_KEYS.join(", ")})`,
        );
      }
      if (sections[h[1]] !== undefined) {
        throw new Error(`${fileName}: duplicate section "## ${h[1]}"`);
      }
      current = h[1];
      sections[current] = [];
      continue;
    }
    if (/^#{1,2} /.test(raw)) {
      throw new Error(
        `${fileName}: unexpected heading "${raw}" — sections are "## <key>", content headings start at "###"`,
      );
    }
    if (current !== null) sections[current].push(raw);
  }
  const out = {};
  for (const key of SECTION_KEYS) {
    if (sections[key] === undefined) continue;
    const body = sections[key].join("\n").replace(/^\n+|\n+$/g, "");
    if (body) out[key] = body;
  }
  if (Object.keys(out).length === 0) {
    throw new Error(`${fileName}: no content sections — nothing to collect`);
  }
  for (const key of ["divergence", "settings-en", "settings-ru"]) {
    if (!out[key]) continue;
    for (const line of out[key].split("\n")) {
      if (line.trim() && !line.trimStart().startsWith("|")) {
        throw new Error(
          `${fileName}: section "${key}" takes only table rows (lines starting with "|"), got: ${line.trim().slice(0, 60)}`,
        );
      }
    }
  }
  if (out["divergence"] && !meta["divergence-section"]) {
    throw new Error(
      `${fileName}: has a divergence section but no "divergence-section" front-matter key`,
    );
  }
  if ((out["settings-en"] || out["settings-ru"]) && !meta["settings-section"]) {
    throw new Error(
      `${fileName}: has a settings section but no "settings-section" front-matter key`,
    );
  }
  return { meta, sections: out };
}

/** Lists fragment files of the changes directory (README.md is not one). */
export function listFragments(root) {
  const dir = path.join(root, FRAGMENTS_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".md") && name.toLowerCase() !== "readme.md")
    .sort();
}

/**
 * Replaces the `## <unreleasedHeading>` section with `## <version>` carrying
 * the fragment blocks, and leaves an empty `## <unreleasedHeading>` behind.
 * Blocks keep their own "###" titles; fragments are inserted in file-name
 * order.
 */
export function foldChangelog(docText, { version, unreleasedHeading, blocks }) {
  const lines = docText.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${unreleasedHeading}`);
  if (start === -1) {
    throw new Error(`changelog has no "## ${unreleasedHeading}" section`);
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^## /.test(lines[i])) {
      end = i;
      break;
    }
  }
  const body = lines
    .slice(start + 1, end)
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
  const merged = [body, ...blocks].filter(Boolean).join("\n\n");
  const next = [
    ...lines.slice(0, start),
    `## ${unreleasedHeading}`,
    "",
    `## ${version}`,
    "",
    ...(merged ? [merged, ""] : []),
    ...lines.slice(end),
  ];
  return next.join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * Appends table rows to the "## <sectionHeading>" table of a registry
 * document (DIVERGENCE.md, SETTINGS*.md). The rows go after the last existing
 * table row of that section, before the next "## " heading.
 */
export function foldTableRows(docText, { sectionHeading, rows }, { fileName = "<doc>" } = {}) {
  const lines = docText.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${sectionHeading}`);
  if (start === -1) {
    const known = lines.filter((l) => /^## /.test(l)).map((l) => l.slice(3));
    throw new Error(
      `${fileName}: no "## ${sectionHeading}" section (have: ${known.join(" | ")})`,
    );
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^## /.test(lines[i])) {
      end = i;
      break;
    }
  }
  let lastRow = -1;
  for (let i = start + 1; i < end; i += 1) {
    if (lines[i].trimStart().startsWith("|")) lastRow = i;
  }
  if (lastRow === -1) {
    throw new Error(`${fileName}: section "## ${sectionHeading}" has no table`);
  }
  const rowLines = rows.split("\n").filter((l) => l.trim());
  const next = [...lines.slice(0, lastRow + 1), ...rowLines, ...lines.slice(lastRow + 1)];
  return next.join("\n");
}

export function collect(root, { version, dryRun = false, log = () => {} } = {}) {
  const names = listFragments(root);
  const fragments = names.map((name) => ({
    name,
    file: path.join(FRAGMENTS_DIR, name),
    ...parseFragment(fs.readFileSync(path.join(root, FRAGMENTS_DIR, name), "utf8"), name),
  }));
  const result = { changed: [], deleted: [], fragments: fragments.map((f) => f.file) };
  if (fragments.length === 0) return result;

  const edits = new Map(); // relative path -> new text
  const read = (rel) =>
    edits.get(rel) ?? fs.readFileSync(path.join(root, rel), "utf8");

  const enBlocks = fragments.filter((f) => f.sections["changelog-en"]).map((f) => f.sections["changelog-en"]);
  const ruBlocks = fragments.filter((f) => f.sections["changelog-ru"]).map((f) => f.sections["changelog-ru"]);
  const half = enBlocks.length > 0 && ruBlocks.length > 0 && enBlocks.length !== ruBlocks.length;
  if (half) {
    throw new Error(
      `changelog-en (${enBlocks.length}) and changelog-ru (${ruBlocks.length}) fragment counts differ — every user-visible entry ships in both languages`,
    );
  }
  if (enBlocks.length > 0) {
    edits.set(
      "docs/myrmidon/CHANGELOG.md",
      foldChangelog(read("docs/myrmidon/CHANGELOG.md"), {
        version,
        unreleasedHeading: "Unreleased",
        blocks: enBlocks,
      }),
    );
  }
  if (ruBlocks.length > 0) {
    edits.set(
      "docs/myrmidon/CHANGELOG.ru.md",
      foldChangelog(read("docs/myrmidon/CHANGELOG.ru.md"), {
        version,
        unreleasedHeading: "Без выпуска",
        blocks: ruBlocks,
      }),
    );
  }

  for (const f of fragments) {
    if (f.sections["divergence"]) {
      edits.set(
        "docs/myrmidon/DIVERGENCE.md",
        foldTableRows(read("docs/myrmidon/DIVERGENCE.md"), {
          sectionHeading: f.meta["divergence-section"],
          rows: f.sections["divergence"],
        }, { fileName: f.name }),
      );
    }
    for (const [key, rel] of [
      ["settings-en", "docs/myrmidon/SETTINGS.md"],
      ["settings-ru", "docs/myrmidon/SETTINGS.ru.md"],
    ]) {
      if (!f.sections[key]) continue;
      edits.set(
        rel,
        foldTableRows(read(rel), {
          sectionHeading: f.meta["settings-section"],
          rows: f.sections[key],
        }, { fileName: f.name }),
      );
    }
  }

  result.changed = [...edits.keys()];
  result.deleted = fragments.map((f) => f.file);
  for (const [rel, text] of edits) {
    log(`update ${rel}`);
    if (!dryRun) fs.writeFileSync(path.join(root, rel), text);
  }
  for (const f of fragments) {
    log(`delete ${f.file}`);
    if (!dryRun) fs.unlinkSync(path.join(root, FRAGMENTS_DIR, f.name));
  }
  return result;
}

function main(argv) {
  const args = { root: process.cwd(), dryRun: false, version: null };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case "--version":
        args.version = argv[++i];
        break;
      case "--root":
        args.root = argv[++i];
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      default:
        console.error(`unknown argument: ${argv[i]}`);
        return 2;
    }
  }
  if (!args.version || !/^\d+\.\d+\.\d+$/.test(args.version)) {
    console.error("usage: collect-fragments.mjs --version X.Y.Z [--root <dir>] [--dry-run]");
    return 2;
  }
  try {
    const result = collect(args.root, {
      version: args.version,
      dryRun: args.dryRun,
      log: (line) => console.log(line),
    });
    if (result.fragments.length === 0) {
      console.log("no fragments in docs/myrmidon/changes/ — nothing to collect");
      return 0;
    }
    console.log(
      `${args.dryRun ? "[dry-run] would collect" : "collected"} ${result.fragments.length} fragment(s) into ${result.changed.length} document(s)`,
    );
    return 0;
  } catch (err) {
    console.error(`collect-fragments: ${err.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
