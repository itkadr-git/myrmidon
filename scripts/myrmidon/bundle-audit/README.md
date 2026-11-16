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

---

# Startup benchmark comparison

Compare two JSON outputs from `measure-board-start.mjs --json` offline:

```
node scripts/myrmidon/bundle-audit/compare-bench.mjs baseline.json candidate.json
```

Each input must contain the recorded `cmd`, `envKeys`, and at least four ordered runs: one cold run followed by at least three warm runs. The report recalculates warm min, median, and max from the run values, not the input summary. The ratio is baseline warm median divided by candidate warm median. Exit 0 means ratio >= 2; exit 1 means the ratio is below 2; exit 2 means invalid input or usage.

Different commands or environment key sets require `--override-reason "reason"`. The reason and differing fields appear in the report. The input does not record environment values or all machine conditions, so matching keys alone cannot prove equivalent environments. A PASS establishes only the observed median ratio, not that the measurements were controlled. Use synthetic or explicitly authorized measurements; this command does not run a server or contact a network.

Test with `node --test scripts/myrmidon/bundle-audit/compare-bench.test.mjs`.
