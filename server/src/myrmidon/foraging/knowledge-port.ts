// server/src/myrmidon/foraging/knowledge-port.ts
//
// myrmidon(1.7-KNOWLEDGE-L5): the FORAGING → KNOWLEDGE seam. The finding no
// longer becomes a skill candidate directly (§5.2: "candidate_ref → id
// knowledge_proposal; the port creates a proposal, not a skill candidate
// right away"). The port turns one finding into ONE knowledge suggestion:
//
//  - `trust=external` always — the only source of a foraged claim is a
//    foreign url; the suggestion row carries the url as `source_ref`
//    (sourceKind `url`).
//  - the foreign TEXT never enters knowledge: the fetched page text is
//    quarantined in the `foraging-inbox` corpus dataset (one document per
//    finding, metadata {findingId, sourceId, role, url}); knowledge receives
//    only OUR retelling (summary + bounded diff) with the url as source.
//  - no auto-accept, ever (§4.5): the suggestion stays `pending` for the
//    review side.
//
// The returned string is the suggestion id and lands in
// `foraging_findings.candidate_ref` through the existing sweep code.
//
// Every failure is caught and answered with `null` — the finding then stays
// `unverified` and the sweep continues (the same contract as candidate-port).

import { and, eq } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import { corpusDatasets, corpusDocuments } from "@myrmidon/db";
import type { KnowledgeModule } from "../knowledge/service.js";
import type { ForagingCandidateInput, ForagingCandidatePort } from "./domain.js";

/** The fixed quarantine dataset name (§4.5); unique per company by schema. */
export const FORAGING_INBOX_DATASET = "foraging-inbox";

/** The retelling cap: a suggestion body stays one bounded paragraph. */
const BODY_LIMIT = 2000;
/** How much quarantined page text one document keeps (bytes, capped). */
const QUARANTINE_TEXT_LIMIT = 64 * 1024;

/** The knowledge-side retelling of a finding: one line, our words, the url cited. */
export function buildProposalBody(input: ForagingCandidateInput): string {
  const parts: string[] = [`[foraging:${input.role}] ${input.summary}`, `Source (external, untrusted): ${input.url}`];
  if (input.diff.added.length > 0) {
    parts.push(`Added: ${input.diff.added.slice(0, 6).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean).join(" | ")}`);
  }
  if (input.diff.removed.length > 0) {
    parts.push(`Removed: ${input.diff.removed.slice(0, 6).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean).join(" | ")}`);
  }
  const body = parts.join(" — ").replace(/\s+/g, " ").trim();
  return body.length > BODY_LIMIT ? `${body.slice(0, BODY_LIMIT - 1)}…` : body;
}

/** The markdown one quarantined document holds: the raw external page lines. */
export function buildQuarantineMarkdown(input: ForagingCandidateInput, pageLines: readonly string[]): string {
  const lines = [
    `# Foraging finding (quarantine)`,
    ``,
    `url: ${input.url}`,
    `role: ${input.role}`,
    `skillKey: ${input.skillKey}`,
    `detectedAt: ${input.detectedAt.toISOString()}`,
    `summary: ${input.summary}`,
    ``,
    `## Captured page lines`,
    ``,
    ...pageLines.slice(0, 400).map((line) => line),
  ];
  const text = lines.join("\n");
  return text.length > QUARANTINE_TEXT_LIMIT ? text.slice(0, QUARANTINE_TEXT_LIMIT) : text;
}

/** The narrow corpus surface the port needs (rows of `corpus_datasets/documents`). */
export interface ForagingQuarantineStore {
  findDatasetByName(companyId: string, name: string): Promise<{ id: string } | null>;
  createDataset(input: { companyId: string; name: string; description: string }): Promise<{ id: string }>;
  createDocument(input: {
    companyId: string;
    datasetId: string;
    title: string;
    sourceUri: string;
    contentType: string;
    markdown: string;
    metadata: Record<string, unknown>;
  }): Promise<string>;
}

