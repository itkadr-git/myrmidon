// server/src/myrmidon/distill/service.ts
//
// myrmidon(1.6.6 KNOWLEDGE-2.0 K-5): the distiller pass itself. Raw material
// (tasks closed in the window) goes to the free model once; the answer is
// filtered through the domain rules — noise silent, unsourced dropped, life
// kept out of common proposals, package capped — and what survives lands in
// the nest as knowledge SUGGESTIONS only. The pass creates zero pages:
// proposal text belongs to the `knowledge-curator` cast (the
// `knowledge-distill` skill), the delivery to the curator workflow. The
// whole run reports itself into the knowledge journal (`knowledge_events`),
// so the spend is visible without a second board.

import { knowledgeEvents } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import type { KnowledgeModule } from "../knowledge/service.js";
import {
  DEFAULT_DISTILL_BUDGET,
  filterProposals,
  isAutoAcceptSection,
  noiseShare,
  validateEvidence,
  withinBudget,
  type DistillBudget,
  type DistillProposal,
  type DistillRunUsage,
} from "./domain.js";
import { buildDistillUserPrompt, DISTILL_SYSTEM_PROMPT, parseDistillAnswer, type DistillModelCall } from "./model.js";
import { passWindow, selectClosedTasks, taskIsLife, type DistillRawTask } from "./raw.js";
import type { ResolvedDistillSettings } from "./settings.js";

export interface DistillPassReport {
  companyId: string;
  windowFrom: string;
  windowTo: string;
  tasksConsidered: number;
  tasksExcludedLife: number;
  proposalsReturned: number;
  suggestionsCreated: number;
  suggestionsAutoAccepted: number;
  droppedNoise: number;
  droppedUnsourced: number;
  droppedLife: number;
  droppedInvalid: number;
  packageCapped: number;
  noiseShare: number;
  usage: DistillRunUsage;
  budgetSignals: string[];
}

export interface DistillServiceOptions {
  db: Db;
  /** The knowledge module (nest-bound) the suggestions land in. */
  knowledge: KnowledgeModule;
  model: DistillModelCall;
  settings: ResolvedDistillSettings;
  now?: () => Date;
  /** Override the budget (tests; default 1M tokens / 30 min). */
  budget?: DistillBudget;
}

const AUTO_ACTOR = { actorType: "system", actorId: "knowledge-distiller" } as const;

/**
 * One pass over one company. Returns the numeric report; never throws for
 * over-budget — over-budget is a signal recorded in the journal (§4.5).
 */
