# T7-A offline adopt/rollback rehearsal

**Offline, not live acceptance.** This rehearsal uses only an explicitly marked synthetic fixture. It never discovers or accesses a real home directory, volume, host, provider, bot account, or Telegram endpoint. It cannot prove live readiness or a week of drift-clean operation.

## Fixture and invocation

Create a disposable tree with `hermes/workspace/state/sessions.sqlite`; the database must contain `sessions(session_id TEXT PRIMARY KEY, payload TEXT NOT NULL)` and synthetic rows. Put an empty `.t7-offline-rehearsal` marker in the fixture root. Example:

```sh
python3 -c 'import pathlib,sqlite3; r=pathlib.Path("$PAPERCLIP_SCRATCH_DIR/t7-fixture"); (r/"hermes/workspace/state").mkdir(parents=True,exist_ok=True); (r/".t7-offline-rehearsal").touch(); c=sqlite3.connect(r/"hermes/workspace/state/sessions.sqlite"); c.execute("create table sessions(session_id text primary key,payload text not null)"); c.execute("insert into sessions values (?,?)",("synthetic-1","fixture")); c.commit()'
python3 scripts/myrmidon/t7-offline-rehearsal.py "$PAPERCLIP_SCRATCH_DIR/t7-fixture"
python3 scripts/myrmidon/t7-offline-rehearsal.py "$PAPERCLIP_SCRATCH_DIR/t7-fixture" --execute --simulate-interruption
python3 scripts/myrmidon/t7-offline-rehearsal.py "$PAPERCLIP_SCRATCH_DIR/t7-fixture" --execute
```

Default is dry-run. Execution validates SHA-256 path manifest and read-only SQLite session continuity before/after synthetic copy/restore. Interruption is simulated at the boundary after adoption verification; rollback then restores from the synthetic source. Existing `adopted/hermes` is refused unless it contains the rehearsal-owned `.t7-offline-rehearsal-target` marker. A copied target gets that marker; rollback removes only this marked target and recreates it from the fixture, making repeated rollback idempotent. The marker is ownership evidence for this disposable synthetic test only; never point the tool at non-synthetic data. Manifest traversal rejects symlinks.

## Live runbook (separate owner authorization required)

No live step is authorized by this document. The site owner must separately approve the window and bank-import timing. Capture gate evidence for T3, T4, T6, security approval, and capacity headroom before any live operation; if any is absent, stop. Follow order: `work-finansist` canary with datadir preserved and profile no-op; verify, then idle bots; then heavy bots; then remaining work bots. Keep old vm-core containers quarantined, never delete them. Maintain 15-minute snapshots. Version 1.6.6 has no synchronous replication; snapshots are not zero-RPO failover.

Stop immediately on failed health/session-continuity check, unexpected profile/datadir change, capacity/security gate regression, or missing owner approval. Roll back one bot first: stop its adoption path, restore its captured data, verify session continuity/profile no-op and Telegram smoke without reset, then decide whether broader rollback is necessary. Do not reset sessions.

## Acceptance evidence collection

| Evidence | Required proof | Result / reference / owner / time |
|---|---|---|
| Gates | T3, T4, T6, security approval, headroom | |
| Inventory | Exact expected 13/13 bot identities and matching adopted status | |
| Canary | work-finansist datadir preserved; profile no-op; session continuity | |
| Telegram | Authorized smoke succeeds; no session reset | |
| Sequence | idle, heavy, work groups completed in order | |
| Legacy | old vm-core containers quarantined, not deleted | |
| Recovery | one-bot rollback verified; 15-minute snapshots evidenced | |
| Limits | no synchronous replication; window and bank-import owner approval | |

The table remains unaccepted until populated with real, independently inspectable evidence. The fixture run only validates the rehearsal mechanics.
