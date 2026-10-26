export type LegacyBlockedClass =
  | "dependency"
  | "recovery"
  | "human_decision"
  | "external_wait"
  | "resource"
  | "terminal"
  | "unknown";

export type LegacyBlockedLinkFact = {
  type: "issue" | "interaction" | "external" | "resource";
  relation?: string;
  status?: string;
  label: string;
};

export type LegacyBlockedPullRequestFact = {
  state: "open" | "closed" | "merged" | "unknown";
  checksState: "pending" | "failed" | "passed" | "unknown";
  reviewState: "pending" | "changes_requested" | "approved" | "unknown";
  label?: string;
};

export type LegacyBlockedFacts = {
  taskStatus?: string;
  latestComments?: readonly string[];
  links?: readonly LegacyBlockedLinkFact[];
  pullRequests?: readonly LegacyBlockedPullRequestFact[];
};

export type LegacyBlockedClassification = {
  class: LegacyBlockedClass;
  evidence: string[];
};

type Candidate = Exclude<LegacyBlockedClass, "unknown">;

const activeStatuses = new Set([
  "blocked",
  "in_progress",
  "in_review",
  "open",
  "pending",
  "requested",
  "todo",
  "unavailable",
  "waiting",
]);

function normalized(value: string | undefined): string {
  return value?.trim().toLowerCase().replace(/[ -]+/g, "_") ?? "";
}

function addCandidate(
  candidates: Map<Candidate, string[]>,
  candidate: Candidate,
  evidence: string,
): void {
  const current = candidates.get(candidate) ?? [];
  current.push(evidence);
  candidates.set(candidate, current);
}

function classifyComment(comment: string): Candidate[] {
  const text = comment.trim().toLowerCase().replace(/ё/g, "е");
  if (!text) return [];

  // Only recognize explicit present-tense statements; negated or resolved
  // statements are not evidence about the current blocker.
  const hasNegationOrResolution =
    /\b(?:not|no longer|never)\s+(?:blocked|waiting|awaiting|pending)\b/.test(text) ||
    /\b(?:resolved|completed|cleared|unblocked)\b/.test(text) ||
    /(?:уже\s+)?не\s+(?:ждем|ожидаем|заблокирован|заблокирована|заблокировано|ждет|ждут)|разблокирован|решен|решено|снят|снято/.test(text) ||
    /(?:ждем|ожидаем)\s+(?:решени\w*|согласовани\w*)\s+(?:владельца|алекса|alex)?/.test(text);
  if (hasNegationOrResolution) return [];

  const candidates: Candidate[] = [];
  if (/\b(?:awaiting|waiting for)\s+(?:an?\s+)?(?:human|owner|user)\s+(?:decision|approval|input)\b/.test(text) ||
      /\b(?:human|owner|user)\s+(?:decision|approval|input)\s+(?:is\s+)?(?:required|needed|pending)\b/.test(text) ||
      /(?:нужно|нужны)\s+(?:решени\w*|согласовани\w*)/.test(text)) {
    candidates.push("human_decision");
  }
  if (/\b(?:recovery task|recovery issue|operator action)\s+(?:is\s+)?(?:required|open|pending|created)\b/.test(text) ||
      /нужна\s+задача\s+восстановления|(?:нужно|требуется)\s+действие\s+оператора/.test(text)) {
    candidates.push("recovery");
  }
  if (/\b(?:permission denied|access denied|missing (?:repository )?access|missing permission|resource unavailable)\b/.test(text) ||
      /нет\s+(?:доступа|прав)|отказано\s+в\s+доступе/.test(text)) {
    candidates.push("resource");
  }
  if (/\b(?:awaiting|waiting for)\s+(?:a\s+)?(?:vendor|provider|external|upstream)\s+(?:response|reply|action|service)\b/.test(text) ||
      /\bexternal wait\b/.test(text) ||
      /(?:ждем|ожидаем)\s+(?:ответа|действия)\s+(?:поставщика|провайдера|внешнего\s+сервиса)/.test(text)) {
    candidates.push("external_wait");
  }
  if (/\b(?:blocked by|waiting on|depends on)\s+(?:issue\s+)?(?:ope-\d+|[a-f0-9]{8}-[a-f0-9-]{27,})\b/i.test(text) ||
      /(?:заблокировано|заблокирован|заблокирована|ждет|ждем|ожидает|зависит\s+от)\s+(?:задачи?\s+)?ope-\d+/.test(text)) {
    candidates.push("dependency");
  }
  if (/\b(?:duplicate|cancelled|canceled|will not be pursued|no further work is needed)\b/.test(text) ||
      /дубликат|отменено|не\s+нужно/.test(text)) {
    candidates.push("terminal");
  }
  return candidates;
}

/**
 * Classifies only explicit current evidence. Multiple supported explanations,
 * closed/resolved links, or ambiguous observations deliberately stay unknown.
 */
export function classifyLegacyBlocked(
  facts: LegacyBlockedFacts,
): LegacyBlockedClassification {
  const candidates = new Map<Candidate, string[]>();
  const status = normalized(facts.taskStatus);
  if (["cancelled", "canceled", "done", "closed", "completed"].includes(status)) {
    addCandidate(candidates, "terminal", `Task status is ${status}.`);
  }

  for (const link of facts.links ?? []) {
    const linkStatus = normalized(link.status);
    if (!activeStatuses.has(linkStatus)) continue;

    const relation = normalized(link.relation);
    const label = normalized(link.label);
    let candidate: Candidate | undefined;
    if (link.type === "issue" && ["blocks", "blocked_by", "dependency"].includes(relation)) {
      candidate = "dependency";
    } else if (link.type === "issue" && relation === "recovery") {
      candidate = "recovery";
    } else if (
      link.type === "interaction" &&
      (["decision", "human_decision", "approval"].includes(relation) ||
        /(?:^|_)(?:owner_)?(?:decision|approval)(?:_|$)/.test(label))
    ) {
      candidate = "human_decision";
    } else if (
      link.type === "external" &&
      (["wait", "external_wait", "pending"].includes(relation) || linkStatus === "pending")
    ) {
      candidate = "external_wait";
    } else if (
      link.type === "resource" &&
      (["unavailable", "blocked", "required"].includes(relation) || linkStatus === "unavailable")
    ) {
      candidate = "resource";
    }

    if (candidate) {
      const details = [link.type, relation, link.status?.trim(), link.label.trim()]
        .filter((part): part is string => Boolean(part));
      addCandidate(candidates, candidate, `Linked fact: ${details.join(" / ")}.`);
    }
  }

  for (const comment of facts.latestComments ?? []) {
    for (const candidate of classifyComment(comment)) {
      addCandidate(candidates, candidate, `Latest comment: ${comment.trim()}`);
    }
  }

  for (const pr of facts.pullRequests ?? []) {
    const state = normalized(pr.state);
    const checks = normalized(pr.checksState);
    const review = normalized(pr.reviewState);
    if (state === "open" && (checks === "pending" || review === "pending")) {
      const label = pr.label?.trim();
      addCandidate(
        candidates,
        "external_wait",
        `Linked PR${label ? ` ${label}` : ""} is open with ${checks === "pending" ? "pending checks" : "pending review"}.`,
      );
    }
  }

  if (candidates.size !== 1) {
    return {
      class: "unknown",
      evidence: candidates.size === 0
        ? ["No unambiguous current classification evidence was provided."]
        : ["Conflicting current classification evidence was provided."],
    };
  }

  const [classification, evidence] = candidates.entries().next().value as [Candidate, string[]];
  return { class: classification, evidence };
}
