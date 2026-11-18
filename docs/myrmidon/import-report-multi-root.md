# Multi-root import footprint report

Use this offline diagnostic to compare the static eager import footprint of
multiple entry modules in an existing import report:

```sh
node scripts/myrmidon/bundle-audit/import-report-multi-root.mjs <root> [root...] < report.json
```

Provide the JSON report on standard input. Each root must be a distinct,
existing `modules[].path`. The report must have an existing `entry`, a nonempty
`modules` array, and an `edges` array. Modules require a nonempty `path`, a
nonnegative safe-integer `bytes`, and a boolean `eager`. Edges require an
existing `from`, a string `specifier`, `kind` of `eager` or `lazy`, and a `to`
that is either null or an existing module path. Duplicate module paths and
duplicate edges are rejected.

The command writes one JSON object to standard output:

- `roots`: requested roots, sorted in code-unit order.
- `paths` and `bytes`: union of the roots' eager closures and its total bytes;
  each module is counted once.
- `perRoot`: independent `{root, paths, bytes}` closure and byte count for each
  root, sorted by root in code-unit order.
- `sharedPaths` and `sharedBytes`: modules reachable from at least two distinct
  roots and their combined bytes, not necessarily shared by every root.

All path arrays are sorted in code-unit order. Traversal follows only internal
`eager` edges; `lazy` edges and edges with a null destination are excluded.
Cycles terminate, and `modules[].eager` describes the original entry rather than
filtering the new roots' closures.

Errors exit with status 1, leave standard output empty, and write a category to
standard error: `argv` for missing, empty, or duplicate root arguments; `json`
for unreadable or malformed JSON; `shape` for invalid report fields; `graph`
for invalid references, duplicates, or unsafe aggregate byte counts. Errors do
not print the input. The command does not execute source modules, access a
database, or use the network.

These are static byte totals, not measurements or promises of startup speed.
