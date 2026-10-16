# Migrating from Paperclip to Myrmidon

> Russian version: [migration-from-paperclip.ru.md](migration-from-paperclip.ru.md)

This guide moves one Paperclip instance — database, stored files and secrets — into a clean
Myrmidon installation with the `myrmidon:migrate` command of the `paperclipai` CLI. It describes
what the command does today; where it does not do something, the section says so.

The command never changes the source, never writes into a database or directory it did not
create, and stops before the first target write when the source history or a key does not fit.
Read the whole guide once before you start; the rollback section matters most **before** you
cut over, not after.

## 1. What is supported

| Item | Supported |
|---|---|
| Source | Paperclip release `v2026.916.1` exactly. Compatibility is decided by the **hashes** of the applied migrations (278 entries, derived from the migration files of the build), not by version strings or the last migration number. |
| Older or newer source | Rejected before any target write, with the reason (`older-than-supported-release`, `newer-than-supported-release`, `hash-mismatch`). Upgrade or downgrade the source to the release first. No adapter exists. |
| Source access | A PostgreSQL URL (read-only snapshot), or a **plain-format** `pg_dump` file. |
| Secrets | `local_encrypted` secrets (`local_encrypted_v1` envelopes), in any JSON column. |
| Files | The `local_disk` storage directory. |
| Target | A new, empty PostgreSQL database and an empty (or absent) directory, both dedicated to Myrmidon. |

Not covered, by design: secrets kept in an external provider (for example a cloud secret
manager) are copied as references — the values stay where they are and the Myrmidon target must
be able to reach them; assets stored in an object store (S3 and similar) are copied as rows, the
objects are not moved; tables outside the `public` schema are not transferred;
the Paperclip state that lives outside the database and the storage directory
(agent workspaces, adapter sessions on disk, environment variables of the service)
is yours to carry over.

## 2. Prerequisites

- `paperclipai` CLI of a Myrmidon build that contains the command (`paperclipai myrmidon:migrate --help`).
- Node 24+ on the machine that runs the command, with network access to the source and target databases.
- A target PostgreSQL database role that can create tables. Loading is fastest and exact with a
  role that may set `session_replication_role` (a superuser, or PostgreSQL 15+ with that
  parameter granted); without it the command orders tables by foreign keys and refuses when the
  keys form a cycle.
- For `--source-dump`: `psql` on the machine, and an empty scratch database (see 5.2).
- Read access to the **source master key** and to the **target master key** (32 bytes: base64,
  64-character hex or a raw 32-character string). Keys are passed as a file path or as the name
  of an environment variable — never as a value on the command line.
- Free disk space for a full copy of the storage directory and for the backup (section 3).

Every command below uses placeholders. Keep real URLs and keys in files with mode `0600` or in
environment variables; the command redacts URLs and keys from its errors and its JSON output.

## 3. Prepare and back up (before anything is changed)

1. **Stop the writers.** Stop the Paperclip server and everything that writes to its database
   or storage (agents, schedulers). The migration reads a consistent snapshot, but anything
   written to the source afterwards is **not** carried over, and the run fails its verification
   if the source changed while it was running.
2. **Back up the source**, all three parts, to a place outside both hosts:
   - the database: `pg_dump --format=plain --no-owner --no-privileges "$SOURCE_DB_URL" > source.sql`
   - the storage directory (a copy that keeps file contents; symlinks are refused by the migration);
   - the master key file (or the value of the environment variable) and the instance
     configuration file. Without the key the secrets in the backup cannot be read.
3. **Create the target pieces**: an empty database (`CREATE DATABASE myrmidon_target;`), an empty
   storage directory (or none — the command creates it), a state directory outside the target
   directory, and a **new** target master key (32 random bytes, base64). The target key should
   differ from the source key; the migration re-encrypts every secret with it.
4. **Carry over the service settings** that are not in the database: for example the secrets
   provider and key location of the new installation, and `BETTER_AUTH_SECRET` /
   `AGENT_JWT_SECRET` if you want existing browser sessions and agent tokens to keep working.
   Point the new installation at the **target** master key.

## 4. Dry run (no writes)

