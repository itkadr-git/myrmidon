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
// Extended sections (new sections, prose, row replacement; see README):
//   ## <doc>-new      (divergence-new | settings-en-new | settings-ru-new)
//                     one or more new "##" sections; written with "###"
//                     headings in the fragment, promoted one level on insert;
//                     optional `<!-- after: Section heading -->` (default: end
//                     of the document)
//   ## <doc>-append   prose and/or rows added at the end of an existing
//                     section (`<!-- section: Heading -->`) or after one exact
//                     line (`<!-- after-line: text -->`)
//   ## <doc>-replace  table rows that replace the existing row with the same
//                     first cell (optional `<!-- section: Heading -->` to
//                     disambiguate)
// The three extended families may repeat inside one fragment.
// Fragments are always applied in file-name order (bytewise), so the result
// does not depend on the order the file system lists them.
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

// Registry documents a fragment can edit, by family prefix.
const DOC_FILES = {
  divergence: "docs/myrmidon/DIVERGENCE.md",
  "settings-en": "docs/myrmidon/SETTINGS.md",
  "settings-ru": "docs/myrmidon/SETTINGS.ru.md",
};
const EDIT_KINDS = ["new", "append", "replace"];
const EDIT_KEYS = Object.keys(DOC_FILES).flatMap((doc) =>
  EDIT_KINDS.map((kind) => `${doc}-${kind}`),
);
const DIRECTIVE_KEYS = ["section", "after", "after-line", "occurrence"];

const isTableRow = (line) => line.trimStart().startsWith("|");

/** First cell of a markdown table row, trimmed (escaped pipes stay inside the cell). */
export function firstCell(line) {
  const m = /^\s*\|\s*((?:\\\||[^|])*?)\s*\|/.exec(line);
  return m ? m[1] : null;
}

/** Splits a block body into leading `<!-- key: value -->` directives and content. */
function parseDirectives(rawLines, fileName, key) {
  const directives = {};
  let i = 0;
  while (i < rawLines.length) {
    const line = rawLines[i].trim();
    if (!line) {
      i += 1;
      continue;
    }
    const m = /^<!--\s*([a-z-]+):\s*(.*?)\s*-->$/.exec(line);
    if (!m) break;
    if (!DIRECTIVE_KEYS.includes(m[1])) {
      throw new Error(`${fileName}: section "${key}": unknown directive "${m[1]}" (known: ${DIRECTIVE_KEYS.join(", ")})`);
    }
    if (directives[m[1]] !== undefined) {
      throw new Error(`${fileName}: section "${key}": duplicate directive "${m[1]}"`);
    }
    if (!m[2]) throw new Error(`${fileName}: section "${key}": directive "${m[1]}" has no value`);
    if (m[1] === "occurrence" && !/^[1-9]\d*$/.test(m[2])) {
      throw new Error(`${fileName}: section "${key}": "occurrence" must be a positive integer, got "${m[2]}"`);
    }
    directives[m[1]] = m[2];
    i += 1;
  }
  const body = rawLines.slice(i).join("\n").replace(/^\n+|\n+$/g, "");
  return { directives, body };
}

