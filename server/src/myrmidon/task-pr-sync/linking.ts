const ISSUE_IDENTIFIER_PATTERN = /\b([A-Z][A-Z0-9]*-[0-9]+)\b/gi;

export function extractPullRequestIssueIdentifier(input: {
  headRef?: unknown;
  title?: unknown;
}): string | null {
  const headRef = typeof input.headRef === "string" ? input.headRef.trim() : "";
  const branchMatch = /^bot\/([A-Z][A-Z0-9]*-[0-9]+)$/i.exec(headRef);
  if (branchMatch?.[1]) return branchMatch[1].toUpperCase();

  const title = typeof input.title === "string" ? input.title : "";
  ISSUE_IDENTIFIER_PATTERN.lastIndex = 0;
  const titleMatch = ISSUE_IDENTIFIER_PATTERN.exec(title);
  return titleMatch?.[1]?.toUpperCase() ?? null;
}

export function pullRequestWorkProductData(input: {
  repository: string;
  number: number;
  url: string | null;
  title: string | null;
  headRef: string | null;
  headSha: string | null;
  state: string;
  merged: boolean;
}): {
  type: "pull_request";
  provider: "github";
  externalId: string;
  title: string;
  url: string;
  status: "open" | "merged" | "closed";
  metadata: Record<string, unknown>;
  isPrimary: boolean;
} {
  const externalId = `${input.repository}#pull/${input.number}`;
  const status = input.merged ? "merged" : input.state === "closed" ? "closed" : "open";
  return {
    type: "pull_request",
    provider: "github",
    externalId,
    title: input.title ?? `GitHub PR #${input.number}`,
    url: input.url ?? `https://github.com/${input.repository}/pull/${input.number}`,
    status,
    metadata: {
      provider: "github",
      repository: input.repository,
      repo: input.repository,
      number: input.number,
      ...(input.headRef ? { branch: input.headRef, headRef: input.headRef } : {}),
      ...(input.headSha ? { headSha: input.headSha } : {}),
      state: status,
      draft: false,
    },
    isPrimary: true,
  };
}