```sh
paperclipai myrmidon:migrate --dry-run \
  --source-url-env SOURCE_DB_URL \
  --source-files /path/to/paperclip/storage \
  --source-key-file /secure/source-master.key \
  --target-url-env TARGET_DB_URL \
  --target-dir /path/to/myrmidon/storage \
  --target-key-file /secure/target-master.key \
  > dry-run.json
```

(`--source-dump ./source.sql --scratch-url-env SCRATCH_DB_URL` replaces `--source-url-env`; see 5.2.)

The dry run proves the source can be migrated and prints a complete JSON inventory. It writes
nothing to the source, the target database or the target directory. Check these fields:

- `source.chain`: `{ "expected": 278, "applied": 278, "matches": true }`. Anything else ends the
  run with `Unsupported source schema (<reason>)`.
- `inventory.tables[]`: every table with `rows` and a content `digest`; `secretCarrierColumns`
  lists the columns holding encrypted material.
- `inventory.secretCarriers`: the total number of encrypted values found, per table and column,
  and `externalProviderSecrets` — secrets whose values live in an external provider and are
  **not** re-encrypted.
- `inventory.files`: the file manifest (path, size, sha256), asset rows that point at files, and
  `problems` (missing or modified asset files). Problems stop the run unless you pass
  `--allow-missing-files`, which you should do only knowingly.
- `inventory.exclusions`: what is not transferred and why (the migration journal table,
  tables outside `public`, assets on a non-local provider).
- `target.state`: `fresh` for an untouched target.

The command stops with a message, and nothing is written, when: the source history is not the
supported chain; the source key does not decrypt every encrypted value; an encrypted value sits
in a plain text column (it cannot be re-encrypted safely); asset files are missing; the target
database or directory is not empty and was not created by an earlier run of this tool.

## 5. Migrate

### 5.1 From a database URL

```sh
paperclipai myrmidon:migrate \
  --source-url-env SOURCE_DB_URL \
  --source-files /path/to/paperclip/storage \
  --source-key-file /secure/source-master.key \
  --target-url-env TARGET_DB_URL \
  --target-dir /path/to/myrmidon/storage \
  --target-key-file /secure/target-master.key \
  --state-dir /path/to/migration-state \
  > migrate.json
```

### 5.2 From a pg_dump file

Take the dump in plain format without owners and privileges (`pg_dump --format=plain --no-owner
--no-privileges`). Custom-format archives are refused. The command restores the dump with `psql`
into an **empty scratch database** that you provide, reads the source from there, and leaves
the scratch database in place for you to drop:

```sh
paperclipai myrmidon:migrate --source-dump ./source.sql --scratch-url-env SCRATCH_DB_URL \
  --source-files ... --source-key-file ... --target-url-env ... --target-dir ... \
  --target-key-file ... --state-dir ...
```

The restore tool receives the scratch URL as an argument, so use a throwaway database and
credentials that expire with it.

### 5.3 What happens

The phases are written to the journal in `--state-dir` (together with a lock and, at the end,
`report.json`):

1. **Checks** — keys, source chain, inventory, target emptiness (no target write yet).
2. **schema** — the target database receives the Myrmidon migrations; the target chain must
   contain the vendor chain as its exact prefix.
3. **data** — all rows are copied in **one transaction**, in foreign-key order, with encrypted
   values re-encrypted on the way; sequences are re-aligned and foreign keys re-checked. Either
   everything lands or nothing does. Indexes already exist from the schema phase: the load is a
   plain bulk insert, not an index-less load.
4. **files** — the intent (file list, new directories) is journaled first, then every file is
   copied through a temporary name and verified by sha256. An existing file with different
   content is never overwritten.
5. **verify** — see section 6; the run is `complete` only if verification passes.

If a run is interrupted or fails, the journal says `failed` and the phase reached. **Run the
same command again**: finished phases are skipped, an interrupted file copy continues, and a
data load that was committed just before the interruption is recognised by content and not
repeated. Nothing is duplicated. Run it again after success and it reports `already-migrated`
without writing.

A different source (or a changed source) against a started target is refused: roll back first.

## 6. Verify

The command's own verification (`verification` in the output) states facts, not "no errors":

