// server/src/myrmidon/wiki-cortex/render.ts
//
// myrmidon(1.6-WIKI): the delivered form of the approved rules.
// myrmidon(1.6.6 KNOWLEDGE-2.0 K-3): the rules come from the knowledge module
// (`kind=rule`) now, so every section names the page it was read from — the
// `Source:` line — and the provenance the revision carries (§3.2: a delivered
// claim travels with its source). `Source: <slug> · revision <n>` is exactly
// the `wikiPageId` the old carrier kept: the slug is the page id.
//
// The same input must always render byte-for-byte the same text: the container
// profile's hash is what decides whether a bot restarts, so a renderer that
// reorders or adds a timestamp would restart the whole fleet on every tick.
// Same approved revisions — same bytes, no exceptions (§6 K-3 criterion).

import type { ApprovedRegulation } from "./types.js";

/** Workspace file the approved regulations are delivered in. */
export const REGULATIONS_WORKSPACE_FILE = "REGULATIONS.md";

/** `kind:ref` of one provenance record, as the section prints it. */
function sourceLabel(source: ApprovedRegulation["sources"][number]): string {
  return `${source.kind}:${source.ref}`;
}

export function renderRegulationsMarkdown(regulations: readonly ApprovedRegulation[]): string {
  const lines: string[] = [
    "# Company regulations (approved)",
    "",
    "The company keeps its rules in the knowledge module. The texts below are the approved",
    "revisions that apply to your caste; they are the current rules of the company, not a",
    "suggestion. A draft or an edit that is not approved yet is not delivered here — treat the",
    "text below as the rules in force. Each section names the page it was read from, so you can",
    "ask the knowledge module for the page itself.",
    "",
  ];
  for (const regulation of regulations) {
    lines.push(`## ${regulation.title}`, "");
    lines.push(`Source: ${regulation.slug} · revision ${regulation.version}`, "");
    if (regulation.sources.length > 0) {
      lines.push(`Provenance: ${regulation.sources.map(sourceLabel).join(", ")}`, "");
    }
    lines.push(regulation.content.trim(), "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}