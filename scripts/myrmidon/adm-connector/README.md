# ADM connector hooks (OPE-9260)

Node-only hooks, no model lookup or MCP calls. Install into Claude Code settings using
absolute paths to the repository checkout:

```json
{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"node /path/to/myrmidon/scripts/myrmidon/adm-connector/cli.mjs"}]}],"UserPromptSubmit":[{"hooks":[{"type":"command","command":"node /path/to/myrmidon/scripts/myrmidon/adm-connector/cli.mjs"}]}]}}
```

Set PAPERCLIP_API_URL, PAPERCLIP_COMPANY_ID and PAPERCLIP_API_KEY in the calling
environment (not in settings or command arguments). ADM_CONNECTOR_STATE_DIR defaults
to ~/.adm-connector/sessions; keep this private directory across hook processes.
The CLI consumes Claude hook JSON on stdin and emits additionalContext JSON only
when nonempty. Never concatenate the result into existing user message text.

SessionStart includes title + summary clipped together to 300 Unicode code points
per item, revision provenance and a trigger-to-slug index. Bodies are never read at
startup. Compact-source SessionStart re-emits policy summaries only and retains
session dedup. UserPromptSubmit matches the fixed versioned vocabulary in code;
no match performs no network lookup and emits zero bytes. Matching records are
ordered policy / trigger / other, priority descending, freshness descending, slug.
Whole entries only: 12 KiB startup, 2 KiB prompt, measured as UTF-8 context bytes.
Mandatory policy/index overflow produces a short fail-closed warning instead of
silently dropping policies. Trigger bodies too large for remaining budget are omitted.

REST uses the approved delivered revision, never latest draft. The current board
DTO has no dedicated triggers/priority fields: trigger tags (plain `ssh` or
`trigger:ssh`) bridge the vocabulary; dedicated fields take precedence if supplied.
Priority defaults to zero for legacy records. Listing is capped at the REST schema's
100 records; a saturated list fails closed rather than claiming a complete index.
This is conservative until the board supplies cursor pagination.

createHooks accepts a load({event,triggers}) port returning
{items,fetchedAt,degraded}; this is the integration point for the separate verified
cache implementation (OPE-9261). Only validated snapshots belong at this boundary;
the CLI currently reads REST directly, with 3s request timeouts. On error it emits
knowledge degraded with unknown cache age and fails closed. A supplied stale
snapshot emits its age and warns against hazardous authorization. No disk-cache
security/integrity implementation is duplicated here.

Session state uses SHA-256(session_id) filenames, atomic rename, mode 0600 and an
exclusive lock. Contention/crash-stale locks fail closed (exit 2); operators must
remove a stale lock only after confirming no hook process is active. Metrics in
metrics.jsonl contain only session hashes, event names, bytes and cumulative bytes;
never prompts, content or credentials. State and log retention are operator-owned.

Run `node --test scripts/myrmidon/adm-connector/*.test.mjs`. The existing
myrmidon-ci Script tests gate discovers these tests recursively. golden.json holds
50 real operational comment excerpts with source issue/comment IDs and frozen
expected trigger lists (not synthetic user messages). The suite checks all 50
classifications, per-message caps, zero unmatched bytes, dedup, compaction,
multibyte overflow, ranking and the REST revision boundary. No production settings
are changed by this PR; installation/rollout is an operator action.
