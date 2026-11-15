# Offline boot contract audit

Run `node scripts/myrmidon/bundle-audit/boot-contract.mjs < manifest.json`.
The JSON object must contain an `argv` array and an `env` object of strings.
For example:

```json
{"argv":["node","server/dist/index.js"],"env":{"MYRMIDON_BUILD_VERSION":"1.7.0","MYRMIDON_BUILD_COMMIT":"abc123","NODE_OPTIONS":"--max-old-space-size=2048"}}
```

The audit reads only this manifest. It does not run the command, expand shell
syntax, read runtime files or change the environment. It requires exactly the
bare command and nonempty, known version and commit environment stamps. Legacy
`PAPERCLIP_BUILD_VERSION` and `PAPERCLIP_BUILD_COMMIT` are accepted when the
corresponding Myrmidon value is absent. It reports each detected violation to
stderr and exits nonzero; success exits zero and reports NODE_OPTIONS unchanged.
NODE_OPTIONS with unsupported backslash escaping or unclosed quotes is rejected
rather than guessed. The manifest must describe the effective runtime argv and
environment; this tool cannot verify their source or inspect a built image.

Test in CI with `node --test scripts/myrmidon/bundle-audit/boot-contract.test.mjs`.
