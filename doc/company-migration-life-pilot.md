# Life company migration pilot

Status: the operator migration route supports read-only dry runs; apply and
rollback are not yet implemented. Confirmed apply requests are rejected. Do not
use the existing company import API as a substitute: it does not provide the
provenance-based recovery required here.

## Scope and authorization

The pilot moves only the supported portable company entities into a newly created
company. Chats, secret values, and external integrations are excluded. Secret
bindings are reported by identifier only; an authorized owner provisions values
separately in the destination.

The existing portability implementation covers companies, agents, projects,
issues and skills, with partial support for routines, comments, documents and
attachments. Server-side Hindsight memory, Hermes profile and session memory,
knowledge corpus, chat endpoints, external integrations and secret values are
not covered. An inaccessible source or binding is not evidence that it is empty;
reconcile these exclusions with their owners before scheduling the pilot.

A dry-run is read-only. Actual application and rollback each require explicit
confirmation; application also requires separate approval and an agreed window.
This document is not that approval. No Life migration has been performed as part
of implementing the tool.

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
