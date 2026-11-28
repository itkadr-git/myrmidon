# Life company migration pilot

Status: the operator migration route supports read-only dry runs. Confirmed
rollback can retry reserved resource cleanup only after the migration-owned
company has already been removed. Confirmed apply and rollback of a live
destination are not yet available. Do not use the existing company import API
as a substitute: it does not provide the provenance-based recovery required here.

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
`validation.importPreviewSkipped` is `false`, and `counts` match the approved
inventory. Review `validation.warningCounts` and the identifiers in
`validation.secretBindings` with their owners; the counts alone do not establish
that omitted entities or inaccessible sources are empty. A nonzero error count,
a skipped import preview, a failed request, or an inventory discrepancy stops the
pilot. Record only the approved scope, counts and outcome without secret values.
The `runKey` identifies the prepared content; a dry-run creates no durable run,
so it is not a rollback ID or evidence that apply occurred.

## Procedure once the tool is available

1. Obtain the separate approval, agree on the window and identify the operator,
   destination name, recovery owner and communication channel. Verify that the
   source is Life and the destination mode creates a new company.
2. Run the migration in its default dry-run mode. Record the report and counts,
   but do not record exported files, environment values or secret material in
   the issue or operational log. Resolve all validation errors. Review warnings,
   including required secret bindings, with their owners.
3. Confirm the approved source and destination and compare the dry-run report to
   the approved scope. In the window, explicitly confirm apply. Record the run ID,
   approved scope, entity counts and outcome, without secret values.
4. Compare actual counts and unresolved bindings with the dry-run report. Verify
   that destination agents cannot access the source or other companies and that
   only intended roles and permissions were granted. Provision missing secrets
   through the destination's normal secret-management process.
5. Repeat the same apply request and verify it returns the completed run without
   creating duplicates. If verification fails, stop further writes and notify
   the recovery owner.
6. If recovery is needed, inspect the migration journal and explicitly confirm
   rollback for that run. Verify that only run-created resources were removed,
   source data remains unchanged, and no later changes were overwritten. If the
   rollback rejects changed resources or cannot safely remove a resource, stop
   and escalate; do not manually delete resources based on guesses.

## Release gate

Do not schedule the pilot until CI exercises the real migration routes and
storage/database boundaries for no-write dry-run, confirmation, duplicate apply,
partial failure and recovery, collision handling, company isolation, secret
redaction and rollback. A green CI run for an earlier incomplete implementation is
not evidence that these scenarios pass.

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
