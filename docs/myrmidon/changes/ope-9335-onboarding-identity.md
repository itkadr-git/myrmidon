# OPE-9335: onboarding identity and persisted instruction refresh

The default and CEO onboarding bundles and the first-task greeting/brief now identify
Myrmidon. The only legacy token allowed in the onboarding corpus is the literal
`X-Paperclip-Run-Id` protocol header. The recursive Vitest guard removes that exact
token before checking all files, case-insensitively; it does not allow an entire line.
Hermes identity headings, skill-delivery logs/errors and the gateway skills patch
use Myrmidon too. API field names, environment variables and directory names stay unchanged.

## Existing agents and deployment (ADM)

`server/src/routes/agents.ts` materializes default assets on creation using
`agent-instructions.ts:resolveManagedInstructionsRoot`:
`<instance root>/companies/<company>/agents/<agent>/instructions`.
Updating the image alone does NOT refresh these persisted copies.
Hermes reads `instructionsFilePath` on each run (gateway and local adapters), so
refreshing the files requires no adapter cache invalidation or instruction regeneration.
The gateway regression test changes a file between two executions and checks the second payload.

After deploying the merged CI-built board image and updated bot-runtime image,
ADM should run the following from a release checkout with the instance volume mounted:

```sh
node scripts/myrmidon/refresh-onboarding-brand.mjs --root "$INSTANCE_ROOT/companies"
node scripts/myrmidon/refresh-onboarding-brand.mjs --root "$INSTANCE_ROOT/companies" --apply
node scripts/myrmidon/refresh-onboarding-brand.mjs --root "$INSTANCE_ROOT/companies"
```

The first command is a dry-run; the last should report zero changes. The tool only
changes known stock phrases in managed AGENTS.md/HEARTBEAT.md files, preserves
custom content and protocol tokens, ignores symlinks, and backs up originals outside
the instruction bundle in the agent's `onboarding-brand-backup/` directory. Backups
are never overwritten. Restore from those backups if rollback is needed.
Custom/legacy instructions outside the managed layout require ADM's targeted review;
this tool deliberately does not rewrite arbitrary paths or historical run prompts.
Verify a fresh bot's greeting and a new existing-bot run identify Myrmidon. Previously
recorded session history is not rewritten. Live acceptance is ADM's post-deploy step.

## Verification and audit

Added server tests cover the whole asset tree, the exact allowlist, bundle identity,
and refresh dry-run/backup/idempotency/custom-content preservation. Existing greeting
assertions now require Myrmidon; Hermes tests cover changed skill errors and identity.
These Vitest suites run in the server shards and Hermes extra-package CI lane.

Locally exercised the actual refresh script against a scratch managed bundle:
dry-run 1, apply 1, second apply 0; checked the original backup and preserved custom
text/header. `node --check` and `git diff --check` pass. Full tests/types are CI-only.

`node scripts/myrmidon/brand-release-audit.mjs` on base fd3aa00e4 reports 14 doc
mentions, zero stale package URLs, and no architecture-doc findings (the six from
699d633b4 are not reproduced). Remaining findings are in README.ru.md and
`docs/myrmidon/` historical debranding/guidance entries; unrelated docs are not edited.
