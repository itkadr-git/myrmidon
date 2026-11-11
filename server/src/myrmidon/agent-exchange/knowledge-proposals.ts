// server/src/myrmidon/agent-exchange/knowledge-proposals.ts
//
// myrmidon(1.7 KNOWLEDGE-2.0 L-12 Ч2): the room outcome → knowledge proposal
// drafts. Pure module: no DB, no model call, no network.
//
// Contract (knowledge architecture 2.0, §2.2 and §4.5): the room finisher may
// propose at most 3 knowledge items. Each proposal carries its source — the
// discussion itself (`sourceKind: "debate"`, `sourceRef: <roomId>`) — and the
// participants' positions in the rationale. The room never writes knowledge
// directly: the drafts become `suggest` inputs for the review pipeline
// (`pending`, no auto-accept, trust `internal`). Wiring into `runFinisher`
// and the actual `suggest` call are the NEXT part; this module only defines
// the prompt fragment and the pure extraction/shape functions.
//
// The finisher answers with the visible summary and may append a fenced
// ```proposals block holding a JSON array
// `[{ "title", "claim", "positions", "targetSlug"? }]`. Extraction never
// throws: a missing or broken block degrades to "no drafts", with the reason
// recorded in `problems`.

/** The finisher-prompt fragment. Not appended by `runFinisher` in this part. */
export const AGENT_EXCHANGE_PROPOSALS_PROMPT = [
  "After the summary, decide whether this discussion produced knowledge worth",
  "keeping. If it did, end your reply with a fenced code block tagged",
  "```proposals containing a JSON array of at most 3 objects:",
  '[{ "title", "claim", "positions", "targetSlug" }]. "title" is a short name,',
  '"claim" is the reusable lesson as a single line, "positions" records where',
  'the participants agreed and differed, and "targetSlug" optionally names an',
  "existing knowledge page slug (lowercase letters, digits, dots, underscores,",
  "slashes, hyphens). Use an empty array when there is nothing worth proposing.",
].join("\n");

/** Why the extraction is not a clean pass. */
export type ExchangeProposalProblem = "proposals_block_invalid_json" | "proposals_over_limit";

/** One knowledge proposal draft, already shaped for review. */
export interface ExchangeProposalDraft {
  title: string;
  /** The reusable lesson as a single line (no newline survives extraction). */
  claim: string;
  /** Where the participants agreed and differed; newlines allowed. */
  positions: string;
  /** Optional knowledge page slug, `[a-z0-9._/-]` only; dropped when invalid. */
  targetSlug?: string;
}

/** The finisher answer split into the visible summary and the draft proposals. */
export interface ExtractedRoomProposals {
  /** The answer without the proposals block, without trailing whitespace. */
  visibleSummary: string;
  drafts: ExchangeProposalDraft[];
  problems: ExchangeProposalProblem[];
}

/** Extraction limits; every field is optional and falls back to the contract. */
export interface RoomProposalLimits {
  maxProposals: number;
  maxClaimLength: number;
  maxTitleLength: number;
  maxPositionsLength: number;
}

const DEFAULT_LIMITS: RoomProposalLimits = {
  maxProposals: 3,
  maxClaimLength: 500,
  maxTitleLength: 300,
  maxPositionsLength: 4000,
};

/**
 * The `suggest` input this part builds. A local interface on purpose: the
 * knowledge `KnowledgeSourceKind` union gains `"debate"` in Ч1, and the parts
 * stay code-independent — the literal below compiles either way.
 */
export interface ExchangeKnowledgeSuggestionInput {
  /** Single line: `store.suggest` rejects newline bodies. */
  body: string;
  rationale: string;
  sourceKind: "debate";
  sourceRef: string;
  trust: "internal";
  idempotencyKey: string;
  targetSlug?: string;
}

const PROPOSALS_FENCE = /^```[ \t]*proposals[ \t]*$/i;
const CLOSE_FENCE = /^```[ \t]*$/;
const SLUG_PATTERN = /^[a-z0-9._/-]+$/;
function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}


