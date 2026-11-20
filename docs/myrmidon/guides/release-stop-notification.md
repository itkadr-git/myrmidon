# Release-stop notification recovery

The notifier reserves `release-stop-lock-<event id>` as a repository label and
retains it after success or failure. This is a durable deduplication record,
not a temporary lock to clean up routinely. A failed `gh issue create` can
mean that GitHub saved the issue but its response was lost. Listing can also
lag; a timeout waiting on the reservation deliberately fails closed.

To reconcile a failed notification, identify the stopped workflow run ID and
release tag from the Actions run and notification job logs. Search all issues,
including closed issues, for the exact title `release-stop: <tag> (<event id>)`
and verify the issue body and stop-event/run link. If the issue exists, keep
the reservation: retries deduplicate to that issue once the listing sees it.
Do not create another issue or delete the label merely because a listing is
empty; repeat the check after propagation and inspect the run and create logs.

Only when the operator has confirmed that no issue was created and no notifier
for that event is still running, the reservation is orphaned. Manually delete
that event's `release-stop-lock-<event id>` repository label and retry the
notification. If the result remains uncertain, keep the reservation and
escalate rather than risk a duplicate. Reservations accumulate per event.

Source: `scripts/myrmidon/release/release-stop-notify.sh`, OPE-13406, PR #3964.
