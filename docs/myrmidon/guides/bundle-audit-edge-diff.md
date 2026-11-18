# Startup import edge diff

Run `scripts/myrmidon/bundle-audit/import-report-edge-diff.mjs` with two
JSON import reports: base first, current second. The command writes a JSON
diff to stdout with `entry`, `added`, and `removed` fields.

```sh
node scripts/myrmidon/bundle-audit/import-report-edge-diff.mjs base.json current.json
```

Exactly one of the two report arguments may be `-`. It reads that report from
standard input (file descriptor 0). For example, from the repository root:

```sh
# Base report from stdin
node scripts/myrmidon/bundle-audit/import-report-edge-diff.mjs - current.json < base.json

# Current report from stdin
node scripts/myrmidon/bundle-audit/import-report-edge-diff.mjs base.json - < current.json
```

A file literally named `-` must be addressed as `./-` (or another explicit
path), not `-`. Two `-` arguments are invalid: the command exits with status 1,
prints `invalid arguments` to stderr, and rejects them before reading stdin.