function bounded(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Split the finisher answer into the visible summary and the proposals
 * payload. The last ```` ```proposals ```` fence wins; an unterminated block
 * still extracts (models forget the closing fence). No block → the answer
 * passes through unchanged (trailing whitespace trimmed) with no drafts.
 */
function splitProposalsBlock(answer: string): { visibleSummary: string; payload: string | null } {
  const lines = answer.split("\n");
  let openIndex = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (PROPOSALS_FENCE.test(lines[i]!.trimEnd())) {
      openIndex = i;
      break;
    }
  }
  if (openIndex < 0) {
    return { visibleSummary: answer.trimEnd(), payload: null };
  }
  let closeIndex = -1;
  for (let i = openIndex + 1; i < lines.length; i += 1) {
    if (CLOSE_FENCE.test(lines[i]!.trimEnd())) {
      closeIndex = i;
      break;
    }
  }
  const payload =
    closeIndex < 0 ? lines.slice(openIndex + 1).join("\n") : lines.slice(openIndex + 1, closeIndex).join("\n");
  const before = lines.slice(0, openIndex).join("\n");
  const after = closeIndex < 0 ? "" : lines.slice(closeIndex + 1).join("\n");
  return { visibleSummary: `${before}\n${after}`.trimEnd(), payload };
}

/**
 * Extract the knowledge proposal drafts from a finisher answer. Never throws:
 * a missing block yields no drafts, a broken payload records
 * `proposals_block_invalid_json`, more items than the cap keeps the first
 * ones and records `proposals_over_limit`, and malformed items are dropped.
 */
export function extractRoomProposals(
  answer: string,
  limits?: Partial<RoomProposalLimits>,
): ExtractedRoomProposals {
  const caps: RoomProposalLimits = { ...DEFAULT_LIMITS, ...limits };
  const { visibleSummary, payload } = splitProposalsBlock(answer);
  if (payload === null) {
    return { visibleSummary, drafts: [], problems: [] };
  }
  const problems: ExchangeProposalProblem[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.trim());
  } catch {
    return { visibleSummary, drafts: [], problems: ["proposals_block_invalid_json"] };
  }
  if (!Array.isArray(parsed)) {
    return { visibleSummary, drafts: [], problems: ["proposals_block_invalid_json"] };
  }
  const items = parsed as unknown[];
  if (items.length > caps.maxProposals) {
    problems.push("proposals_over_limit");
  }
  const drafts: ExchangeProposalDraft[] = [];
  for (const item of items.slice(0, caps.maxProposals)) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const raw = item as Record<string, unknown>;
    const claim = bounded(asString(raw.claim).replace(/[\r\n]+/g, " ").trim(), caps.maxClaimLength);
    if (!claim) {
      continue;
    }
    const draft: ExchangeProposalDraft = {
      title: bounded(asString(raw.title).replace(/[\r\n]+/g, " ").trim(), caps.maxTitleLength),
      claim,
      positions: bounded(asString(raw.positions), caps.maxPositionsLength),
    };
    const targetSlug = raw.targetSlug;
    if (typeof targetSlug === "string" && SLUG_PATTERN.test(targetSlug)) {
      draft.targetSlug = targetSlug;
    }
    drafts.push(draft);
  }
  return { visibleSummary, drafts, problems };
}

/**
 * Shape one draft as a `suggest` input: the discussion itself is the source,
 * the positions live in the rationale, and the key derives from the room and
 * the index so retrying the same proposal cannot duplicate a suggestion.
 */
export function toSuggestionInput(
  roomId: string,
  draft: ExchangeProposalDraft,
  index: number,
): ExchangeKnowledgeSuggestionInput {
  const rationale = [draft.title, draft.positions].filter((part) => part.length > 0).join("\n");
  return {
    body: `[exchange-room] ${draft.claim}`,
    rationale,
    sourceKind: "debate",
    sourceRef: roomId,
    trust: "internal",
    idempotencyKey: `exchange-room:${roomId}:${index}`,
    ...(draft.targetSlug !== undefined ? { targetSlug: draft.targetSlug } : {}),
  };
}