export async function runDistillPass(opts: DistillServiceOptions): Promise<DistillPassReport> {
  const now = opts.now ?? (() => new Date());
  const budget = opts.budget ?? DEFAULT_DISTILL_BUDGET;
  const started = now();
  const timer = started.getTime();
  const { settings } = opts.settings;
  const window = passWindow(started, opts.settings.windowMs, null);

  const raw = await selectClosedTasks(opts.db, opts.knowledge.companyId, window, settings.maxTasksPerPass);

  // I-7 at the selection edge: a life-contour task never enters the common
  // raw material. Life knowledge stays where the private contour puts it.
  const common = raw.filter((task) => !taskIsLife(task));
  const tasksExcludedLife = raw.length - common.length;

  let proposalsReturned = 0;
  let droppedNoise = 0;
  let droppedUnsourced = 0;
  let droppedLife = 0;
  let droppedInvalid = 0;
  let suggestionsCreated = 0;
  let suggestionsAutoAccepted = 0;
  let suggestionsCapped = 0;
  let usage: DistillRunUsage = { inputTokens: 0, outputTokens: 0, durationMs: 0 };

  if (common.length > 0) {
    const promptTasks: Parameters<typeof buildDistillUserPrompt>[0] = common.map((task: DistillRawTask) => ({
      identifier: task.identifier,
      title: task.title,
      description: task.description,
      finalComments: task.finalComments,
      documents: task.documents,
      projectName: task.projectName,
    }));
    const answer = await opts.model(DISTILL_SYSTEM_PROMPT, buildDistillUserPrompt(promptTasks));
    usage = { inputTokens: answer.usage.inputTokens, outputTokens: answer.usage.outputTokens, durationMs: now().getTime() - timer };

    const known = new Map<string, DistillRawTask>();
    for (const task of common) known.set(task.identifier, task);

    const proposals: DistillProposal[] = [];
    for (const item of parseDistillAnswer(answer.text)) {
      proposalsReturned += 1;
      const evidenceRefs = [...new Set(item.evidence)].filter((ref) => known.has(ref));
      const sources = evidenceRefs.map((ref) => ({ kind: "task" as const, ref }));
      const proposal: DistillProposal = {
        class: item.class,
        body: item.body,
        rationale: item.rationale,
        target: {
          section: isAutoAcceptSection(item.section) ? item.section : "general",
          slug: item.slug,
        },
        sources,
        evidenceTaskRefs: evidenceRefs,
      };
      const invalid = validateEvidence(proposal);
      if (proposal.class !== "noise" && invalid) {
        // evidence that resolves to no window task = unsourced; invalid bodies die silently too.
        droppedInvalid += 1;
        if (sources.length === 0) droppedUnsourced += 1;
        continue;
      }
      proposals.push(proposal);
    }

    const filtered = filterProposals(proposals);
    droppedNoise = filtered.droppedNoise;
    droppedUnsourced += filtered.droppedUnsourced;
    droppedLife += filtered.droppedLife;
    // The human package cap: kept beyond MAX_HUMAN_PACKAGE are reported capped.
    const cappedCount = Math.max(0, proposals.length - filtered.droppedNoise - filtered.droppedUnsourced - filtered.droppedLife - filtered.kept.length);

    for (const proposal of filtered.kept) {
      const primary = proposal.sources[0]!;
      const evidenceNote = proposal.evidenceTaskRefs.join(", ");
      const suggestion = await opts.knowledge.suggest(AUTO_ACTOR, {
        body: `[distill:${proposal.class}] ${proposal.body}`,
        rationale: `${proposal.rationale ?? ""} — evidence: ${evidenceNote}`.trim(),
        targetSlug: proposal.target.slug ?? undefined,
        sourceKind: primary.kind,
        sourceRef: primary.ref,
      });
      suggestionsCreated += 1;

      // Auto-accept by settings: only glossary/releases/how-made, and only
      // with internal sources (the distiller's own refs are task/pr/decision —
      // never an external url). Acceptance marks the suggestion for the
      // curator; the pass still writes no page.
      const autoSections = new Set(settings.autoAcceptSections);
      if (autoSections.has(proposal.target.section) && proposal.target.section !== "general") {
        await opts.knowledge.decideSuggestion(AUTO_ACTOR, {
          suggestionId: suggestion.id,
          decision: "accepted",
        });
        suggestionsAutoAccepted += 1;
      }
    }
    suggestionsCapped = cappedCount;
  } else {
    usage = { inputTokens: 0, outputTokens: 0, durationMs: now().getTime() - timer };
  }

  const budgetCheck = withinBudget(usage, budget);
  const share = noiseShare(proposalsReturned, droppedNoise);
  const report: DistillPassReport = {
    companyId: opts.knowledge.companyId,
    windowFrom: window.since.toISOString(),
    windowTo: window.until.toISOString(),
    tasksConsidered: common.length,
    tasksExcludedLife,
    proposalsReturned,
    suggestionsCreated,
    suggestionsAutoAccepted,
    droppedNoise,
    droppedUnsourced,
    droppedLife,
    droppedInvalid,
    packageCapped: suggestionsCapped,
    noiseShare: share,
    usage,
    budgetSignals: budgetCheck.signals,
  };

  // The journal row: pass spend + numbers, visible in «Журнал знаний» (K-5 criterion).
  await opts.db.insert(knowledgeEvents).values({
    companyId: opts.knowledge.companyId,
    nestId: opts.knowledge.nestId,
    itemId: null,
    event: "knowledge.distill.pass",
    payload: report as unknown as Record<string, unknown>,
    actorType: "system",
    actorId: "knowledge-distiller",
    createdAt: now(),
  });

  return report;
}
