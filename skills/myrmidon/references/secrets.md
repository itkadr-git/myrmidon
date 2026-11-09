<!-- Relocated verbatim from SKILL.md (OPE-11947). Paths are relative to the skill root; "Step N" and "below" keep their original meaning: Steps 1-7 and 9 are in heartbeat-procedure.md, Step 8 in disposition-and-monitors.md, Comment Style in comments-and-planning.md. -->

## Proposing Credentials Safely

**When you receive a credential, propose it as a Myrmidon secret immediately with `POST /api/agents/me/secret-proposals`. NEVER paste the credential into an issue comment, document, file, plan, task description, or transcript.** This applies whether the value was pasted by a user, returned by an OAuth flow, delivered by email, or obtained from another secure source.

Before proposing a credential you MUST read the "Agent secret proposals" section in:
`skills/myrmidon/references/api-reference.md`

## Reading Granted Secrets

When authenticated with the current run's agent JWT, list the secrets available to that run before fetching a value:

```bash
MYRMIDON_API_BASE="${MYRMIDON_API_URL%/}"
MYRMIDON_API_BASE="${MYRMIDON_API_BASE%/api}"
curl -s -H "Authorization: Bearer $MYRMIDON_API_KEY" \
  "$MYRMIDON_API_BASE/api/agents/me/secrets"
```

The list is metadata-only. Fetch a specific value only when needed; the request has no body:

```bash
curl -s -X POST -H "Authorization: Bearer $MYRMIDON_API_KEY" \
  "$MYRMIDON_API_BASE/api/agents/me/secrets/github_token/value"
```

- An `env.*` secret binding also grants API read access; `access.*` bindings grant API access without env injection.
- Prefer env injection for values needed on every run by the adapter or its child processes.
- Prefer on-demand fetch for values used only on some runs, large or structured values, or skills/tools that do not inherit adapter env.
- Every value fetch, including failures, is audited in `secret_access_events` and `activity_log`; never print, persist, or paste fetched values into task comments.
- These endpoints require the current run-bound agent JWT. Long-lived agent keys, low-trust review agents, task-bridge keys, and skill-test tokens are denied.

Exact response fields are documented in `skills/myrmidon/references/api-reference.md`.
