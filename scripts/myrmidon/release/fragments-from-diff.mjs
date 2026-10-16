#!/usr/bin/env node
// CHANGE-FRAGMENTS converter: turns the direct edits a branch made to the
// shared registry documents (CHANGELOG(.ru).md, DIVERGENCE.md,
// SETTINGS(.ru).md) into one change fragment (docs/myrmidon/changes/<slug>.md,
// format: docs/myrmidon/changes/README.md) and, with --revert, puts the shared
// documents back to the base version so the CI gate passes.
//
//   node scripts/myrmidon/release/fragments-from-diff.mjs --slug <slug>
//       [--base origin/main] [--head HEAD] [--root <dir>]
//       [--revert] [--dry-run] [--no-verify] [--force]
//
// The diff is merge-base(base, head)..head. Supported edits:
//   CHANGELOG(.ru)   inserted "### ..." blocks            -> changelog-en / -ru
//   DIVERGENCE / SETTINGS(.ru)
//     rows added after the last row of a table             -> divergence / settings-*
//     whole "##" sections added                            -> *-new
//     prose or prose+table added inside a section          -> *-append
//     one existing row rewritten (same first cell)         -> *-replace
// Anything else (an existing line edited or deleted, an entry bullet added to
// an existing changelog entry) is reported as unsupported and nothing is
// written: such an edit needs a human.
//
// After writing, the fragment is assembled onto the base documents in memory
// and compared with the head documents (--no-verify skips it). Result levels:
// "exact", "equal up to blank lines", "same lines, other position" (the
// fragment lands at the documented place instead of the original spot — a
// warning), anything else fails unless --force.
//
// Exit code: 0 ok / nothing to convert, 1 unsupported edit or failed
// verification, 2 usage. Node built-ins only.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collect, firstCell } from "./collect-fragments.mjs";

const FRAGMENTS_DIR = "docs/myrmidon/changes";
const DOCS = {
  "changelog-en": { rel: "docs/myrmidon/CHANGELOG.md", unreleased: "Unreleased" },
  "changelog-ru": { rel: "docs/myrmidon/CHANGELOG.ru.md", unreleased: "Без выпуска" },
  divergence: { rel: "docs/myrmidon/DIVERGENCE.md" },
  "settings-en": { rel: "docs/myrmidon/SETTINGS.md" },
  "settings-ru": { rel: "docs/myrmidon/SETTINGS.ru.md" },
};
const isRow = (l) => l.trimStart().startsWith("|");
const isBlank = (l) => !l.trim();

/** Parses `git diff -U0` output of one file into hunks. */
export function parseHunks(diffText) {
  const hunks = [];
  let cur = null;
  for (const line of diffText.split("\n")) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) {
      cur = {
        oldStart: Number(m[1]),
        oldCount: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newCount: m[4] === undefined ? 1 : Number(m[4]),
        removed: [],
        added: [],
      };
      hunks.push(cur);
    } else if (cur && line.startsWith("-")) cur.removed.push(line.slice(1));
    else if (cur && line.startsWith("+")) cur.added.push(line.slice(1));
  }
  return hunks;
}

function trimBlank(lines) {
  let a = 0;
  let b = lines.length;
  while (a < b && isBlank(lines[a])) a += 1;
  while (b > a && isBlank(lines[b - 1])) b -= 1;
  return lines.slice(a, b);
}

/** "## " heading lines outside code fences: [{ index, title }]. */
function headings(lines) {
  const out = [];
  let fence = false;
  lines.forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    if (!fence && /^## /.test(l)) out.push({ index: i, title: l.slice(3).trimEnd() });
  });
  return out;
}

/** Content lines of a block with headings of level >= 2 demoted by one (fence aware). */
function demote(lines) {
  let fence = false;
  return lines.map((l) => {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    return !fence && /^#{2,} /.test(l) ? `#${l}` : l;
  });
}

