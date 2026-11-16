# Static import budget

Run from the repository root with Node.js; no installation or network access is
required:

```sh
node scripts/myrmidon/bundle-audit/import-budget.mjs path/to/entry.js > report.json
```

Pass exactly one entry path. The CLI writes formatted JSON to stdout and errors
to stderr; a missing entry or invalid argument count exits nonzero. It reads
source as text and does not import or execute the analyzed JavaScript. To run
its synthetic tests in CI:

```sh
node --test scripts/myrmidon/bundle-audit/import-budget.test.mjs
```

## Report

Paths in the report are relative to the entry's directory, with `/` separators;
paths outside that directory can start with `../`. Output is deterministically
sorted for the same files and Node.js built-in module list.

- `entry`: entry file path.
- `modules`: discovered files, each with `path`, raw file `bytes`, and `eager`
  (reachable from the entry using only eager edges). This includes files found
  through lazy edges, which may not be eagerly reachable.
- `edges`: unique `{from, specifier, kind, to}` records. `kind` is `eager` for
  static imports, re-exports and literal `require`; literal dynamic `import()`
  is `lazy`. A null `to` denotes an unresolved dependency.
- `unknown`: unresolved edges, including bare external packages and missing
  local files. These are not included in module or byte totals.
- `counts`: number of discovered `modules`, `eagerModules`, and unique `edges`.
- `bytes`: `total` bytes across discovered files and `eager` bytes across the
  eager subset. `heaviestEager` lists up to ten eager module records, sorted by
  descending bytes and then path.

## Resolution and limitations

Relative and absolute specifiers are resolved from the importing file. The CLI
tries the exact path, then, only when it has no extension, `.js`, `.mjs`,
`.cjs`, `/index.js`, `/index.mjs`, and `/index.cjs`, in that order. Bare
packages are not resolved, even if installed. Node built-ins, including
`node:` forms listed by the running Node version, are excluded from the graph.
No package exports, package metadata, or bundler aliases are resolved.

The scanner is a lightweight tokenizer, not a full JavaScript parser. It scans
literal specifiers only; computed or non-literal dependencies are ignored, and
unusual syntax or lexical contexts can produce incomplete or inaccurate edges.
It does not infer runtime conditions, tree shaking, compression, execution
cost, or actual loading behavior. Unknowns and unrecognized syntax mean totals
can be incomplete. Byte counts are static source-file sizes, not a measured
startup improvement; use runtime measurements separately for performance claims.

# Offline boot contract audit

Run `node scripts/myrmidon/bundle-audit/boot-contract.mjs < manifest.json`.
The JSON object must contain an `argv` array and an `env` object of strings.
For example:

```json
{"argv":["node","server/dist/index.js"],"env":{"MYRMIDON_BUILD_VERSION":"1.7.0","MYRMIDON_BUILD_COMMIT":"abc123","NODE_OPTIONS":"--max-old-space-size=2048"}}
```

The audit reads only this manifest. It does not run the command, expand shell
syntax, read runtime files or change the environment. It requires exactly the
bare command and nonempty, known `MYRMIDON_BUILD_VERSION` and
`MYRMIDON_BUILD_COMMIT` environment stamps. A successful audit exits zero and
prints `PASS: boot contract; NODE_OPTIONS=` followed by any validated numeric
`--max-old-space-size=<number>` limits. It does not echo the original argv or
NODE_OPTIONS values.

On failure, the audit exits nonzero and prints `FAIL:` diagnostics to stderr.
Diagnostics identify the violation category or forbidden option name, not its
value. Loader, import and TypeScript runtime options are rejected. Unknown
NODE_OPTIONS are rejected rather than treated as safe; invalid memory limits,
unsupported backslash escaping and unclosed quotes also fail closed. Malformed
input or invocation produces a generic failure without echoing the input.

The manifest must describe the effective runtime argv and environment; this tool
cannot verify their source or inspect a built image.

Test in CI with `node --test scripts/myrmidon/bundle-audit/boot-contract.test.mjs`.