- `countsAndContentMatch` and `tables[]`: per-table row counts and content digests, source against target;
- `foreignKeyViolations`: empty;
- `secrets`: `decryptWithTargetKey` true, `plaintextParity` true (every decrypted target secret
  equals the source secret, compared by hash), `oldKeyRejected` true (the source key does not open
  the target; `null` means both keys are equal);
- `filesVerified` and `fileProblems`: every manifest file re-hashed in the target;
- `sourceUnchanged`: the source snapshot digest, taken again after the run, equals the first.

A passing comparison of counts alone is not a guarantee that nothing was lost: it covers the
transferred tables and files, not data outside them (see section 1).

Then check in the application, with the new installation started on the **target** database,
directory and key:

1. Sign in with an existing user.
2. Open a company, then an issue with comments and an attached document or file, and open the file.
3. Open an agent and its configuration; resolve one secret (a run that uses it, or the secrets screen).
4. Start one agent run and watch it finish.

Do not point agents or integrations at the new installation before these checks pass.

## 7. Cut over, and the limits of going back

Keep the old installation stopped, not deleted, until you accept the new one. From the moment
users and agents **write to the target**, the source no longer holds those changes. A rollback
after that point loses them; there is no automatic merge back.

There are two different things people call "rollback":

- **Undo the migration** (`--rollback`, below): empties what the command created in the target.
  Use it before cutover — if verification fails or you want to start over.
- **Return to the old installation**: start the old Paperclip against the old database, storage
  and key (the originals, or the restored backup from section 3). A **new image alone** does not
  bring data back: restoring the backup is what restores state. After cutover this returns the
  state at backup time, without anything written to Myrmidon since.

External services keep pointing where you pointed them: bots, webhooks, OAuth redirect URLs and
external secret providers must be switched (and switched back) by you.

## 8. Roll back the migration

```sh
paperclipai myrmidon:migrate --rollback \
  --target-url-env TARGET_DB_URL --target-dir /path/to/myrmidon/storage \
  --state-dir /path/to/migration-state
```

It requires the journal of the run and the same target database (checked by its identity). It
drops the tables, types, functions and views that were absent before the run (extensions and
objects that existed before are left), the migration schema, and removes the files and
directories the run added — a file whose content has since changed is kept and reported in
`filesKeptBecauseChanged`. The source is never touched. Afterwards the journal says
`rolled-back` and the same target can be used for a new run.

`--rollback` is not a backup restore: if anyone wrote to the target after the migration, the
rollback removes that data too.

## 9. Reference

Flags (`paperclipai myrmidon:migrate --help`):

| Flag | Meaning |
|---|---|
| `--source-url <url>` / `--source-url-env <name>` | Source database (use the env form to keep the URL out of the process list). |
| `--source-dump <path>` + `--scratch-url` / `--scratch-url-env` | Plain pg_dump file, restored into an empty scratch database. |
| `--source-files <dir>` | Source storage directory. Required when the database has `local_disk` assets. |
| `--source-key-file <path>` / `--source-key-env <name>` | Source master key. |
| `--target-url` / `--target-url-env` | Target database (empty, dedicated). |
| `--target-dir <dir>` | Target storage directory (empty or absent). Required when there are files. |
| `--target-key-file` / `--target-key-env` | Target master key. |
| `--state-dir <dir>` | Journal, lock and report; outside the target directory. Required unless `--dry-run`. |
| `--dry-run` | Inventory only. |
| `--rollback` | Undo what an earlier run created. |
| `--allow-missing-files` | Continue when asset files are missing or modified (reported). |

Output is always JSON on stdout (`--json` is accepted for compatibility); errors go to stderr with
a non-zero exit code. The top-level fields are `command`, `contractVersion` (1), `mode`
(`dry-run`, `migrate`, `rollback`), `status` (`ok`, `already-migrated`, `rolled-back`),
`writesPerformed`, `source`, `inventory`, `target`, and for a real run `phases`, `load` and
`verification`.

Known limits: one supported source release; a single run moves one instance; the load is one
transaction, so a very large database needs matching transaction headroom; columns that hold encrypted material are not
content-compared (they are verified by decrypting every value); data in tables outside
`public`, in external object stores and in external secret providers is not moved.
