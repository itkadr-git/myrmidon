#!/usr/bin/env node
/**
 * scripts/myrmidon/build-wiki-guides.mjs
 *
 * OPE-12620: move the deep-dive guides from docs/myrmidon/guides/ into the
 * wiki sources (docs/wiki/) as standalone EN/RU pages, without rewriting the
 * guide texts themselves.
 *
 * What the transform does per file:
 *  1. Renames to the wiki convention: `kebab-base.md` -> `Kebab-base.md`,
 *     `kebab-base.ru.md` -> `Kebab-base.ru.md`, and strips the legacy
 *     `.en` infix (`foraging-idle-gate.en.md` -> `Foraging-idle-gate.md`).
 *  2. Rewrites links:
 *     - `<guide>.md` / `<guide>.en.md` / `<guide>.ru.md` that resolve to a
 *       transferred guide become wiki page links (`Base`, `Base.ru`);
 *     - every other repo-internal link (`../SETTINGS.md`, `changes/…`,
 *       `assets/…`) becomes an absolute blob link pinned to the same commit
 *       the wiki was synced from (`$WIKI_SYNC_SHA`, default `main`);
 *     - `http(s)`, `mailto:` and `#…` links pass through unchanged.
 *  3. Swaps the "Russian version:" pointer line for the wiki lang switch
 *     (`> Русская версия: [Base.ru](Base.ru)`), matching the existing pages.
 *  4. Normalizes relative image links in the one guide that embeds images
 *     (github-shared-identity) to blob URLs.
 *
 * Source files in docs/myrmidon/guides/ are not modified.
 * Idempotent: running twice changes nothing.
 *
 * Usage: node scripts/myrmidon/build-wiki-guides.mjs [--from DIR] [--out DIR]
 *        [--only base1,base2] [--sha <sha>] [--check]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const args = process.argv.slice(2);
function argValue(name, fallback) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}
const srcDir = path.resolve(repoRoot, argValue("--from", "docs/myrmidon/guides"));
const outDir = path.resolve(repoRoot, argValue("--out", "docs/wiki"));
const sha = argValue("--sha", "main");
const only = argValue("--only");
const check = args.includes("--check");
const onlySet = only
  ? new Set(
      only
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    )
  : null;

const BLOB = `https://github.com/itkadr-git/myrmidon/blob/${sha}`;
const EN_SUFFIX = ".md";
const RU_SUFFIX = ".ru.md";

/** kebab-case file base -> wiki page base (`Kebab-case`, `.en` infix dropped). */
function wikiBase(base) {
  if (base.endsWith(".en")) base = base.slice(0, -3);
  return base.slice(0, 1).toUpperCase() + base.slice(1);
}

const entries = fs.readdirSync(srcDir).filter((f) => f.endsWith(".md"));
const allBases = new Set(
  entries.map((f) =>
    f.endsWith(RU_SUFFIX) ? f.slice(0, -RU_SUFFIX.length) : f.slice(0, -3)
  )
);

/** A relative `.md` link that resolves to a transferred guide. */
function guideLink(target, fromDir) {
  if (!/^[A-Za-z0-9_./-]+\.md$/.test(target)) return null;
  const resolved = path.posix.normalize(
    path.posix.join(
      path.posix.dirname(path.posix.relative(path.dirname(outDir === srcDir ? srcDir : srcDir), fromDir) || ".", target)
    )
  );
  return null; // placeholder, real resolution below
}

/**
 * Resolve a relative link the way the markdown renderer would from a file in
 * the guides directory, and classify it.
 */
function classifyLink(target) {
  if (
    /^https?:\/\//.test(target) ||
    /^#/.test(target) ||
    /^mailto:/i.test(target)
  ) {
    return { kind: "keep", target };
  }
  const m = target.match(/^([A-Za-z0-9_-]+?)(\.en)?(\.ru)?\.md$/);
  if (m && allBases.has(m[1])) {
    const ru = m[3] ? ".ru" : "";
    return { kind: "wiki", target: wikiBase(m[1]) + ru };
  }
  return { kind: "blob", target: `${BLOB}/docs/myrmidon/${path.posix.normalize(`guides/${target}`)}` };
}