/** The pg implementation of the quarantine store (additive rows only). */
export function createDbForagingQuarantineStore(db: Db): ForagingQuarantineStore {
  return {
    async findDatasetByName(companyId, name) {
      const [row] = await db
        .select({ id: corpusDatasets.id })
        .from(corpusDatasets)
        .where(and(eq(corpusDatasets.companyId, companyId), eq(corpusDatasets.name, name)))
        .limit(1);
      return row ?? null;
    },
    async createDataset(input) {
      const [row] = await db
        .insert(corpusDatasets)
        .values({ companyId: input.companyId, name: input.name, description: input.description })
        .returning({ id: corpusDatasets.id });
      if (!row) throw new Error("foraging: could not insert the foraging-inbox dataset");
      return row;
    },
    async createDocument(input) {
      const byteSize = Buffer.byteLength(input.markdown, "utf8");
      const [row] = await db
        .insert(corpusDocuments)
        .values({
          companyId: input.companyId,
          datasetId: input.datasetId,
          title: input.title,
          sourceUri: input.sourceUri,
          contentType: input.contentType,
          // The corpus_documents row has no content column — the quarantined
          // text lives in `metadata.markdown` (bounded above), so the
          // quarantine is one additive row without blob storage in the sweep
          // path. Parsing the quarantine is nobody's job until a reviewer
          // opens it.
          metadata: { ...input.metadata, markdown: input.markdown },
          byteSize,
          status: "ready",
          parsedAt: new Date(),
          blobKey: null,
        })
        .returning({ id: corpusDocuments.id });
      if (!row) throw new Error("foraging: could not insert the quarantine document");
      return row.id;
    },
  };
}

export interface ForagingKnowledgePortDeps {
  /** Per-company factory: the module binds companyId at construction. */
  knowledge: (companyId: string) => Pick<KnowledgeModule, "suggest">;
  quarantine: ForagingQuarantineStore;
  log?: { warn(obj: unknown, msg: string): void };
}

/**
 * The knowledge candidate port: findings become `pending` knowledge
 * suggestions with `trust=external`, the fetched text goes to the
 * `foraging-inbox` quarantine dataset. The suggestion id is the finding's
 * `candidate_ref`.
 */
export function createForagingKnowledgePort(deps: ForagingKnowledgePortDeps): ForagingCandidatePort {
  const log = deps.log ?? console;
  return {
    available: true,
    async createFindingCandidate(input: ForagingCandidateInput): Promise<string | null> {
      try {
        // 1. Quarantine first: the foreign text lands in `foraging-inbox`
        // before any knowledge row exists (§4.5; fail → no proposal).
        let dataset = await deps.quarantine.findDatasetByName(input.companyId, FORAGING_INBOX_DATASET);
        if (!dataset) {
          dataset = await deps.quarantine.createDataset({
            companyId: input.companyId,
            name: FORAGING_INBOX_DATASET,
            description:
              "Carantine of foraged external page text (1.7 L-5): raw captures, never knowledge; review before any reuse.",
          });
        }
        await deps.quarantine.createDocument({
          companyId: input.companyId,
          datasetId: dataset.id,
          title: `foraged:${input.skillKey}:${input.detectedAt.toISOString()}`,
          sourceUri: input.url,
          contentType: "text/markdown",
          markdown: buildQuarantineMarkdown(input, input.diff.added),
          metadata: { role: input.role, skillKey: input.skillKey, sourceId: input.sourceId },
        });

        // 2. The proposal: OUR retelling, url cited, trust=external, pending.
        const suggestion = await deps.knowledge(input.companyId).suggest(
          { actorType: "system", actorId: "foraging" },
          {
            body: buildProposalBody(input),
            rationale: `Foraged diff of ${input.url} (role ${input.role}); raw page text quarantined in ${FORAGING_INBOX_DATASET}.`,
            sourceKind: "url",
            sourceRef: input.url,
            trust: "external",
          },
        );
        return suggestion.id;
      } catch (error) {
        log.warn(
          { error, companyId: input.companyId, sourceId: input.sourceId, skillKey: input.skillKey },
          "foraging: knowledge port could not register a proposal",
        );
        return null;
      }
    },
  };
}