function hasTopLevelHeading(lines, from = 0) {
  let fence = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*(```|~~~)/.test(lines[i])) fence = !fence;
    if (!fence && i >= from && /^#{1,2} /.test(lines[i])) return true;
  }
  return false;
}

/**
 * Joins hunks that a diff split at a blank line: when only blank lines of the
 * head separate two hunks, they are one logical edit.
 */
export function mergeHunks(hunks, headLines) {
  const out = [];
  for (const h of hunks) {
    const prev = out[out.length - 1];
    if (prev) {
      const prevEnd = prev.newStart - 1 + prev.newCount;
      const gap = headLines.slice(prevEnd, h.newStart - 1);
      if (gap.length >= 0 && gap.every(isBlank) && h.newStart - 1 >= prevEnd) {
        prev.removed = [...prev.removed, ...h.removed];
        prev.oldCount += h.oldCount;
        prev.added = headLines.slice(prev.newStart - 1, h.newStart - 1 + h.newCount);
        prev.newCount = prev.added.length;
        continue;
      }
    }
    out.push({ ...h, removed: [...h.removed], added: [...h.added] });
  }
  return out;
}

/**
 * Classifies the edits of one document.
 * @param {string} docKey   key of DOCS
 * @param {string} baseText document at the merge base
 * @param {string} headText document at the branch head
 * @param {object[]} hunks  parseHunks() of the diff
 * @returns {{ changelog: string[], rows: object[], news: object[], appends: object[], replaces: object[], unsupported: string[], warnings: string[] }}
 */
export function classifyDoc(docKey, baseText, headText, hunks) {
  const base = baseText.split("\n");
  const head = headText.split("\n");
  const baseHeads = headings(base);
  const headHeads = headings(head);
  const res = { changelog: [], rows: [], news: [], appends: [], replaces: [], unsupported: [], warnings: [] };
  hunks = mergeHunks(hunks, head);
  const rel = DOCS[docKey].rel;
  const bad = (hunk, why) =>
    res.unsupported.push(`${rel}: base line ${hunk.oldStart}${hunk.oldCount > 1 ? `-${hunk.oldStart + hunk.oldCount - 1}` : ""} -> head line ${hunk.newStart}: ${why}`);
  const headingAbove = (headIdx) => {
    let found = null;
    for (const h of headHeads) if (h.index < headIdx) found = h;
    return found;
  };
  const baseCount = (title) => baseHeads.filter((h) => h.title === title).length;
  const headRank = (h) => headHeads.filter((x) => x.title === h.title && x.index < h.index).length;
  // occurrence number for a heading that is not unique in the base document
  const occOf = (h) => (baseCount(h.title) > 1 ? headRank(h) + 1 : null);
  const uniqueBaseLine = (text) => base.filter((l) => l.trimEnd() === text.trimEnd()).length === 1;

  for (const hunk of hunks) {
    const removed = trimBlank(hunk.removed);
    const added = trimBlank(hunk.added);
    // index of the first added line in head (0-based)
    const addStart = hunk.oldCount === 0 ? hunk.newStart - 1 : hunk.newStart - 1;
    const firstAdded = hunk.added.findIndex((l) => !isBlank(l));
    const insIdx = addStart + Math.max(firstAdded, 0);
    const lastIdx = insIdx + added.length - 1;

    if (removed.length > 0) {
      // one existing row rewritten
      if (
        docKey !== "changelog-en" && docKey !== "changelog-ru" &&
        removed.length === added.length &&
        removed.every((l, i) => isRow(l) && isRow(added[i]) && firstCell(l) !== null && firstCell(l) === firstCell(added[i]))
      ) {
        added.forEach((row, i) => {
          const key = firstCell(row);
          const inBase = base.filter((l) => isRow(l) && firstCell(l) === key).length;
          let section = null;
          let occurrence = null;
          if (inBase > 1) {
            const h = headingAbove(insIdx + i);
            if (!h) {
              bad(hunk, `row ${JSON.stringify(key)} is not unique in the document and sits outside any section`);
              return;
            }
            section = h.title;
            occurrence = occOf(h);
          }
          res.replaces.push({ section, occurrence, row });
        });
        continue;
      }
      bad(hunk, `edits or deletes existing text (${removed.length} line(s) removed: ${JSON.stringify(removed[0].slice(0, 50))})`);
      continue;
    }
    if (added.length === 0) continue; // blank-only change

    if (docKey === "changelog-en" || docKey === "changelog-ru") {
      if (!/^### \S/.test(added[0])) {
        bad(hunk, "added text does not start with a \"### Title\" line (a bullet added to an existing entry cannot be expressed as a fragment)");
        continue;
      }
      if (hasTopLevelHeading(added)) {
        bad(hunk, "added block contains a \"##\" heading");
        continue;
      }
      const h = headingAbove(insIdx);
      if (h && h.title !== DOCS[docKey].unreleased) {
        res.warnings.push(`${rel}: block "${added[0].slice(4, 60)}" was added under "## ${h.title}"; the fragment lands in the next release instead`);
      }
      res.changelog.push(added.join("\n"));
      continue;
    }

    const prev = insIdx > 0 ? head[insIdx - 1] : "";
    if (added.every(isRow) && isRow(prev)) {
      const h = headingAbove(insIdx);
      if (!h) {
        bad(hunk, "rows added outside any \"##\" section");
        continue;
      }
      res.rows.push({ section: h.title, occurrence: occOf(h), body: added.join("\n") });
      continue;
    }
    if (/^## \S/.test(added[0])) {
      if (hasTopLevelHeading(added, 1) && added.some((l, i) => i > 0 && /^# /.test(l))) {
        bad(hunk, "added block contains a level-1 heading");
        continue;
      }
      const h = headingAbove(insIdx);
      let anchor = null;
      if (h) anchor = { after: h.title, occurrence: occOf(h) };
      else {
        const p = [...Array(insIdx).keys()].reverse().find((i) => !isBlank(head[i]));
        if (p !== undefined && uniqueBaseLine(head[p])) anchor = { afterLine: head[p] };
      }
      if (!anchor) {
        bad(hunk, "new section placed where neither the previous heading nor the previous line is a unique anchor in the base document");
        continue;
      }
      res.news.push({ ...anchor, body: demote(added).join("\n") });
      continue;
    }
    if (hasTopLevelHeading(added)) {
      bad(hunk, "added block mixes prose with a \"##\" heading in the middle");
      continue;
    }
    // prose / mixed block inside an existing section
    const h = headingAbove(insIdx);
    let next = lastIdx + 1;
    while (next < head.length && isBlank(head[next])) next += 1;
    const atSectionEnd = next >= head.length || /^## /.test(head[next]);
    if (h && atSectionEnd) {
      res.appends.push({ section: h.title, occurrence: occOf(h), body: added.join("\n") });
      continue;
    }
    const p = [...Array(insIdx).keys()].reverse().find((i) => !isBlank(head[i]));
    if (p !== undefined && uniqueBaseLine(head[p]) && !added.every(isRow)) {
      res.appends.push({ afterLine: head[p], body: added.join("\n") });
      continue;
    }
    bad(hunk, "added text has no unique anchor (section heading or previous line) in the base document");
  }
  return res;
}

const dirOf = (kv) => Object.entries(kv).filter(([, v]) => v != null).map(([k, v]) => `<!-- ${k}: ${v} -->`);
// front-matter row sections address the first heading of that title only
const isFirst = (r) => r.occurrence == null || r.occurrence === 1;

/** Builds the fragment text from the per-document classifications. */
export function buildFragment(cls) {
  const meta = [];
  const out = [];
  const en = cls["changelog-en"];
  const ru = cls["changelog-ru"];
  const rowsFor = (key) => cls[key]?.rows ?? [];
  const firstSection = (key) => rowsFor(key)[0]?.section;
  const settingsSection = firstSection("settings-en") ?? firstSection("settings-ru");
  const divergenceSection = firstSection("divergence");
  if (divergenceSection) meta.push(`divergence-section: ${divergenceSection}`);
  if (settingsSection) meta.push(`settings-section: ${settingsSection}`);

  const section = (name, ...parts) => {
    out.push(`## ${name}`, "", ...parts.flatMap((p) => [p, ""]));
  };
  if (en?.changelog.length) section("changelog-en", en.changelog.join("\n\n"));
  if (ru?.changelog.length) section("changelog-ru", ru.changelog.join("\n\n"));

  for (const [key, rowSection] of [
    ["divergence", divergenceSection],
    ["settings-en", settingsSection],
    ["settings-ru", settingsSection],
  ]) {
    const c = cls[key];
    if (!c) continue;
    const mainRows = c.rows.filter((r) => r.section === rowSection && isFirst(r));
    const otherRows = c.rows.filter((r) => !(r.section === rowSection && isFirst(r)));
    if (mainRows.length) section(key, mainRows.map((r) => r.body).join("\n"));
    for (const r of otherRows) section(`${key}-append`, ...dirOf({ section: r.section, occurrence: r.occurrence }), r.body);
    for (const r of c.replaces) section(`${key}-replace`, ...dirOf({ section: r.section, occurrence: r.occurrence }), r.row);
    for (const r of c.appends) section(`${key}-append`, ...dirOf({ section: r.section, occurrence: r.occurrence, "after-line": r.afterLine }), r.body);
    for (const r of c.news) section(`${key}-new`, ...dirOf({ after: r.after, occurrence: r.occurrence, "after-line": r.afterLine }), r.body);
  }
  const head = meta.length ? ["---", ...meta, "---", ""] : [];
  return [...head, ...out].join("\n").replace(/\n+$/, "\n");
}

