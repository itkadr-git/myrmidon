# Work company split: offline fixture runbook

This is an offline planning exercise, not a real migration dry-run. The public
company migration contract is not available in main. This provisional fixture
schema is not that contract. The script never calls a service, database, storage,
audit, or a transport, and has no apply mode. It does not inspect production.
Do not include secrets, tokens, chat contents, or personal data in fixtures.

## Fixture and command

Create a local JSON fixture with this shape (the values are invented):

```json
{
  "fixture": "work-offline/v1",
  "source": "synthetic-source",
  "target": "synthetic-work",
  "entities": [
    { "kind": "project", "id": "p1", "targetId": "p1-work" },
    { "kind": "issue", "id": "i1", "targetId": "i1-work" }
  ],
  "relations": [{ "from": "issue:i1", "to": "project:p1" }],
  "bindings": [{ "entity": "issue:i1", "name": "tool", "target": null }]
}
```

Run `node scripts/myrmidon/company-boundaries/work-dry-run.mjs <fixture.json>`.
The JSON output lists source/target, mappings, relations, duplicate target IDs
within a kind, unknown relation/binding source references, missing binding
metadata, and rollback order. `ready` means only that these fixture checks found
no listed gaps; it is not approval or evidence of migration readiness. Target
inventory collisions, ACL, real secrets, external resources and data integrity
are not checked. Resolve every listed gap before any later integration.

Run `node --test scripts/myrmidon/company-boundaries/work-dry-run.test.mjs` to
check the fixture planner and the no-transport-call boundary. The transport spy
covers this offline module only; it does not prove the future migrator does not
write to DB, storage, or audit.

## Next integration and operator gates

When the public migration contract is available, compare its supported entities,
reference and binding semantics, collision handling and dry-run guarantees with
this fixture schema. Implement and independently test a contract adapter in the
appropriate follow-up; never treat this fixture as the real contract. Run the
real dry-run against an approved snapshot and retain its report. Production
transfer is exclusively an operator action after the Life pilot, mapping and
report approval, backup/restore proof, reconciliation and a separate window, as
specified in ADR-0052. Secret values and external connections must not be copied.

Rollback is an operator procedure, not implemented by this tool: stop writes,
revoke migration capabilities, preserve audit and checkpoints, restore routing
and memberships from the immutable snapshot, remove only rows with migration
provenance, and reconcile counts and references. Without snapshot or provenance,
do not perform rollback; escalate to the owner. No production apply is provided.
