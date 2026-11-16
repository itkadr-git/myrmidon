# Offline verification report diff

Run `node scripts/myrmidon/release/report-diff/diff.mjs previous.json current.json` with two JSON reports from `verify-on-prod.mjs --report`. The command reads local files only and prints JSON. Exit 0 means identical, 1 means changed, and 2 means invalid input. The output lists added and removed identifiers, tasks that changed from pass to fail, both versions, and recomputed aggregate outcomes. A changed report is not necessarily a regression.

The comparator requires the current buildReport schema and rejects duplicate or unknown identifiers, duplicate checks, missing checks, mismatched task counts and malformed data. It recalculates the aggregate from the production check details, check results, task statuses, and task results; it does not trust the top-level `verified` flag. Empty task lists fail the aggregate. No input file is modified.

Run the synthetic tests in CI with `node --test scripts/myrmidon/release/report-diff/diff.test.mjs`.