function normalizeBlank(text) {
  return text.replace(/\n{2,}/g, "\n").replace(/\n+$/, "");
}

/**
 * Assembles `fragmentText` onto `baseTexts` in memory (preview mode) and
 * compares with `headTexts`. Returns { level, details[] } where level is
 * "exact" | "blank" | "moved" | "different".
 */
export function verifyRoundTrip(baseTexts, headTexts, fragmentText) {
  const root = fs.mkdtempSync(path.join(process.env.FRAGMENT_TMPDIR ?? os.tmpdir(), "fragments-verify-"));
  try {
    for (const d of Object.values(DOCS)) {
      fs.mkdirSync(path.join(root, path.dirname(d.rel)), { recursive: true });
      fs.writeFileSync(path.join(root, d.rel), baseTexts[d.rel] ?? "");
    }
    fs.mkdirSync(path.join(root, FRAGMENTS_DIR), { recursive: true });
    fs.writeFileSync(path.join(root, FRAGMENTS_DIR, "converted.md"), fragmentText);
    collect(root, { version: null });
    let level = "exact";
    const details = [];
    const rank = { exact: 0, blank: 1, moved: 2, different: 3 };
    for (const d of Object.values(DOCS)) {
      const got = fs.readFileSync(path.join(root, d.rel), "utf8");
      const want = headTexts[d.rel] ?? "";
      let l;
      if (got === want) l = "exact";
      else if (normalizeBlank(got) === normalizeBlank(want)) l = "blank";
      else if (
        normalizeBlank(got).split("\n").sort().join("\n") === normalizeBlank(want).split("\n").sort().join("\n")
      ) l = "moved";
      else l = "different";
      if (l !== "exact") details.push(`${d.rel}: ${l}`);
      if (rank[l] > rank[level]) level = l;
    }
    return { level, details };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Pure core: base/head document texts (rel path -> text|null) and the hunks
 * per rel path -> { fragment | null, unsupported[], warnings[], verify }.
 */
export function convert(baseTexts, headTexts, hunksByRel, { verify = true } = {}) {
  const cls = {};
  const unsupported = [];
  const warnings = [];
  let any = false;
  for (const [key, d] of Object.entries(DOCS)) {
    const hunks = hunksByRel[d.rel] ?? [];
    if (hunks.length === 0) continue;
    if (baseTexts[d.rel] == null || headTexts[d.rel] == null) {
      unsupported.push(`${d.rel}: the file is added or removed by the branch`);
      continue;
    }
    cls[key] = classifyDoc(key, baseTexts[d.rel], headTexts[d.rel], hunks);
    unsupported.push(...cls[key].unsupported);
    warnings.push(...cls[key].warnings);
    const c = cls[key];
    if (c.changelog.length || c.rows.length || c.news.length || c.appends.length || c.replaces.length) any = true;
  }
  if (!any) return { fragment: null, unsupported, warnings, verify: null };
  if (unsupported.length) return { fragment: null, unsupported, warnings, verify: null };
  const fragment = buildFragment(cls);
  const v = verify ? verifyRoundTrip(baseTexts, headTexts, fragment) : null;
  return { fragment, unsupported, warnings, verify: v };
}

// --- git glue ---------------------------------------------------------------

const git = (root, args, opts = {}) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...opts });

