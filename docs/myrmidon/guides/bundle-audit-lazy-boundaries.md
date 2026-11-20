# Lazy boundaries report

The lazy boundaries CLI reads an import report and outputs a JSON object with
its entry and the lazy edges from eagerly reachable modules to non-eager
modules. Each boundary includes the source, specifier, target and target byte
count. Output is sorted by source, specifier and target.

```sh
node scripts/myrmidon/bundle-audit/import-report-lazy-boundaries.mjs report.json
```

Pass the exact argument `-` to read the report from standard input (file
descriptor 0), for example:

```sh
node scripts/myrmidon/bundle-audit/import-report-lazy-boundaries.mjs - < report.json
```

Only the exact token `-` selects standard input. Use `./-` to read a file
literally named `-` in the current directory. Other arguments are file paths.

The CLI requires exactly one argument. On failure it exits with status 1,
writes nothing to stdout and writes one of the following categories followed
by a newline to stderr:

- `argv`: incorrect argument count; checked before reading the input.
- `file`: the report file or standard input could not be read.
- `json`: the input is not a single valid JSON document.
- `shape`: the report or its fields have an invalid shape.
- `graph`: the report describes an inconsistent graph.

The error protocol is the same for standard input and file input.