/** "###" -> "##" (and deeper levels likewise) outside code fences. */
export function promoteHeadings(body) {
  let fence = false;
  return body
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) fence = !fence;
      if (fence) return line;
      return /^#{3,} /.test(line) ? line.slice(1) : line;
    })
    .join("\n");
}

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
  const rawEdits = []; // repeatable extended blocks, in file order
  let current = null; // { key, lines, edit }
  let fence = false;
  for (const raw of rest) {
    if (/^\s*(```|~~~)/.test(raw)) fence = !fence;
    const h = fence ? null : /^## ([a-z-]+)\s*$/.exec(raw);
    if (h) {
      const key = h[1];
      const isEdit = EDIT_KEYS.includes(key);
      if (!SECTION_KEYS.includes(key) && !isEdit) {
        throw new Error(
          `${fileName}: unknown section "## ${key}" (known: ${[...SECTION_KEYS, ...EDIT_KEYS].join(", ")})`,
        );
      }
      if (!isEdit && sections[key] !== undefined) {
        throw new Error(`${fileName}: duplicate section "## ${key}"`);
      }
      current = { key, lines: [], edit: isEdit };
      if (isEdit) rawEdits.push(current);
      else sections[key] = current.lines;
      continue;
    }
    if (!fence && /^#{1,2} /.test(raw)) {
      throw new Error(
        `${fileName}: unexpected heading "${raw}" — sections are "## <key>", content headings start at "###"`,
      );
    }
    if (current !== null) current.lines.push(raw);
  }
  const out = {};
  for (const key of SECTION_KEYS) {
    if (sections[key] === undefined) continue;
    const body = sections[key].join("\n").replace(/^\n+|\n+$/g, "");
    if (body) out[key] = body;
  }
  const edits = [];
  for (const e of rawEdits) {
    const { directives, body } = parseDirectives(e.lines, fileName, e.key);
    if (!body) continue;
    const kind = e.key.slice(e.key.lastIndexOf("-") + 1);
    const doc = e.key.slice(0, e.key.lastIndexOf("-"));
    const lines = body.split("\n");
    const rowsOnly = lines.every((l) => !l.trim() || isTableRow(l));
    if (kind === "new") {
      if (!/^### \S/.test(lines[0])) {
        throw new Error(`${fileName}: section "${e.key}" must start with a "### <heading>" line (it becomes a "##" section)`);
      }
      if (directives.section !== undefined) {
        throw new Error(`${fileName}: section "${e.key}" takes "after" or "after-line", not "section"`);
      }
      if (directives.occurrence !== undefined && directives.after === undefined) {
        throw new Error(`${fileName}: section "${e.key}": "occurrence" goes with "after"`);
      }
      if (directives.after !== undefined && directives["after-line"] !== undefined) {
        throw new Error(`${fileName}: section "${e.key}": "after" and "after-line" are mutually exclusive`);
      }
    } else if (kind === "append") {
      const n = ["section", "after-line"].filter((k) => directives[k] !== undefined).length;
      if (n !== 1 || directives.after !== undefined) {
        throw new Error(`${fileName}: section "${e.key}" needs exactly one of <!-- section: Heading --> / <!-- after-line: text -->`);
      }
      if (directives.occurrence !== undefined && directives.section === undefined) {
        throw new Error(`${fileName}: section "${e.key}": "occurrence" goes with "section"`);
      }
      if (rowsOnly && directives.section === undefined) {
        throw new Error(`${fileName}: section "${e.key}": a rows-only block needs <!-- section: Heading -->`);
      }
    } else {
      if (!rowsOnly) {
        throw new Error(`${fileName}: section "${e.key}" takes only table rows (lines starting with "|")`);
      }
      if (directives.after !== undefined || directives["after-line"] !== undefined ||
          (directives.occurrence !== undefined && directives.section === undefined)) {
        throw new Error(`${fileName}: section "${e.key}" accepts only <!-- section: Heading --> (optionally with <!-- occurrence: N -->)`);
      }
    }
    edits.push({
      key: e.key,
      doc,
      kind,
      directives,
      body: kind === "new" ? promoteHeadings(body) : body,
    });
  }
  if (Object.keys(out).length === 0 && edits.length === 0) {
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
  return { meta, sections: out, edits };
}

/** Lists fragment files of the changes directory (README.md is not one). */
export function listFragments(root) {
  const dir = path.join(root, FRAGMENTS_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".md") && name.toLowerCase() !== "readme.md")
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
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
  if (version === null) {
    // Preview mode: the blocks join the Unreleased section in place.
    const kept = [
      ...lines.slice(0, start),
      `## ${unreleasedHeading}`,
      "",
      ...(merged ? [merged, ""] : []),
      ...lines.slice(end),
    ];
    return kept.join("\n").replace(/\n{3,}/g, "\n\n");
  }
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
export function foldTableRows(docText, { sectionHeading, rows, occurrence = 1 }, { fileName = "<doc>" } = {}) {
  const lines = docText.split("\n");
  let start = -1;
  for (let i = 0, seen = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === `## ${sectionHeading}` && (seen += 1) === occurrence) {
      start = i;
      break;
    }
  }
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

/** Indexes of "## " headings outside code fences. */
function headingIndexes(lines) {
  const out = [];
  let fence = false;
  lines.forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    if (!fence && /^## /.test(l)) out.push(i);
  });
  return out;
}

