export type SecretPatternType =
  | "pcp"
  | "ghp"
  | "sk"
  | "bearer"
  | "entropy"
  | string;

export interface SecretPattern {
  name: string;
  type: SecretPatternType;
  prefix?: string;
  pattern: RegExp;
  description: string;
  preservePrefix?: boolean;
}

/**
 * Standard known prefix patterns requested by OPE-10194:
 * `pcp_`, `ghp_`, `sk-`, `Bearer `
 */
export const KNOWN_PREFIX_PATTERNS: readonly SecretPattern[] = [
  {
    name: "pcp",
    type: "pcp",
    prefix: "pcp_",
    pattern: /\bpcp_[A-Za-z0-9_-]{8,}\b/g,
    description: "Paperclip platform and agent authentication tokens",
  },
  {
    name: "ghp",
    type: "ghp",
    prefix: "ghp_",
    pattern: /\bghp_[A-Za-z0-9]{20,}\b/g,
    description: "GitHub personal access tokens",
  },
  {
    name: "sk",
    type: "sk",
    prefix: "sk-",
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
    description: "OpenAI and LiteLLM API keys",
  },
  {
    name: "bearer",
    type: "bearer",
    prefix: "Bearer ",
    pattern: /\bBearer\s+([A-Za-z0-9_.-]{16,})\b/gi,
    description: "HTTP Bearer authorization tokens",
  },
];

/**
 * Extended token prefixes commonly encountered in logs and developer environments.
 */
export const EXTENDED_PREFIX_PATTERNS: readonly SecretPattern[] = [
  {
    name: "github_tokens",
    type: "ghp",
    prefix: "gh",
    pattern: /\b(?:gh[ousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
    description: "GitHub OAuth, user, server, refresh and fine-grained PAT tokens",
  },
  {
    name: "slack_token",
    type: "slack",
    prefix: "xox",
    pattern: /\bxox[baprs]-[A-Za-z0-9_-]{10,}\b/g,
    description: "Slack API and bot tokens",
  },
  {
    name: "aws_access_key",
    type: "aws",
    prefix: "AKIA",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    description: "AWS access and session key IDs",
  },
];

export const ALL_PATTERNS: readonly SecretPattern[] = [
  ...KNOWN_PREFIX_PATTERNS,
  ...EXTENDED_PREFIX_PATTERNS,
];
