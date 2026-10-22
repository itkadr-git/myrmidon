// server/src/myrmidon/knowledge/migrate/links.ts
//
// myrmidon(1.6.6 KNOWLEDGE-2.0 K-6): the plugin's `[[…]]` links are paths into
// the plugin tree; knowledge links are slugs. The migration rewrites the link
// targets through the operator's map and counts how many resolved — §5.3 wants
// ≥ 90 % resolved and the unresolved targets listed in the report.

/** One link occurrence found in a page. */
export interface LinkOccurrence {
  /** The raw target as written (alias and anchor stripped). */
  target: string;
  /** The alias/anchor text that must be preserved verbatim. */
  suffix: string;
}

const LINK_RE = /\[\[([^[\]\n]+)\]\]/g;

/** Splits `target|alias#anchor` into the target and the preserved suffix. */
export function splitLinkTarget(raw: string): LinkOccurrence | null {
  const pipeIndex = raw.indexOf("|");
  const head = pipeIndex >= 0 ? raw.slice(0, pipeIndex) : raw;
  const suffix = pipeIndex >= 0 ? raw.slice(pipeIndex) : "";
  const hashIndex = head.indexOf("#");
  const target = (hashIndex >= 0 ? head.slice(0, hashIndex) : head).trim();
  const anchor = hashIndex >= 0 ? head.slice(hashIndex) : "";
  if (target === "") return null;
  return { target, suffix: `${anchor}${suffix}` };
}

export function findLinks(content: string): LinkOccurrence[] {
  const found: LinkOccurrence[] = [];
  for (const match of content.matchAll(LINK_RE)) {
    const occurrence = splitLinkTarget(match[1]!);
    if (occurrence !== null) found.push(occurrence);
  }
  return found;
}

export interface LinkRewriteResult {
  content: string;
  /** Total link occurrences seen. */
  total: number;
  /** Occurrences whose target resolved to a knowledge slug. */
  resolved: number;
  /** Unique unresolved targets, in first-seen order. */
  unresolved: string[];
}

/**
 * Rewrites `[[…]]` targets through `resolve`. Unresolved targets stay exactly
 * as written (no guessing) and are reported, so the operator can extend the
 * map — §5.3 forbids inventing links.
 */
export function rewriteLinks(content: string, resolve: (target: string) => string | null): LinkRewriteResult {
  let total = 0;
  let resolved = 0;
  const unresolved: string[] = [];
  const rewritten = content.replace(LINK_RE, (whole: string, raw: string) => {
    const occurrence = splitLinkTarget(raw);
    if (occurrence === null) return whole;
    total += 1;
    const slug = resolve(occurrence.target);
    if (slug === null) {
      if (!unresolved.includes(occurrence.target)) unresolved.push(occurrence.target);
      return whole;
    }
    resolved += 1;
    return `[[${slug}${occurrence.suffix}]]`;
  });
  return { content: rewritten, total, resolved, unresolved };
}

export function resolvedPercent(resolved: number, total: number): number {
  if (total === 0) return 100;
  return Math.round((resolved / total) * 1000) / 10;
}