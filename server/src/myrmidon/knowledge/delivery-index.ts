// server/src/myrmidon/knowledge/delivery-index.ts
//
// myrmidon(1.7 KNOWLEDGE-2.0 L-3, §3.7): the `KNOWLEDGE_INDEX.md` side of the
// knowledge delivery. The agent's package already carries the rule texts in
// `REGULATIONS.md` (wiki-cortex delivery, 1.6-WIKI). This file renders the
// COMPANION file: a compact pointer list over the knowledge pages marked
// `deliver_to_castes` for the agent's caste — slug, title, one-phrase summary
// — plus the instruction to read the page bodies through the knowledge MCP
// tools. Page bodies never enter the prompt: the index is the address book,
// the bodies stay in the knowledge module.
//
// The compile must stay deterministic (the bot profile hash changes only when
// the content changes): same inputs → byte-for-byte the same file, no clocks,
// no map iteration order leaks.

/**
 * Minimal page shape the index reads. Structurally satisfied by the knowledge
 * module's tree pages and by store rows mapped to the delivery shape — the
 * compiler passes rows without importing the store.
 */
export interface KnowledgeIndexPageInput {
  slug: string;
  title: string;
  summary: string | null;
  kind: string;
  status: string;
  /** `["*"]` = every caste; empty = not delivered to any package. */
  deliverToCastes: readonly string[];
}

/** The caste key meaning "every caste of the company" (same as ANY_ROLE). */
export const ANY_CASTE = "*";

export interface KnowledgeIndexEntry {
  slug: string;
  title: string;
  summary: string | null;
  kind: string;
}

export interface KnowledgeIndexInput {
  /** The caste the agent belongs to (agent card → caste; null = no caste). */
  caste: string | null;
  /**
   * Published knowledge pages to pick from. Rules go to REGULATIONS.md and are
   * not repeated in the index unless they are explicitly marked deliverable.
   */
  pages: readonly KnowledgeIndexPageInput[];
}

/** One phrase per page; empty summaries render as "(no summary)". */
function indexLine(entry: KnowledgeIndexEntry): string {
  const summary = entry.summary && entry.summary.trim().length > 0 ? entry.summary.trim() : "(no summary)";
  return `- \`${entry.slug}\` — ${entry.title} — ${summary}`;
}

/** A page is delivered when its `deliver_to_castes` includes the caste or `*`. */
export function pageAppliesToCastes(deliverToCastes: readonly string[], caste: string | null): boolean {
  if (deliverToCastes.length === 0) return false;
  if (caste === null) return false;
  return deliverToCastes.includes(ANY_CASTE) || deliverToCastes.includes(caste);
}

/**
 * The pages the agent's package should point at: published only, marked
 * `deliver_to_castes` for the agent's caste (or `*`), sorted by slug.
 */
export function selectIndexPages(input: KnowledgeIndexInput): KnowledgeIndexEntry[] {
  return input.pages
    .filter((page) => page.status === "published")
    .filter((page) => pageAppliesToCastes(page.deliverToCastes, input.caste))
    .sort((left, right) => (left.slug < right.slug ? -1 : left.slug > right.slug ? 1 : 0))
    .map((page) => ({
      slug: page.slug,
      title: page.title,
      summary: page.summary,
      kind: page.kind,
    }));
}

/**
 * Renders `KNOWLEDGE_INDEX.md`. Deterministic: sorted entries, fixed wording,
 * no timestamps. `rulesCount` is the number of rule texts in the package's
 * `REGULATIONS.md` so the index can remind the agent the rules are already in
 * context; it is not itself a pointer.
 */
export function renderKnowledgeIndex(input: KnowledgeIndexInput & { rulesCount: number }): string {
  const entries = selectIndexPages(input);
  const lines: string[] = [];
  lines.push("# KNOWLEDGE_INDEX");
  lines.push("");
  if (input.rulesCount > 0) {
    lines.push(`This package includes ${input.rulesCount} company rule(s) in REGULATIONS.md — they apply to you directly.`);
    lines.push("");
  }
  if (entries.length === 0) {
    lines.push("No additional knowledge pages are assigned to this agent.");
    lines.push("");
    return lines.join("\n");
  }
  lines.push("Additional knowledge pages assigned to this agent (slug — title — what it covers):");
  lines.push("");
  for (const entry of entries) {
    lines.push(indexLine(entry));
  }
  lines.push("");
  lines.push(
    "Read a page when its topic comes up: use the knowledge tools available in your environment (`wiki_read_page` / `wiki_search` today; the native knowledge tools replace them in K-6). Do not guess page contents from this list.",
  );
  lines.push("");
  return lines.join("\n");
}
