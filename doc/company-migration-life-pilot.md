# Life company migration pilot

Status: design/runbook only. The migration service and its apply and rollback
endpoints are not yet implemented. Do not use the existing company import API as
a substitute: it does not provide the provenance-based recovery required here.

## Scope and authorization

The pilot moves only the supported portable company entities into a newly created
company. Chats, secret values, and external integrations are excluded. Secret
bindings are reported by identifier only; an authorized owner provisions values
separately in the destination.

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
