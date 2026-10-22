// packages/shared/src/myrmidon-issue-list-agent-defaults.ts
//
// myrmidon(F16): the shared contract of the issue-list agent defaults.
//
// The issue list endpoint `GET /api/companies/:companyId/issues` answers
// 1.5-4 MB to a bare agent request, because the full response carries every
// `description`. When this feature is enabled (the default), an actor of
// type "agent" gets a smaller, paginated contract instead:
//
//   - no `view` query → the response is the compact view;
//   - `limit` defaults to 200 and may be at most 500 (a larger value is a
//     400 pointing at pagination via `offset`/`afterId`);
//   - the compact body for an agent omits the `description` field;
//   - the full view stays reachable through an explicit `view=full` with an
//     explicit `limit <= 100`.
//
// The board actor (`req.actor.type === "board"`) is untouched — the UI keeps
// the previous behaviour byte-for-byte. Setting `enabled: false` restores
// the pre-feature behaviour for the agent actor as well, byte-for-byte.
//
// The settings live in `instance_settings.general.issuesListAgentDefaults`;
// the key is absent on instances that never toggled it, and absent means
// ENABLED (defect-fix on per the SETTINGS rule; the key exists so the fix
// can be rolled back without a deploy).

import { z } from "zod";

/** The `instance_settings.general` key this feature stores its settings under. */
export const ISSUE_LIST_AGENT_DEFAULTS_SETTINGS_KEY = "issuesListAgentDefaults";

/** The default `limit` applied to an agent's issue-list request. */
export const ISSUE_LIST_AGENT_DEFAULT_LIMIT = 200;

/** The maximum `limit` an agent may request (above it: 400). */
export const ISSUE_LIST_AGENT_MAX_LIMIT = 500;

/** The maximum explicit `limit` accepted with an agent's `view=full`. */
export const ISSUE_LIST_AGENT_FULL_VIEW_MAX_LIMIT = 100;

export const issueListAgentDefaultsSchema = z
  .object({
    /** false restores the pre-feature agent behaviour byte-for-byte. */
    enabled: z.boolean(),
  })
  .strict();

export type IssueListAgentDefaultsSettings = z.infer<
  typeof issueListAgentDefaultsSchema
>;

/** The stored shape, or the implicit default (enabled) when absent/invalid. */
export function normalizeIssueListAgentDefaults(
  raw: unknown,
): IssueListAgentDefaultsSettings {
  const parsed = issueListAgentDefaultsSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  // A hand-edited row cannot half-apply: an unreadable value reads as the
  // enabled default, the defect-fix stays on.
  return { enabled: true };
}

/** True when the agent defaults apply (absent key = enabled). */
export function issueListAgentDefaultsEnabled(raw: unknown): boolean {
  return normalizeIssueListAgentDefaults(raw).enabled;
}
