# Environment variable names: MYRMIDON_* with the PAPERCLIP_* alias

> Русская версия: [env-names-alias.ru.md](env-names-alias.ru.md)

Since release 1.7 every environment variable the product reads is named
`MYRMIDON_<AREA>_<NAME>`. The previous `PAPERCLIP_<AREA>_<NAME>` spellings
keep working for one more release as aliases, so an installed system or an
agent skill that exports the old names does not break.

## How the alias works

- The product reads `MYRMIDON_*` first. When both `MYRMIDON_<NAME>` and
  `PAPERCLIP_<NAME>` are set, the new name wins.
- When only `PAPERCLIP_<NAME>` is set, its value is used and the log gets one
  deprecation warning per variable name, for example:

```
myrmidon: environment variable PAPERCLIP_LOG_LEVEL is a deprecated alias of MYRMIDON_LOG_LEVEL; The PAPERCLIP_* variable names are deprecated aliases for MYRMIDON_*; they will stop working in a future release. Rename them in your environment.
```

- The warning is emitted once per variable name per process, not on every read.
- An empty value counts as unset for both names (the dotenv convention).

Internal plumbing the product itself writes (run identity, workspace pointers,
API access for child processes) is set under both spellings during the alias
window, so child processes that still expect `PAPERCLIP_*` keep working. The
sanitizers that strip product variables from child environments strip both
spellings.

## Where the mapping lives

The full name-by-name mapping table is in
[SETTINGS.md](../SETTINGS.md), section
«Name mapping PAPERCLIP_* → MYRMIDON_*». Every variable the product reads is
listed there.

## Migrating an installation

1. Rename the variables in your environment (`.env` files, systemd units,
   container definitions): `PAPERCLIP_X=Y` becomes `MYRMIDON_X=Y`.
2. Restart the server. Nothing else changes: values, defaults and precedence
   within a variable are the same.
3. Watch the log for the deprecation warnings — every warning names a variable
   still set under the old name.
4. Remove the old names before the release that follows 1.7: the alias window
   is one release by design.
