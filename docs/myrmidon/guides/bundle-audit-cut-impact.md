# Bundle audit cut impact

Run `node scripts/myrmidon/bundle-audit/import-report-cut-impact.mjs <module-path>`
with a JSON import report on standard input. The report must contain an `entry`,
a nonempty `modules` array, and an `edges` array. On success the command writes
one JSON line to stdout with the entry, removed module, eagerly reachable lost
paths, and their total bytes.

An empty `modules` array is an invalid report shape. For example, with a valid
module-path argument and input `{"entry":"entry","modules":[],"edges":[]}`,
the CLI exits 1, writes nothing to stdout, and writes exactly `shape\n` to
stderr. This is a shape error rather than a graph error.