/** The unique "## <heading>" section as { start, end } (end = next heading or EOF); throws otherwise. */
function findUniqueSection(lines, heading, fileName, occurrence = null) {
  const heads = headingIndexes(lines);
  let hits = heads.filter((i) => lines[i].trimEnd() === `## ${heading}`);
  if (occurrence !== null) {
    if (hits.length < occurrence) {
      throw new Error(`${fileName}: "## ${heading}" has ${hits.length} section(s), occurrence ${occurrence} does not exist`);
    }
    hits = [hits[occurrence - 1]];
  }
  if (hits.length === 0) {
    throw new Error(
      `${fileName}: no "## ${heading}" section (have: ${heads.map((i) => lines[i].slice(3)).join(" | ")})`,
    );
  }
  if (hits.length > 1) {
    throw new Error(
      `${fileName}: "## ${heading}" is ambiguous (${hits.length} sections at lines ${hits.map((i) => i + 1).join(", ")}) — add <!-- occurrence: N --> or use <!-- after-line: ... -->`,
    );
  }
  const start = hits[0];
  const end = heads.find((i) => i > start) ?? lines.length;
  return { start, end };
}

function findUniqueLine(lines, text, fileName) {
  const hits = [];
  lines.forEach((l, i) => {
    if (l.trimEnd() === text.trimEnd()) hits.push(i);
  });
  if (hits.length !== 1) {
    throw new Error(
      `${fileName}: after-line anchor ${JSON.stringify(text.slice(0, 70))} matches ${hits.length} lines, need exactly one`,
    );
  }
  return hits[0];
}

/** Index after the last non-blank line in [from, to). */
function afterLastContent(lines, from, to) {
  let i = to;
  while (i > from && !lines[i - 1].trim()) i -= 1;
  return i;
}

/**
 * Replaces existing table rows by their first cell (the ID / variable name).
 * `section` limits the lookup when the key is not unique in the document.
 */
export function foldReplaceRows(docText, { rows, section = null, occurrence = null }, { fileName = "<doc>" } = {}) {
  const lines = docText.split("\n");
  let from = 0;
  let to = lines.length;
  if (section !== null) {
    const sec = findUniqueSection(lines, section, fileName, occurrence);
    from = sec.start + 1;
    to = sec.end;
  }
  for (const row of rows.split("\n").filter((l) => l.trim())) {
    const key = firstCell(row);
    if (key === null) throw new Error(`${fileName}: replacement row has no first cell: ${row.slice(0, 60)}`);
    const hits = [];
    for (let i = from; i < to; i += 1) {
      if (isTableRow(lines[i]) && firstCell(lines[i]) === key) hits.push(i);
    }
    if (hits.length !== 1) {
      throw new Error(
        `${fileName}: row replacement for ${JSON.stringify(key)} matches ${hits.length} rows, need exactly one${hits.length > 1 && section === null ? " (add <!-- section: Heading -->)" : ""}`,
      );
    }
    lines[hits[0]] = row;
  }
  return lines.join("\n");
}

/**
 * Adds a prose / mixed block to an existing section (end of that section) or
 * after one exact line. A rows-only block with `section` follows the table-row
 * rule (after the section's last table row).
 */
export function foldAppendBlock(docText, { body, section = null, afterLine = null, occurrence = null }, { fileName = "<doc>" } = {}) {
  const rowsOnly = body.split("\n").every((l) => !l.trim() || isTableRow(l));
  if (section !== null && rowsOnly) {
    findUniqueSection(docText.split("\n"), section, fileName, occurrence);
    return foldTableRows(docText, { sectionHeading: section, rows: body, occurrence: occurrence ?? 1 }, { fileName });
  }
  const lines = docText.split("\n");
  const block = body.split("\n");
  let at;
  if (section !== null) {
    const sec = findUniqueSection(lines, section, fileName, occurrence);
    at = afterLastContent(lines, sec.start + 1, sec.end);
    lines.splice(at, 0, "", ...block);
    return lines.join("\n");
  }
  at = findUniqueLine(lines, afterLine, fileName) + 1;
  const tail = lines[at] !== undefined && lines[at].trim() ? [""] : [];
  lines.splice(at, 0, "", ...block, ...tail);
  return lines.join("\n");
}

