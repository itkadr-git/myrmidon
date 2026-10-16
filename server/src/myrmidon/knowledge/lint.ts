// myrmidon(1.7 KNOWLEDGE-2.0 L-7): deterministic, database-free knowledge audit.

import { extractLinkTargets, normalizeLinkTarget } from "./domain.js";
import type { KnowledgeItemStatus } from "@paperclipai/db";

export interface KnowledgeLintSource {
  kind: string;
  ref: string;
}

export interface KnowledgeLintPage {
  slug: string;
  status: KnowledgeItemStatus;
  content: string;
  sources: KnowledgeLintSource[];
}

export type KnowledgeLintFindingKind = "unresolved_link" | "orphan" | "missing_source";

export interface KnowledgeLintFinding {
  kind: KnowledgeLintFindingKind;
  slug: string;
  target?: string;
  suggestion: string;
}

export interface KnowledgeLintReport {
  findings: KnowledgeLintFinding[];
  counts: Record<KnowledgeLintFindingKind, number>;
}

/**
 * Audits the delivered knowledge snapshot without consulting the database or
 * an LLM. Findings are stable because pages and links are sorted before use.
 */
export function lintKnowledgePages(pages: readonly KnowledgeLintPage[]): KnowledgeLintReport {
  const published = pages.filter((page) => page.status === "published");
  const bySlug = new Set(published.map((page) => page.slug));
  const inbound = new Set<string>();
  const findings: KnowledgeLintFinding[] = [];

  for (const page of [...published].sort((a, b) => a.slug.localeCompare(b.slug))) {
    const links = extractLinkTargets(page.content).sort((a, b) => a.localeCompare(b));
    for (const target of links) {
      if (bySlug.has(target)) {
        inbound.add(target);
      } else {
        findings.push({
          kind: "unresolved_link",
          slug: page.slug,
          target,
          suggestion: `Create a published page for [[${target}]] or remove the link.`,
        });
      }
    }

    if (page.sources.length === 0) {
      findings.push({
        kind: "missing_source",
        slug: page.slug,
        suggestion: "Attach at least one source reference before relying on this page.",
      });
    }
  }

  for (const page of [...published].sort((a, b) => a.slug.localeCompare(b.slug))) {
    if (!inbound.has(page.slug)) {
      findings.push({
        kind: "orphan",
        slug: page.slug,
        suggestion: "Add an inbound [[link]] from a related page or mark this page archived.",
      });
    }
  }

  const counts: Record<KnowledgeLintFindingKind, number> = {
    unresolved_link: 0,
    orphan: 0,
    missing_source: 0,
  };
  for (const finding of findings) counts[finding.kind] += 1;
  return { findings, counts };
}

/** Used by callers validating user-entered links before storing them. */
export function lintLinkTarget(raw: string): string | null {
  return normalizeLinkTarget(raw);
}