const LINK = /\[([^\]]*)\]\(([^)\s]+)\)/g;
const IMAGE = /(!\[[^\]]*\]\()([^)\s]+)(\))/g;

function rewriteLinks(text, selfBase) {
  // inter-guide relative .md links: relative to the guides dir
  text = text.replace(IMAGE, (whole, pre, target, post) => {
    if (/^https?:\/\//.test(target)) return whole;
    const fixed = path.posix.normalize(`docs/myrmidon/guides/${target}`);
    return `${pre}${BLOB}/${fixed}${post}`;
  });
  text = text.replace(LINK, (whole, label, target) => {
    const c = classifyLink(target);
    if (c.kind === "keep") return whole;
    return `[${label}](${c.target})`;
  });
  return text;
}

/** Swap the guide's language-pointer blockquote for the wiki lang switch. */
function rewriteLangSwitch(text, selfBase, isRu) {
  const other = isRu ? selfBase : `${selfBase}.ru`;
  const wikiOther = wikiBase(selfBase) + (isRu ? "" : ".ru");
  const label = isRu ? "English version" : "Русская версия";
  // remove any existing pointer line(s)
  const lines = text.split("\n");
  const out = [];
  let inserted = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const isPtr =
      /^> (Russian version|Русская версия|Английская версия|English version):/.test(
        line
      );
    if (isPtr) {
      if (!inserted) {
        out.push(`> ${label}: [${wikiBase(selfBase) + (isRu ? "" : ".ru")}](${wikiOther})`);
        inserted = true;
      }
      // drop follow-up continuation lines of a wrapped pointer (> … not new block)
      continue;
    }
    out.push(line);
  }
  let res = out.join("\n");
  if (!inserted) {
    // no pointer existed: insert one after the title line
    const m = res.match(/^# .+\n/);
    const insert = `> ${label}: [${wikiBase(selfBase) + (isRu ? "" : ".ru")}](${wikiOther})\n\n`;
    if (m) {
      res = res.replace(m[0], `${m[0]}\n${insert}`);
    } else {
      res = `${insert}\n${res}`;
    }
  }
  return res;
}

function convertOne(name) {
  const isRu = name.endsWith(RU_SUFFIX);
  const base = isRu ? name.slice(0, -RU_SUFFIX.length) : name.slice(0, -3);
  const text = fs.readFileSync(path.join(srcDir, name), "utf8");
  let out = rewriteLinks(text, base);
  out = rewriteLangSwitch(out, base, isRu);
  return { name: `${wikiBase(base)}${isRu ? RU_SUFFIX : EN_SUFFIX}`, text: out };
}

const files = entries.filter((name) => {
  if (onlySet) {
    const base = name.endsWith(RU_SUFFIX)
      ? name.slice(0, -RU_SUFFIX.length)
      : name.slice(0, -3);
    return onlySet.has(base);
  }
  return true;
});

const results = [];
let changes = 0;
for (const name of files.sort()) {
  const { name: outName, text } = convertOne(name);
  const outPath = path.join(outDir, outName);
  const existing = fs.existsSync(outPath)
    ? fs.readFileSync(outPath, "utf8")
    : null;
  if (existing !== text) changes += 1;
  if (!check) fs.writeFileSync(outPath, text);
  results.push({ src: name, out: outName, changed: existing !== text });
}

for (const r of results) {
  if (r.changed) console.log(`${r.src} -> docs/wiki/${r.out}`);
}
console.log(
  check
    ? `build-wiki-guides: ${changes} file(s) differ (--check)`
    : `build-wiki-guides: wrote ${results.length} page(s), ${changes} changed`
);
if (check && changes > 0) process.exit(1);
