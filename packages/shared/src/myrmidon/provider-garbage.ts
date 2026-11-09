/**
 * PROVIDER-GARBAGE (OPE-12286): detection of provider stub replies.
 *
 * On 07-08.11.2026 the `nexus-grok-4.7` upstream answered HTTP 200 in 0.1s
 * with the short maintenance stub "tạm thời bảo trì để nâng cấp và sẽ bù ngày -
 * token". The router counted every such reply as a success, the fallbacks never
 * fired, and ~830 runs received the stub verbatim as the model's answer,
 * pushing 43 issues into blocked/recovery. Nothing detected the pattern for
 * five hours.
 *
 * This module is pure (no DB, no env): it classifies the outcome text of one
 * run and groups short repeated outcomes across agents. The scheduler turns
 * the verdicts into run marks, bounded retries and a P1 attention card.
 */

export interface ProviderGarbageSettings {
  /** Unknown short outcome text repeated across agents within the window. */
  distinctAgents: number;
  /** Same stub text repeated on one agent triggers too (maintenance channel). */
  sameAgentRuns: number;
  /** Sliding window in which repetition is counted. */
  windowMs: number;
  /** Only outcomes shorter than this character (exclusive) are classified. */
  maxOutcomeChars: number;
  /** Bounded retries with pause before a stub outcome stops retrying. */
  retryMaxAttempts: number;
  /** Pause between stub retries, in milliseconds. */
  retryDelayMs: number;
  /** Known stub signatures (case-insensitive substrings). */
  signatures: string[];
  /** Environment-variable overrides, one per threshold. */
  env: Record<string, string | undefined>;
  /** Extra signature sources already merged with env overrides. */
  additionalSignatures?: string[];
}

export const DEFAULT_PROVIDER_GARBAGE_SETTINGS: Required<
  Pick<
    ProviderGarbageSettings,
    | "distinctAgents"
    | "sameAgentRuns"
    | "windowMs"
    | "maxOutcomeChars"
    | "retryMaxAttempts"
    | "retryDelayMs"
    | "signatures"
  >
> = {
  distinctAgents: 5,
  sameAgentRuns: 5,
  windowMs: 600_000,
  maxOutcomeChars: 200,
  retryMaxAttempts: 3,
  retryDelayMs: 300_000,
  signatures: [
    "tạm thời bảo trì để nâng cấp và sẽ bù ngày - token",
    "server overloaded",
  ],
};

export const PROVIDER_GARBAGE_RETRY_REASON = "provider_garbage" as const;
export const PROVIDER_GARBAGE_WAKE_REASON = "provider_garbage_retry" as const;

export type ProviderGarbageSignatureSource =
  | "known_stub_signature"
  | "repeated_outcome";

export interface ProviderGarbageClassification {
  suspect: boolean;
  /** Signature or repeated-outcome text that matched, when known. */
  signature: string | null;
  signatureSource: ProviderGarbageSignatureSource | null;
  /** Representative outcome text used for grouping and reporting. */
  outcomeText: string;
  /** Outcome text length in characters (code points). */
  outcomeChars: number;
}

export interface ProviderGarbageRunInput {
  runId: string;
  agentId: string;
  modelGroup: string | null;
  finishedAt: Date | number;
  outcomeText: string | null | undefined;
}

export interface ProviderGarbageHit {
  /** Normalised (trimmed, case-folded) outcome text shared by the group. */
  outcomeText: string;
  /** Representative verbatim outcome text, truncated for display. */
  sample: string;
  /** Model group of the most recent run in the group, when reported. */
  modelGroup: string | null;
  /** Distinct agents that produced this outcome inside the window. */
  agentIds: string[];
  /** Run ids inside the window that produced this outcome. */
  runIds: string[];
  /** Number of runs inside the window that produced this outcome. */
  runCount: number;
  /** Whether a known stub signature matched. */
  knownSignature: boolean;
  signatureSource: ProviderGarbageSignatureSource;
  signature: string | null;
  /** Earliest finishedAt inside the window. */
  windowStart: Date;
  /** Latest finishedAt inside the window. */
  windowEnd: Date;
}

export interface ProviderGarbageDetectorOptions {
  windowMs?: number;
  distinctAgents?: number;
  sameAgentRuns?: number;
  maxOutcomeChars?: number;
  signatures?: string[];
  /** "now" reference; defaults to the latest finishedAt of the inputs. */
  now?: Date | number;
}

function parseNonNegativeInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parsePositiveInteger(value: unknown): number | null {
  const parsed = parseNonNegativeInteger(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function parseSignatureList(value: unknown): string[] | null {
  if (typeof value !== "string") return null;
  const list = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return list.length > 0 ? list : null;
}

export function resolveProviderGarbageSettings(
  input: Partial<ProviderGarbageSettings> = {},
): Required<
  Pick<
    ProviderGarbageSettings,
    | "distinctAgents"
    | "sameAgentRuns"
    | "windowMs"
    | "maxOutcomeChars"
    | "retryMaxAttempts"
    | "retryDelayMs"
    | "signatures"
  >
> {
  const env = input.env ?? {};
  const defaults = DEFAULT_PROVIDER_GARBAGE_SETTINGS;

  const distinctAgents =
    parsePositiveInteger(env.MYRMIDON_PROVIDER_GARBAGE_DISTINCT_AGENTS) ??
    parsePositiveInteger(input.distinctAgents) ??
    defaults.distinctAgents;
  const sameAgentRuns =
    parsePositiveInteger(env.MYRMIDON_PROVIDER_GARBAGE_SAME_AGENT_RUNS) ??
    parsePositiveInteger(input.sameAgentRuns) ??
    defaults.sameAgentRuns;
  const windowMs =
    parsePositiveInteger(env.MYRMIDON_PROVIDER_GARBAGE_WINDOW_MS) ??
    parsePositiveInteger(input.windowMs) ??
    defaults.windowMs;
  const maxOutcomeChars =
    parsePositiveInteger(env.MYRMIDON_PROVIDER_GARBAGE_MAX_OUTCOME_CHARS) ??
    parsePositiveInteger(input.maxOutcomeChars) ??
    defaults.maxOutcomeChars;
  const retryMaxAttempts =
    parsePositiveInteger(env.MYRMIDON_PROVIDER_GARBAGE_RETRY_MAX_ATTEMPTS) ??
    parsePositiveInteger(input.retryMaxAttempts) ??
    defaults.retryMaxAttempts;
  const retryDelayMs =
    parseNonNegativeInteger(env.MYRMIDON_PROVIDER_GARBAGE_RETRY_DELAY_MS) ??
    parseNonNegativeInteger(input.retryDelayMs) ??
    defaults.retryDelayMs;

  const envSignatures = parseSignatureList(
    env.MYRMIDON_PROVIDER_GARBAGE_SIGNATURES,
  );
  const inputSignatures = parseSignatureList(
    Array.isArray(input.signatures)
      ? (input.signatures as unknown[]).join(",")
      : input.signatures,
  );
  const additional = parseSignatureList(
    Array.isArray(input.additionalSignatures)
      ? (input.additionalSignatures as unknown[]).join(",")
      : input.additionalSignatures,
  );
  const signatures = Array.from(
    new Set([
      ...defaults.signatures,
      ...(additional ?? []),
      ...(inputSignatures ?? []),
      ...(envSignatures ?? []),
    ]),
  );

  return {
    distinctAgents,
    sameAgentRuns,
    windowMs,
    maxOutcomeChars,
    retryMaxAttempts,
    retryDelayMs,
    signatures,
  };
}

export function normalizeProviderGarbageOutcomeText(
  value: string | null | undefined,
): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function codePointLength(text: string): number {
  return Array.from(text).length;
}

function matchKnownSignature(
  normalized: string,
  signatures: string[],
): string | null {
  const haystack = normalized.toLocaleLowerCase();
  for (const signature of signatures) {
    const needle = signature.trim().toLocaleLowerCase();
    if (needle.length === 0) continue;
    if (haystack.includes(needle)) return signature;
  }
  return null;
}

/**
 * Classify one run's outcome text. An outcome is garbage when it is short
 * enough to be a stub reply AND either matches a known stub signature or is
 * not empty (anonymous repair text is handled by the repeated-outcome
 * detector, not here).
 */
export function classifyProviderGarbageOutcome(
  outcomeText: string | null | undefined,
  settings: {
    signatures?: string[];
    maxOutcomeChars?: number;
  } = {},
): ProviderGarbageClassification {
  const normalized = normalizeProviderGarbageOutcomeText(outcomeText);
  const maxOutcomeChars =
    settings.maxOutcomeChars ?? DEFAULT_PROVIDER_GARBAGE_SETTINGS.maxOutcomeChars;
  const outcomeChars = codePointLength(normalized);
  const signature = matchKnownSignature(
    normalized,
    settings.signatures ?? DEFAULT_PROVIDER_GARBAGE_SETTINGS.signatures,
  );
  const shortEnough = outcomeChars < maxOutcomeChars;
  if (!shortEnough || normalized.length === 0) {
    return {
      suspect: false,
      signature: null,
      signatureSource: null,
      outcomeText: normalized,
      outcomeChars,
    };
  }
  if (signature !== null) {
    return {
      suspect: true,
      signature,
      signatureSource: "known_stub_signature",
      outcomeText: normalized,
      outcomeChars,
    };
  }
  return {
    suspect: false,
    signature: null,
    signatureSource: null,
    outcomeText: normalized,
    outcomeChars,
  };
}

/**
 * Group short outcomes inside one sliding window and return the groups that
 * cross the alert threshold: the same normalised outcome produced by at
 * least {@link ProviderGarbageSettings.distinctAgents} distinct agents, or
 * repeated at least {@link ProviderGarbageSettings.sameAgentRuns} times on a
 * single agent. A known stub signature marks each individual run as
 * provider_garbage but does not by itself open a P1 incident.
 * One hit per normalised outcome text, most recent group first.
 */
export function detectProviderGarbageGroups(
  runs: ProviderGarbageRunInput[],
  options: ProviderGarbageDetectorOptions = {},
): ProviderGarbageHit[] {
  const windowMs = options.windowMs ?? DEFAULT_PROVIDER_GARBAGE_SETTINGS.windowMs;
  const distinctAgents =
    options.distinctAgents ?? DEFAULT_PROVIDER_GARBAGE_SETTINGS.distinctAgents;
  const sameAgentRuns =
    options.sameAgentRuns ?? DEFAULT_PROVIDER_GARBAGE_SETTINGS.sameAgentRuns;
  const maxOutcomeChars =
    options.maxOutcomeChars ?? DEFAULT_PROVIDER_GARBAGE_SETTINGS.maxOutcomeChars;
  const signatures = options.signatures ?? DEFAULT_PROVIDER_GARBAGE_SETTINGS.signatures;

  const parsed = runs
    .map((run) => {
      const text = normalizeProviderGarbageOutcomeText(run.outcomeText);
      const finished =
        run.finishedAt instanceof Date ? run.finishedAt.getTime() : run.finishedAt;
      if (text.length === 0 || !Number.isFinite(finished)) return null;
      return {
        runId: run.runId,
        agentId: run.agentId ?? "",
        modelGroup: run.modelGroup ?? null,
        finished,
        text,
        key: text.toLocaleLowerCase(),
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .sort((a, b) => a.finished - b.finished);

  if (parsed.length === 0) return [];

  const now =
    options.now !== undefined
      ? options.now instanceof Date
        ? options.now.getTime()
        : options.now
      : parsed[parsed.length - 1]!.finished;
  const windowStart = now - windowMs;

  const grouped = new Map<string, typeof parsed>();
  for (const entry of parsed) {
    if (entry.finished < windowStart) continue;
    const list = grouped.get(entry.key) ?? [];
    list.push(entry);
    grouped.set(entry.key, list);
  }

  const hits: ProviderGarbageHit[] = [];
  for (const [key, group] of grouped) {
    const shortGroup = group.filter(
      (entry) => codePointLength(entry.text) < maxOutcomeChars,
    );
    if (shortGroup.length === 0) continue;
    const agentIds = Array.from(new Set(shortGroup.map((entry) => entry.agentId))).filter(
      (id) => id !== "",
    );
    const perAgentCounts = new Map<string, number>();
    for (const entry of shortGroup) {
      perAgentCounts.set(entry.agentId, (perAgentCounts.get(entry.agentId) ?? 0) + 1);
    }
    const maxSameAgentRuns = Math.max(0, ...perAgentCounts.values());
    const signature = matchKnownSignature(shortGroup[0]!.text, signatures);

    // A known signature marks each run as provider_garbage, but the P1 health
    // signal still requires the configured burst threshold. This prevents one
    // isolated maintenance response from opening a fleet incident.
    const crossesDistinct = agentIds.length >= distinctAgents;
    const crossesSameAgent = maxSameAgentRuns >= sameAgentRuns;
    if (!crossesDistinct && !crossesSameAgent) continue;

    const latest = shortGroup[shortGroup.length - 1]!;
    hits.push({
      outcomeText: key,
      sample: latest.text,
      modelGroup: latest.modelGroup,
      agentIds,
      runIds: shortGroup.map((entry) => entry.runId),
      runCount: shortGroup.length,
      knownSignature: signature !== null,
      signatureSource:
        signature !== null ? "known_stub_signature" : "repeated_outcome",
      signature,
      windowStart: new Date(shortGroup[0]!.finished),
      windowEnd: new Date(latest.finished),
    });
  }

  return hits.sort((a, b) => b.windowEnd.getTime() - a.windowEnd.getTime());
}
