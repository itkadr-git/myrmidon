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
# Prepared artifact runtime audit

Run `node scripts/myrmidon/bundle-audit/artifact-audit.mjs <artifact-root>` against an already prepared workspace tree containing `pnpm-workspace.yaml`. The command is read-only and does not build or resolve imports.

It inspects workspace package manifests matched by that file and checks runtime `main`, `exports` (including conditional and nested wildcard targets), and `bin` entries. Type declarations and `types` conditions are not runtime entries. Missing files, source TypeScript targets, root escapes and dangling or escaping symlinks cause a nonzero exit; a successful audit prints `PASS`. Invalid or empty workspace discovery also fails closed.

This is a standalone tool, not a release pipeline step. Test with `node --test scripts/myrmidon/bundle-audit/artifact-audit.test.mjs`.
