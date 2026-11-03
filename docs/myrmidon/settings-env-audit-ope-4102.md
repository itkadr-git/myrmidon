# Audit of Environment Variables: server/src vs SETTINGS (OPE-4102)

## Reproducible Audit Command

```bash
git grep -Ioh -E '\b(MYRMIDON|PAPERCLIP)_[A-Z0-9_]+\b' origin/main -- server/src | sort -u
```

## Summary Statistics

### On origin/main
- **Total unique tokens in server/src**: 840
- **Runtime tokens (used in non-test source files)**: 594
- **Test-only tokens (used exclusively in tests)**: 246

### On PR Head
- **Total unique tokens in server/src**: 768
- **Runtime tokens (used in non-test source files)**: 549
- **Test-only tokens (used exclusively in tests)**: 219

## Scope & Target Variables (ia-v2 §10)

| Variable | Category | Status | Details |
| :--- | :--- | :--- | :--- |
| `MYRMIDON_MCP_TOKEN_*` | Secret | Documented in EN & RU | Dynamic token per bot profile from `MYRMIDON_BOT_MCP_SERVERS` |
| `MYRMIDON_BOT_CANARY_*` (8 vars) | Runtime Canary | Documented in EN & RU | Documented under bot container tracks (`SELECTOR`, `WAVE_SIZE`, `STEP_TIMEOUT_SEC`, `HEALTH_SETTLE_SEC`, `SMOKE_TIMEOUT_SEC`, `TICK_SEC`, `VERIFY_TIMEOUT_SEC`, `AUTO_ROLLBACK`). The upstream prefix artifact (`240i|`...`247i|`) in `SETTINGS.ru.md` was introduced in PR #472 (`1fe0139c5`); resolving it requires changes to `scripts/myrmidon/release/collect-fragments.mjs`, which is excluded from PR #1320 to maintain strict docs-only scope per reviewer instruction. |
| `PAPERCLIP_TEST_CAPTURE_PATH` | Test harness | Documented in EN & RU | Captures child process environment in local test runner; dev/test only |

## Classification Breakdown

1. **Target Variables (ia-v2 §10)**: Fully documented in `docs/myrmidon/changes/settings-docs-ope-4102.md` and folded without corruption or duplicates.
2. **Core Myrmidon Settings**: Documented under track headings in `docs/myrmidon/SETTINGS.md` and `SETTINGS.ru.md`.
3. **Vendor Defaults (`PAPERCLIP_*`)**: Explicitly excluded by `SETTINGS.md` convention ("Vendor PAPERCLIP_* variables remain as they are and are not described here, except where we change their meaning or default value").
4. **Test-Only Tokens**: Variables used exclusively in mock harnesses, fixtures, and unit/integration test suites.
