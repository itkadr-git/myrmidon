# Startup import report: weak components

This standalone diagnostic groups modules in a startup import report into weakly
connected components: edges connect their endpoints regardless of direction. It
is not a strongly connected components (SCC) report and does not integrate with
application startup.

## Run

With Node.js 24, invoke the script by its absolute path from any working
directory. It reads one JSON report from standard input through EOF:

```sh
node /absolute/path/scripts/myrmidon/bundle-audit/import-report-weak-components.mjs eager < report.json
```

Use exactly one mode, `eager` or `all`. The `eager` mode uses only edges whose
`kind` is `eager`; `all` uses both `eager` and `lazy` edges. The module `eager`
flag is validated but does not filter modules.

## Input and output

The input is a JSON object with:

- `entry`: a nonempty string identifying a module in `modules`.
- `modules`: a nonempty array of objects with a unique nonempty string `path`,
  a nonnegative safe integer `bytes`, and a boolean `eager`.
- `edges`: an array of objects with nonempty string `from`, string `specifier`,
  `kind` equal to `eager` or `lazy`, and `to` equal to a nonempty module path
  or `null`. Non-null endpoints must exist in `modules`; exact duplicate
  `(from, specifier, kind, to)` tuples are invalid.

On success, stdout contains one JSON object and a newline:
`{entry, components: [{id, paths, bytes}]}`. Each component contains all its
module paths exactly once, including isolated modules. A null destination creates
no vertex or connection. Paths are sorted by JavaScript code-unit order; `id`
is the first path, and components are ordered by `id` using the same order.
`bytes` sums the module sizes once per component; a sum exceeding
`Number.MAX_SAFE_INTEGER` is rejected.

For example, in `eager` mode the input

```json
{"entry":"a","modules":[{"path":"a","bytes":2,"eager":true},{"path":"b","bytes":3,"eager":false},{"path":"c","bytes":4,"eager":false}],"edges":[{"from":"b","specifier":"a","kind":"eager","to":"a"},{"from":"b","specifier":"c","kind":"lazy","to":"c"}]}
```

produces

```json
{"entry":"a","components":[{"id":"a","paths":["a","b"],"bytes":5},{"id":"c","paths":["c"],"bytes":4}]}
```

With `all`, the lazy edge joins the components, producing
`{"entry":"a","components":[{"id":"a","paths":["a","b","c"],"bytes":9}]}`.

## Errors

Success exits 0 with empty stderr. Errors exit 1 with empty stdout and exactly
one category followed by a newline on stderr; input values and stack traces are
not printed:

- `argv`: missing, unknown, or extra arguments.
- `json`: malformed JSON input.
- `shape`: invalid report or field shape, including invalid module byte values.
- `graph`: missing entry or edge endpoint, duplicate module path or exact edge,
  or component byte sum overflow.
