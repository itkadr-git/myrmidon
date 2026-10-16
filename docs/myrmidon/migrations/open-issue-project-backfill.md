# Open issue project backfill

This tool is a snapshot-based, read-only planner. It never connects to Myrmidon or changes issue records; production application remains an operator/release action after review and CI.

## Input

Provide a JSON snapshot with `issues`, `projects`, `memberships`, and optionally `creatorDefaultProjects`:

- `issues`: issue objects with `id`, `status`, optional `projectId`, `assigneeAgentId`, `parentId`, and `createdByAgentId`.
- `projects`: `{ "id", "name" }` rows.
- `memberships`: `{ "agentId", "projectId", "confirmed": true }` rows. Only explicitly confirmed memberships participate; each assignee must resolve to exactly one project.
- `creatorDefaultProjects`: map of creator agent ID to an array of confirmed default project IDs. Multiple values are an exclusion.

Example:

```sh
node scripts/myrmidon/migrations/backfill-open-issue-projects.mjs snapshot.json report.json
```

The generated report lists all proposed assignments and excluded issue IDs with a reason. The script only plans open statuses (`todo`, `in_progress`, `in_review`, `blocked`, `backlog`); closed issues are ignored. Rule order is assignee membership, parent project, then creator default. Ambiguous results and missing mappings remain unchanged.

## Project / membership table

| Population | Project assignment | Evidence required |
| --- | --- | --- |
| `adm-dev-*` | Existing "Разработка инструментов" project (`47a9dccd-78f0-4431-9ee7-b7c2ca2c1a6b`) | Confirmed membership row in snapshot |
| Shop / work agents | Their own project, not inferred from role/name | Confirmed project/member rows from the alignment work |
| Conflicting memberships/defaults | No assignment | Excluded by planner |

This table records the requested mapping policy, not a claim that memberships are already established in authoritative data. Reconcile the actual confirmed rows with OPE-7278 before producing a production snapshot.

## Dry-run report

No authoritative membership/default-project snapshot is currently available in this work environment. Prior live inventory identified 6,752 total issues and 622 open issues without `projectId`; none had a parent with a `projectId`. Since those counts can change and membership data was absent, do not treat that inventory as a fresh dry-run or execute a backfill. Run the planner against an exported, current snapshot to obtain its reproducible exception and rule counts.
