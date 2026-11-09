#!/usr/bin/env node
/**
 * check-wiki-parity.mjs
 * Verifies that docs/wiki stays in RU/EN parity:
 *   (a) every docs/wiki/X.md has a docs/wiki/X.ru.md counterpart and vice versa;
 *   (b) the number of `##` and `###` headings in each pair matches
 *       (order and wording are not compared — a translation is free to
 *       rephrase, as long as the section structure is preserved);
 *   (c) the EN-only and RU-only lists are both empty.
 *
 * Export: checkWikiPair(fileName, enContent, ruContent) → per-pair result
 *         checkWikiParity({ enFiles, ruFiles, readFile }) → aggregate result
 */
import { fileURLToPath } from 'node:url';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const EN_SUFFIX = '.md';
const RU_SUFFIX = '.ru.md';

/** Strip a trailing suffix from a file name, if present. */
function stripSuffix(name, suffix) {
  return name.endsWith(suffix) ? name.slice(0, name.length - suffix.length) : null;
}

/** True when the line is a `##` or `###` heading (not `#` title, not `####+`). */
function isTrackedHeading(line) {
  return /^###?[^#]/.test(line) || /^###?$/.test(line);
}

/**
 * Count `##` and `###` headings outside fenced code blocks. Headings inside
 * code samples are content, not document structure, so a snippet pasted
 * into a page must not perturb the parity check.
 */
export function countHeadings(content) {
  let h2 = 0;
  let h3 = 0;
  let fence = null;
  for (const line of content.split('\n')) {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (fence && fence.char === marker) {
        fence = null;
      } else if (!fence) {
        fence = { char: marker };
      }
      continue;
    }
    if (fence) continue;
    if (!isTrackedHeading(line)) continue;
    if (line.startsWith('###')) h3 += 1;
    else h2 += 1;
  }
  return { h2, h3 };
}

/**
 * Classify docs/wiki file names into EN pages, RU pages, and unpaired leftovers.
 * Returns { en: string[] (base names), ru: string[] (base names), stray: string[] }.
 */
export function classifyWikiFiles(fileNames) {
  const en = [];
  const ru = [];
  const stray = [];
  for (const name of fileNames) {
    if (!name.endsWith(EN_SUFFIX)) {
      stray.push(name);
      continue;
    }
    const ruBase = stripSuffix(name, RU_SUFFIX);
    if (ruBase !== null) {
      ru.push(ruBase);
      continue;
    }
    const enBase = stripSuffix(name, EN_SUFFIX);
    en.push(enBase);
  }
  return { en, ru, stray };
}

/**
 * Compare one EN/RU pair's heading counts.
 * Returns { ok: boolean, failures: string[] }.
 */
export function checkWikiPair(base, enContent, ruContent) {
  const failures = [];
  const enCounts = countHeadings(enContent ?? '');
  const ruCounts = countHeadings(ruContent ?? '');
  if (enCounts.h2 !== ruCounts.h2) {
    failures.push(
      `${base}: ## count mismatch — EN has ${enCounts.h2}, RU has ${ruCounts.h2}`
    );
  }
  if (enCounts.h3 !== ruCounts.h3) {
    failures.push(
      `${base}: ### count mismatch — EN has ${enCounts.h3}, RU has ${ruCounts.h3}`
    );
  }
  return { ok: failures.length === 0, failures, enCounts, ruCounts };
}

/**
 * Aggregate parity check.
 * deps: {
 *   enFiles: string[]      base names present in EN (no .md suffix)
 *   ruFiles: string[]      base names present in RU
 *   readFile(base, lang)   → string content ('en' | 'ru'); missing file → null
 * }
 */
export function checkWikiParity({ enFiles, ruFiles, readFile }) {
  const failures = [];
  const enSet = new Set(enFiles);
  const ruSet = new Set(ruFiles);

  const enOnly = enFiles.filter(b => !ruSet.has(b)).sort();
  const ruOnly = ruFiles.filter(b => !enSet.has(b)).sort();

  for (const base of enOnly) {
    failures.push(`${base}: EN page exists but RU counterpart ${base}.ru.md is missing`);
  }
  for (const base of ruOnly) {
    failures.push(`${base}.ru.md: RU page exists but EN counterpart ${base}.md is missing`);
  }

  const paired = enFiles.filter(b => ruSet.has(b)).sort();
  for (const base of paired) {
    const enContent = readFile(base, 'en');
    const ruContent = readFile(base, 'ru');
    if (enContent === null) {
      failures.push(`${base}: EN file unreadable`);
      continue;
    }
    if (ruContent === null) {
      failures.push(`${base}.ru.md: RU file unreadable`);
      continue;
    }
    const pair = checkWikiPair(base, enContent, ruContent);
    for (const f of pair.failures) failures.push(f);
  }

  return {
    passed: failures.length === 0,
    failures,
    enOnly,
    ruOnly,
    pairedCount: paired.length,
  };
}

/** Scan a docs/wiki directory on disk and run the parity check. */
export function checkWikiDir(wikiDir) {
  const entries = readdirSync(wikiDir).filter(name => {
    try {
      return statSync(join(wikiDir, name)).isFile();
    } catch {
      return false;
    }
  });
  const { en, ru } = classifyWikiFiles(entries);
  return checkWikiParity({
    enFiles: en,
    ruFiles: ru,
    readFile(base, lang) {
      const name = lang === 'ru' ? `${base}${RU_SUFFIX}` : `${base}${EN_SUFFIX}`;
      try {
        return readFileSync(join(wikiDir, name), 'utf8');
      } catch {
        return null;
      }
    },
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const wikiDir = process.argv[2] ?? 'docs/wiki';
  const result = checkWikiDir(wikiDir);
  if (result.passed) {
    console.log(
      `wiki parity OK: ${result.pairedCount} EN/RU pairs, no unpaired pages.`
    );
    process.exit(0);
  }
  console.error('wiki parity check FAILED:');
  for (const f of result.failures) console.error(`  - ${f}`);
  if (result.enOnly.length) {
    console.error(`EN-only pages: ${result.enOnly.join(', ')}`);
  }
  if (result.ruOnly.length) {
    console.error(`RU-only pages: ${result.ruOnly.join(', ')}`);
  }
  process.exit(1);
}
