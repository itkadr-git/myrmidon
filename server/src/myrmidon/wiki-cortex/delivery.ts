// server/src/myrmidon/wiki-cortex/delivery.ts
//
// myrmidon(1.6-WIKI): how an approved regulation reaches an agent.
//
// The fleet runs in container bots whose profile is compiled on every reconcile
// tick (bot-containers/profile-compile.ts). The profile is where the rest of an
// agent's context already lands, so the approved regulations for the agent's
// role are delivered there as one extra workspace file. The compile is
// deterministic and its hash decides whether a bot restarts, so the file is
// built from the resolver alone: same approved revisions — same bytes — no
// restart; a newly approved revision changes the hash and the bot picks the new
// text up on its next run.
//
// A delivered file never overwrites the agent's own bundle: when the bundle
// already ships a REGULATIONS.md, that one wins and the compile reports why.

import { resolvedRules, type ResolvedRule, type RulesReadPort } from "../knowledge/rules.js";
import { REGULATIONS_WORKSPACE_FILE, renderRegulationsMarkdown } from "./render.js";
import type { ApprovedRegulation } from "./types.js";

/** The shape the profile compiler takes for a workspace file. */
export interface RegulationWorkspaceFile {
  path: string;
  content: string;
}

/** Just the resolver half of the service, so delivery can be faked in tests. */
export interface RegulationResolver {
  resolved(companyId: string, role: string): Promise<ApprovedRegulation[]>;
}

/**
 * myrmidon(1.6.6 KNOWLEDGE-2.0 K-3): the carrier the fleet reads is the
 * knowledge module — `knowledge.rules.resolved(nest, caste)`, one nest per
 * company today (`nestId === companyId`) — not the wiki tables. The adapter
 * keeps the resolver contract the profile compile already speaks, so the
 * delivery path did not have to change shape: it asks by company and caste and
 * gets the approved `kind=rule` items of that caste, with the sources of the
 * delivered revision for the `Source:`/`Provenance:` lines.
 */
export function createKnowledgeRegulationResolver(read: RulesReadPort & { companyId: string }): RegulationResolver {
  return {
    async resolved(companyId: string, role: string): Promise<ApprovedRegulation[]> {
      if (companyId !== read.companyId) return [];
      const rules = await resolvedRules(read, role);
      return rules.map(approvedRegulationFromRule);
    },
  };
}

/**
 * One resolved rule as the delivery path reads it: `version` is the number the
 * text came from, and `pageId` equals the `slug` — the knowledge page id is the
 * slug (K-3 criterion "wikiPageId = slug").
 */
export function approvedRegulationFromRule(rule: ResolvedRule): ApprovedRegulation {
  return {
    pageId: rule.pageId,
    slug: rule.slug,
    title: rule.title,
    content: rule.content,
    version: rule.revisionNumber,
    roles: rule.roles,
    sources: rule.sources,
  };
}

export interface RegulationDeliveryTarget {
  companyId: string;
  /** The agent's role key; the fleet's agents default to `general`. */
  role?: string | null;
}

export const DEFAULT_AGENT_ROLE = "general";

export interface RegulationDelivery {
  files: RegulationWorkspaceFile[];
  warnings: string[];
}

/**
 * The workspace files an agent's profile gets from the wiki. No approved
 * regulation for the role means no file at all — an instance that never writes
 * a regulation keeps byte-identical profiles.
 */
export async function loadRegulationWorkspaceFiles(
  resolver: RegulationResolver,
  target: RegulationDeliveryTarget,
  options: { takenPaths?: readonly string[] } = {},
): Promise<RegulationDelivery> {
  const role = (target.role ?? "").trim() || DEFAULT_AGENT_ROLE;
  const regulations = await resolver.resolved(target.companyId, role);
  if (regulations.length === 0) return { files: [], warnings: [] };

  const taken = new Set((options.takenPaths ?? []).map((path) => path.toLowerCase()));
  if (taken.has(REGULATIONS_WORKSPACE_FILE.toLowerCase())) {
    return {
      files: [],
      warnings: [
        `regulations: the instructions bundle already contains ${REGULATIONS_WORKSPACE_FILE}; the wiki text was not delivered to this agent`,
      ],
    };
  }
  return {
    files: [{ path: REGULATIONS_WORKSPACE_FILE, content: renderRegulationsMarkdown(regulations) }],
    warnings: [],
  };
}