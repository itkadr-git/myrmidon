// packages/shared/src/myrmidon-requirement-card.ts
//
// myrmidon(1.8-INTAKE-DIALOG / OPE-13007 local stub)
// Requirement card types, validation, and rendering.

export interface RequirementCardSection {
  title: string;
  content: string;
}

export interface RequirementCard {
  title: string;
  summary: string;
  goal?: string;
  acceptanceCriteria?: string[];
  scope?: string[];
  outOfScope?: string[];
  sections?: RequirementCardSection[];
  [key: string]: unknown;
}

export interface RequirementCardEvaluation {
  ready: boolean;
  missing: string[];
  violations: string[];
}

/**
 * Evaluates whether a requirement card is complete and ready for confirmation.
 * A card requires at least a non-empty title, summary, goal, and acceptanceCriteria.
 */
export function evaluateRequirementCard(card: Partial<RequirementCard> | null | undefined): RequirementCardEvaluation {
  const missing: string[] = [];
  const violations: string[] = [];

  if (!card) {
    return {
      ready: false,
      missing: ["title", "summary", "goal", "acceptanceCriteria"],
      violations: ["Card is empty or undefined"],
    };
  }

  if (!card.title || typeof card.title !== "string" || card.title.trim().length === 0) {
    missing.push("title");
  }

  if (!card.summary || typeof card.summary !== "string" || card.summary.trim().length === 0) {
    missing.push("summary");
  }

  if (!card.goal || typeof card.goal !== "string" || card.goal.trim().length === 0) {
    missing.push("goal");
  }

  if (
    !card.acceptanceCriteria ||
    !Array.isArray(card.acceptanceCriteria) ||
    card.acceptanceCriteria.length === 0 ||
    card.acceptanceCriteria.every((c) => typeof c !== "string" || c.trim().length === 0)
  ) {
    missing.push("acceptanceCriteria");
  }

  const ready = missing.length === 0 && violations.length === 0;

  return {
    ready,
    missing,
    violations,
  };
}

/**
 * Renders a requirement card as markdown for saving in the requirement-card document.
 */
export function renderRequirementCardMarkdown(card: RequirementCard): string {
  const lines: string[] = [];

  lines.push(`# ${card.title.trim()}`);
  lines.push("");
  lines.push("## Summary");
  lines.push(card.summary.trim());

  if (card.goal && card.goal.trim().length > 0) {
    lines.push("");
    lines.push("## Goal");
    lines.push(card.goal.trim());
  }

  if (card.acceptanceCriteria && card.acceptanceCriteria.length > 0) {
    lines.push("");
    lines.push("## Acceptance Criteria");
    for (const criterion of card.acceptanceCriteria) {
      if (typeof criterion === "string" && criterion.trim().length > 0) {
        lines.push(`- ${criterion.trim()}`);
      }
    }
  }

  if (card.scope && card.scope.length > 0) {
    lines.push("");
    lines.push("## Scope");
    for (const item of card.scope) {
      if (typeof item === "string" && item.trim().length > 0) {
        lines.push(`- ${item.trim()}`);
      }
    }
  }

  if (card.outOfScope && card.outOfScope.length > 0) {
    lines.push("");
    lines.push("## Out of Scope");
    for (const item of card.outOfScope) {
      if (typeof item === "string" && item.trim().length > 0) {
        lines.push(`- ${item.trim()}`);
      }
    }
  }

  if (card.sections && card.sections.length > 0) {
    for (const section of card.sections) {
      if (section.title && section.content) {
        lines.push("");
        lines.push(`## ${section.title.trim()}`);
        lines.push(section.content.trim());
      }
    }
  }

  lines.push("");
  return lines.join("\n");
}
