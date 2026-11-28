# Life company migration pilot

The operator migration route defaults to a read-only dry run. Confirmed apply
and provenance-checked rollback are implemented, but the pilot must not be
scheduled until the release gate below is met. Do not use the existing company
import API as a substitute: it does not provide this recovery workflow.

## Scope and authorization

The pilot moves only the supported portable company entities into a newly created
company. Chats, secret values, and external integrations are excluded. Secret
bindings are reported by identifier only; an authorized owner provisions values
separately in the destination.

The existing portability implementation covers companies, agents, projects,
issues and skills, with partial support for routines, comments, documents and
attachments. Server-side Hindsight memory, Hermes profile and session memory,
knowledge corpus, chat endpoints, external integrations and secret values are
not covered. Custom agent castes are not included in the portable bundle; dry-run
rejects agents using them rather than silently losing their role definition.
An inaccessible source or binding is not evidence that it is empty;
reconcile these exclusions with their owners before scheduling the pilot.

A dry-run is read-only. Actual application and rollback each require explicit
confirmation; application also requires separate approval and an agreed window.
This document is not that approval. No Life migration has been performed as part
of implementing the tool.

## Read-only preflight

An authorized board operator with access to the source company can run the
implemented preflight now. Set `BOARD_URL`, `BOARD_TOKEN` and `SOURCE_COMPANY_ID`
in the operator's shell; obtain the source ID through the normal company
selection flow. The following request uses a placeholder destination name and
never applies the migration:

```sh
curl --fail-with-body --silent --show-error \
  -X POST "$BOARD_URL/api/companies/$SOURCE_COMPANY_ID/migrations" \
  -H "Authorization: Bearer $BOARD_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"target":{"mode":"new_company","newCompanyName":"Life pilot destination"}}'
```

Do not enable shell tracing or paste the token or full response into the issue.
Check that `dryRun` is `true`, `validation.errorCount` is zero,
`validation.importPreviewSkipped` is `false`, and `plannedCounts` match the approved
inventory. Review `validation.warningCounts` and the identifiers in
`validation.secretBindings` with their owners; the counts alone do not establish
that omitted entities or inaccessible sources are empty. A nonzero error count,
a skipped import preview, a failed request, or an inventory discrepancy stops the
pilot. Record only the approved scope, counts and outcome without secret values.
The `runKey` identifies the prepared content; a dry-run creates no durable run,
so it is not a rollback ID or evidence that apply occurred.

## Procedure after CI, review, and pilot approval

1. Obtain the separate approval, agree on the window and identify the operator,
   destination name, recovery owner and communication channel. Verify that the
   source is Life and the destination mode creates a new company.
2. Run the migration in its default dry-run mode. Record the report and counts,
   but do not record exported files, environment values or secret material in
   the issue or operational log. Resolve all validation errors. Review warnings,
   including required secret bindings, with their owners.
3. Confirm the approved source and destination and compare the dry-run report to
   the approved scope. In the window, submit the same request with `dryRun: false`,
   `apply: true` and a non-empty `confirm` reason. Apply rejects validation errors
   and unresolved required secret bindings. Record the `runId`, approved scope,
   entity counts and outcome, without secret values. On a partial failure the
   conflict response carries `details.runId`; do not confuse it with `runKey`.
4. Compare apply `createdCounts` with dry-run `plannedCounts`, and review unresolved
   bindings. `sourceCounts` describes the exported scope before collision handling;
   `counts` mirrors `plannedCounts` on dry-run and `createdCounts` on successful
   apply, including idempotent retries. A skipped manager blocks apply if any
   retained agent reports to it. Verify
   that destination agents cannot access the source or other companies and that
   only intended roles and permissions were granted. Provision missing secrets
   through the destination's normal secret-management process.
   In a fresh destination, `rename` gives colliding agent names unique names;
   `skip` omits later matches. `replace` does not overwrite another bundle entry.
5. Repeat the same apply request and verify it returns the completed run without
   creating duplicates. If verification fails, stop further writes and notify
   the recovery owner.
6. If recovery is needed, read `GET /api/companies/{sourceCompanyId}/migrations/{runId}`.
   The same confirmed apply can resume after destination creation or owner
   provisioning if the destination still matches its journal. If the owner was
   already provisioned, retry as that same operator. The retry can also delete a
   reserved logo upload whose database record never committed, then upload it
   again in the same run. A committed logo is reused only if the asset and logo
   rows match the journal and the reserved object still has the expected bytes.
   If the import stopped after creating agents, but before
   committing later entities, a retry can reuse those agents after verifying their
   rows, access records and managed instructions against the journal. A committed
   skill library is also reusable when its rows, managed files and source-to-target
   references match the journal. Committed projects can be reused with their
   original workspace IDs. Older nonempty checkpoints without these mappings,
   and runs with committed routines, issue batches, or non-logo assets, require
   rollback rather than in-place replay.
   Use `POST /api/companies/{sourceCompanyId}/migrations/{runId}/rollback` with a
   non-empty `confirm` reason. One database transaction removes journaled child
   rows and archives the destination, preserving its ID. If a journaled managed
   file is already changed, rollback refuses before archiving; an absent file
   may be an interrupted publication. Reserved storage cleanup
   follows and can be retried with the same confirmed rollback if interrupted.
   Repeating a settled rollback returns `rolled_back` without another cleanup.
   Status reports the destination claim, committed creation counts, and separate
   database and storage rollback checkpoints. Managed-file cleanup removes only
   unchanged journaled files; independent files and directory-only reservations
   from older runs require manual inspection and are not deleted.
   Verify `rolled_back`, the destination's `archived` status, removal of only
   run-created resources, and unchanged source data. If rollback refuses a changed
   destination, stop and escalate; do not manually delete resources based on
   guesses.
   After complete rollback, a new explicitly confirmed apply of the same
   package starts a new attempt. The previous run and its archived destination
   remain available for audit.

## Release gate

Do not schedule the pilot until CI exercises the real migration routes and
storage/database boundaries for no-write dry-run, confirmation, duplicate apply,
partial failure and recovery, collision handling, company isolation, secret
redaction and rollback. Require independent review. A green aggregate with
skipped test jobs or a result from another commit is not evidence that these
scenarios pass.

The existing import path is not a recovery mechanism: it creates the destination
company before importing its entities, and its error handler only attempts to
remove secrets created during import. Its result does not enumerate imported
issues. The transfer-run service also states that apply is not itself idempotent.
A migration implementation must therefore record ownership of each created
resource durably at the same boundary as creation, cover non-database resources,
serialize competing applies, and prove recovery after interruption. A completed
transfer ledger entry or a list assembled only after import returns is not enough
for retry or rollback after a partial failure.

The export-preview unit test uses mocked services and is not proof of the
read-only gate. `server/src/__tests__/company-migration.integration.test.ts`
exercises the migration route against a database and local storage, comparing
company, agent, project, issue, transfer-run and audit rows and storage files
before and after a dry run. The gate is satisfied only when that integration
test actually executes successfully in CI; a skipped test is not evidence.
