/**
 * myrmidon(AGENT-ISSUE-LIST): response-size defaults for agent actors.
 *
 * Agent heartbeats wake with the issue list embedded in the prompt; the
 * vendor default (full projection, limit up to ISSUE_LIST_DEFAULT_LIMIT,
 * `description` included) dominated the wake payload — 64KB+ nginx proxy
 * buffers were exceeded by typical answers. For agent actors the issues list
 * route now defaults to the compact projection, limit 50, and omits the
 * heavy `description` field unless it is explicitly requested. Board actors
 * and every explicit `?view=compact` keep the pre-existing behaviour.
 *
 * The helpers are pure functions of (actor type, raw query values); the
 * route keeps ownership of validation and status codes.
 */

/** `limit` applied for agent actors when the query does not carry one. */
export const ISSUE_LIST_AGENT_DEFAULT_LIMIT = 50;

const TRUE_TOKENS = new Set(["1", "true", "yes", "on"]);
const FALSE_TOKENS = new Set(["0", "false", "no", "off"]);

function normalizeBooleanToken(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  const token = value.trim().toLowerCase();
  if (TRUE_TOKENS.has(token)) return true;
  if (FALSE_TOKENS.has(token)) return false;
  return null;
}

/**
 * Validates a repeated `?includeDescription=` parameter: only single
 * boolean-ish values are accepted; anything else returns null so the route
 * can answer 400.
 */
export function parseIncludeDescriptionParam(raw: unknown): boolean | null {
  if (raw === undefined) return null;
  if (Array.isArray(raw)) return null;
  return normalizeBooleanToken(raw);
}

export type IssueListProjectionChoice = {
  /** Apply the compact serializer (same as explicit `?view=compact`). */
  compact: boolean;
  /** Keep the heavy `description` field in projected rows. */
  includeDescription: boolean;
};

/**
 * Decide the projection for an issues-list request.
 *
 * - board actors: unchanged — compact only with explicit `?view=compact`,
 *   `description` always included (an absent `includeDescription` field for
 *   board callers simply means "keep what you had").
 * - agent actors: explicit `?view` wins as before (`compact` keeps today's
 *   compact behaviour with `description`). Without any `view` the request
 *   defaults to compact; `?includeDescription=true` or `?view=full` restore
 *   `description`, and `?includeDescription=false` declines it even on an
 *   explicit view.
 */
export function chooseIssueListProjection(input: {
  isAgentActor: boolean;
  rawView: unknown;
  includeDescriptionRequested: boolean | null;
}): IssueListProjectionChoice {
  const view = input.rawView;
  if (!input.isAgentActor) {
    return { compact: view === "compact", includeDescription: true };
  }
  if (view === "full") {
    return {
      compact: false,
      includeDescription: input.includeDescriptionRequested !== false,
    };
  }
  if (view === "compact") {
    return {
      compact: true,
      // The intro is explicit: for agents `description` returns only on an
      // explicit request (?includeDescription=true), even on ?view=compact.
      // "Явный ?view=compact — без изменений" refers to the projection path.
      includeDescription: input.includeDescriptionRequested === true,
    };
  }
  if (view !== undefined && view !== null) {
    // Unknown explicit `view` values are a 400 in the route before this
    // decision matters; fall through to the safe default anyway.
    return { compact: true, includeDescription: false };
  }
  // Agent actor, no explicit view: compact projection; `description` only on
  // an explicit `?includeDescription=true`.
  return {
    compact: true,
    includeDescription: input.includeDescriptionRequested === true,
  };
}

/**
 * Default `limit` for the issues-list route. An explicit, already-parsed
 * limit stays honoured (the route clamps it); agent actors without a `limit`
 * fall back to ISSUE_LIST_AGENT_DEFAULT_LIMIT instead of the board default.
 */
export function resolveIssueListLimit(input: {
  isAgentActor: boolean;
  parsedLimit: number | null;
  boardDefaultLimit: number;
}): number {
  if (input.parsedLimit !== null) return input.parsedLimit;
  return input.isAgentActor
    ? ISSUE_LIST_AGENT_DEFAULT_LIMIT
    : input.boardDefaultLimit;
}

/**
 * Drop the heavy `description` free-text from projected list rows unless the
 * caller asked for it. Applied to both projections so an agent that opts out
 * of compact with `?view=full` still gets a size-bounded answer when it did
 * not request descriptions.
 */
export function stripIssueListDescriptions<T extends { description?: unknown }>(
  rows: T[],
  includeDescription: boolean,
): T[] {
  if (includeDescription) return rows;
  return rows.map((row) => {
    if (!row || typeof row !== "object" || !("description" in row)) return row;
    const { description: _omitted, ...rest } = row;
    void _omitted;
    return rest as unknown as T;
  });
}