/**
 * Inserts new "##" sections. `items` are [{ body, after, afterLine }] in
 * application order; items that share an anchor keep their relative order
 * (the second goes after the first). Without an anchor the text is appended
 * at the end of the document.
 */
export function foldNewSections(docText, items, { fileName = "<doc>" } = {}) {
  let lines = docText.split("\n");
  const groups = new Map(); // anchor key -> { item, blocks[] } in first-seen order
  for (const it of items) {
    const key = it.after != null ? `s:${it.after}#${it.occurrence ?? ""}` : it.afterLine != null ? `l:${it.afterLine}` : "end";
    if (!groups.has(key)) groups.set(key, { item: it, blocks: [] });
    groups.get(key).blocks.push(it.body);
  }
  for (const { item, blocks } of groups.values()) {
    const block = blocks.join("\n\n").split("\n");
    let at;
    if (item.after != null) {
      const sec = findUniqueSection(lines, item.after, fileName, item.occurrence ?? null);
      at = afterLastContent(lines, sec.start + 1, sec.end);
    } else if (item.afterLine != null) {
      const idx = findUniqueLine(lines, item.afterLine, fileName);
      at = idx + 1;
      const tail = lines[at] !== undefined && lines[at].trim() ? [""] : [];
      lines.splice(at, 0, "", ...block, ...tail);
      continue;
    } else {
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
      at = lines.length;
      lines.splice(at, 0, "", ...block, "");
      continue;
    }
    lines.splice(at, 0, "", ...block);
  }
  return lines.join("\n");
}

/**
 * version === null is the preview mode used by tests and the converter: the
 * changelog blocks join the Unreleased section in place and the fragment
 * files are kept.
 */
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

  const docs = [
    ["divergence", "divergence"],
    ["settings-en", "settings-en"],
    ["settings-ru", "settings-ru"],
  ];
  const sectionKey = { divergence: "divergence-section", "settings-en": "settings-section", "settings-ru": "settings-section" };
  for (const [doc] of docs) {
    const rel = DOC_FILES[doc];
    // 1. replace existing rows
    for (const f of fragments) {
      for (const e of f.edits.filter((x) => x.doc === doc && x.kind === "replace")) {
        edits.set(rel, foldReplaceRows(read(rel), { rows: e.body, section: e.directives.section ?? null, occurrence: e.directives.occurrence ? Number(e.directives.occurrence) : null }, { fileName: f.name }));
      }
    }
    // 2. rows appended to the section named in the front matter
    for (const f of fragments) {
      if (!f.sections[doc]) continue;
      edits.set(
        rel,
        foldTableRows(read(rel), {
          sectionHeading: f.meta[sectionKey[doc]],
          rows: f.sections[doc],
        }, { fileName: f.name }),
      );
    }
    // 3. prose / mixed blocks inside existing sections
    for (const f of fragments) {
      for (const e of f.edits.filter((x) => x.doc === doc && x.kind === "append")) {
        edits.set(
          rel,
          foldAppendBlock(read(rel), {
            body: e.body,
            section: e.directives.section ?? null,
            occurrence: e.directives.occurrence ? Number(e.directives.occurrence) : null,
            afterLine: e.directives["after-line"] ?? null,
          }, { fileName: f.name }),
        );
      }
    }
    // 4. new sections, grouped by anchor, fragments in file-name order
    const items = [];
    for (const f of fragments) {
      for (const e of f.edits.filter((x) => x.doc === doc && x.kind === "new")) {
        items.push({ body: e.body, after: e.directives.after ?? null, occurrence: e.directives.occurrence ? Number(e.directives.occurrence) : null, afterLine: e.directives["after-line"] ?? null, name: f.name });
      }
    }
    if (items.length > 0) {
      edits.set(rel, foldNewSections(read(rel), items, { fileName: items.map((i) => i.name).join(", ") }));
    }
  }

  result.changed = [...edits.keys()];
  result.deleted = version === null ? [] : fragments.map((f) => f.file);
  for (const [rel, text] of edits) {
    log(`update ${rel}`);
    if (!dryRun) fs.writeFileSync(path.join(root, rel), text);
  }
  if (version === null) return result;
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