function showOrNull(root, ref, rel) {
  try {
    return git(root, ["show", `${ref}:${rel}`], { stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

export function run(root, { slug, base = "origin/main", head = "HEAD", revert = false, dryRun = false, verify = true, force = false, log = console.log }) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug ?? "")) {
    throw new Error("--slug must be lowercase latin letters, digits and hyphens");
  }
  const mb = git(root, ["merge-base", base, head]).trim();
  const baseTexts = {};
  const headTexts = {};
  const hunksByRel = {};
  for (const d of Object.values(DOCS)) {
    baseTexts[d.rel] = showOrNull(root, mb, d.rel);
    headTexts[d.rel] = showOrNull(root, head, d.rel);
    const diff = git(root, ["diff", "-U0", "--no-color", "--no-ext-diff", `${mb}..${head}`, "--", d.rel]);
    hunksByRel[d.rel] = parseHunks(diff);
  }
  const r = convert(baseTexts, headTexts, hunksByRel, { verify });
  for (const w of r.warnings) log(`warning: ${w}`);
  if (r.unsupported.length) {
    for (const u of r.unsupported) log(`unsupported: ${u}`);
    log("nothing written: the edits above need a human (or the format needs to grow).");
    return 1;
  }
  if (!r.fragment) {
    log("no registry edits in the diff — nothing to convert");
    return 0;
  }
  if (r.verify) {
    log(`round trip: ${r.verify.level}${r.verify.details.length ? ` (${r.verify.details.join("; ")})` : ""}`);
    if (r.verify.level === "different" && !force) {
      log("round trip differs from the branch's own edit; nothing written (--force to write anyway)");
      return 1;
    }
  }
  const target = path.join(root, FRAGMENTS_DIR, `${slug}.md`);
  if (fs.existsSync(target) && !force) {
    log(`${path.join(FRAGMENTS_DIR, `${slug}.md`)} already exists (--force to overwrite)`);
    return 2;
  }
  if (dryRun) {
    log(r.fragment);
    return 0;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, r.fragment);
  log(`wrote ${path.join(FRAGMENTS_DIR, `${slug}.md`)}`);
  if (revert) {
    for (const d of Object.values(DOCS)) {
      const text = showOrNull(root, base, d.rel);
      if (text === null) continue;
      const file = path.join(root, d.rel);
      if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== text) {
        fs.writeFileSync(file, text);
        log(`reverted ${d.rel} to ${base}`);
      }
    }
  }
  return 0;
}

function main(argv) {
  const args = { root: process.cwd(), base: "origin/main", head: "HEAD", slug: null, revert: false, dryRun: false, verify: true, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case "--slug": args.slug = argv[++i]; break;
      case "--base": args.base = argv[++i]; break;
      case "--head": args.head = argv[++i]; break;
      case "--root": args.root = argv[++i]; break;
      case "--revert": args.revert = true; break;
      case "--dry-run": args.dryRun = true; break;
      case "--no-verify": args.verify = false; break;
      case "--force": args.force = true; break;
      default:
        console.error(`unknown argument: ${argv[i]}`);
        return 2;
    }
  }
  if (!args.slug) {
    console.error("usage: fragments-from-diff.mjs --slug <slug> [--base origin/main] [--head HEAD] [--root <dir>] [--revert] [--dry-run] [--no-verify] [--force]");
    return 2;
  }
  try {
    return run(args.root, args);
  } catch (err) {
    console.error(`fragments-from-diff: ${err.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
