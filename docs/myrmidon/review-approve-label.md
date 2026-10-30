# Review approval to the `review-approved` label

The reviewer role records its verdict on the board. The `hot-files-review` gate and the
auto-merge read the `review-approved` label on the pull request. `scripts/myrmidon/review-approve-label.mjs`
connects the two: an approval becomes the label without a delay, and a person no longer sets it by hand.

## Rules

The script puts the label on a pull request only when all of this is true:

1. The main branch CI is green: check run `CI result` on the head of `main` is `success`.
   If `main` is red or running (`failure`, `in_progress`, `missing`), auto-merging is halted
   (`action: "hold"`, `reason: "main-red"`), exponential backoff begins, and subsequent cycles
   wait for the backoff window. Once `main` turns green, auto-merging automatically resumes and
   the backoff failure counter resets.
2. The newest verdict line about the PR, written by a reviewer agent, is an approval. A later
   `RETURN`, `DEFERRED` or an unclear line (an approval and a refusal in one line, or two PR numbers in one
   line) cancels it.
3. The PR is open and not a draft.
4. The head did not move after the verdict. A verdict that names a head (`head <sha>`) must match the
   current head. A verdict without a head must be newer than the head commit.
5. The check run `CI result` of the head commit is `success`.

A PR whose head moved after an approval is reported as `needs-rereview`: the reviewer must look at the
new commits only. The script never labels it. A new push drops the label by itself (`hot-files-review`).
Repeated processing is safe and idempotent: when a PR is already labeled and auto-merge is active, the
script reports `noop` without duplicate API calls.

## Verdict lines

`VERDICT #123: APPROVE`, `VERDICT: APPROVE - PR #123, head <sha>`,
`VERDICT owner/name#123: APPROVE (head <sha>)`. A refusal uses `RETURN`, `REWORK`, `DEFERRED`,
`CHANGES REQUESTED`. Reviewer agents are the board agents whose name matches `--reviewer-pattern`
(default `^adm-dev-review`).

## Run

```sh
# every 5-10 minutes on the operator host (GH_TOKEN must be allowed to edit labels and merge)
node scripts/myrmidon/review-approve-label.mjs --repo itkadr-git/myrmidon \
  --psql-cmd 'sudo docker exec -i myrmidon-pg psql -U postgres -d paperclip -At' \
  --auto-merge --state-file /var/run/myrmidon/automerge-state.json
# a trial run that writes nothing
node scripts/myrmidon/review-approve-label.mjs --repo itkadr-git/myrmidon --psql-cmd '...' --dry-run
# the SQL it sends to the board database (verdict comments of the last 48 hours)
node scripts/myrmidon/review-approve-label.mjs --print-sql
```

The SQL goes to the command on stdin. `--verdicts <file.json>` reads a JSON array of
`{id, issueId, createdAt, authorName, body}` instead. Exit code: 0 ok, 1 a board or GitHub call failed,
2 usage. The token is never printed.

Test: `node --test scripts/myrmidon/review-approve-label.test.mjs`.
